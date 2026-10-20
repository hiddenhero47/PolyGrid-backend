import mongoose from "mongoose";
import asyncHandler from "express-async-handler";
import { Request, Response } from "express";
import { Review, IReview, REVIEW_SOURCE_TYPE, ReviewSourceType } from "../models/reviewModel";
import { Job, JOB_STATUS } from "../models/jobModel";
import { DigitalPurchase, DIGITAL_PURCHASE_STATUS } from "../models/digitalPurchaseModel";
import { IUser } from "../models/userModel";
import {
  PROFILE_MODEL_REGISTRY,
  PROFILE_TYPE,
  ProfileType,
  isKnownProfileType,
  findProfileByUserId,
} from "../constants/profileTypes";

// Shared by every profile model — all of them carry the exact same two
// running-total fields (see each model's own comment). A straight average
// recomputed from `rating`/`ratingCount` rather than a weighted-sum field,
// since ratingCount is already the weight.
export const applyReviewToProfile = async (
  profileType: ProfileType,
  profileId: mongoose.Types.ObjectId,
  rating: number,
): Promise<void> => {
  const Model = PROFILE_MODEL_REGISTRY[profileType];
  const profile = await Model.findById(profileId).select("ratingAverage ratingCount");
  if (!profile) return;

  const newCount = profile.ratingCount + 1;
  const newAverage = (profile.ratingAverage * profile.ratingCount + rating) / newCount;

  await Model.updateOne({ _id: profileId }, { ratingAverage: newAverage, ratingCount: newCount });
};

// The exact inverse of applyReviewToProfile above — used when a review is
// hidden or hard-deleted, so a profile's visible rating never includes a
// review nobody can see. `newCount` can't go below 0 (a profile's own
// ratingCount is always what actually backs this, so it never should),
// and an empty profile's average resets to 0 rather than leaving a stale
// number no rating actually supports.
export const reverseReviewFromProfile = async (
  profileType: ProfileType,
  profileId: mongoose.Types.ObjectId,
  rating: number,
): Promise<void> => {
  const Model = PROFILE_MODEL_REGISTRY[profileType];
  const profile = await Model.findById(profileId).select("ratingAverage ratingCount");
  if (!profile) return;

  const newCount = Math.max(profile.ratingCount - 1, 0);
  const newAverage = newCount > 0 ? (profile.ratingAverage * profile.ratingCount - rating) / newCount : 0;

  await Model.updateOne({ _id: profileId }, { ratingAverage: newAverage, ratingCount: newCount });
};

const toPublicReview = (review: IReview) => ({
  id: review.id,
  profileType: review.profileType,
  profileId: review.profileId,
  reviewer: review.reviewer,
  rating: review.rating,
  comment: review.comment,
  createdAt: review.createdAt,
});

// Only ever returned from the moderation-queue/hide/unhide endpoints —
// the extra fields are moderation detail with no business being on the
// public GET /api/reviews response.
const toAdminReview = (review: IReview) => ({
  ...toPublicReview(review),
  isHidden: review.isHidden,
  hiddenBy: review.hiddenBy,
  hiddenReason: review.hiddenReason,
  hiddenAt: review.hiddenAt,
});

// @desc    Review a profile — only ever reachable from a real, completed
//          transaction with it (a Job or a successful DigitalPurchase),
//          never by naming a profile directly. The target profile is
//          resolved from the source itself (see
//          constants/profileTypes.findProfileByUserId), so there's no
//          profileId in the request body to spoof.
//
//          A Job-sourced review is two-way: the client can review the
//          provider's profile, *or* the provider can review the client's
//          — whichever one the requester actually is. This matters most
//          for PolyGrid Tenders/SiteForce, where the "client" is a
//          ClientProfile (a real poster a worker/contractor can rate),
//          but it costs nothing to leave on generically everywhere else:
//          an ordinary Direct Hire client has no ClientProfile, so
//          findProfileByUserId just returns null and that direction
//          404s cleanly — nothing breaks, two-way reviews just don't
//          exist where there's no profile to point them at.
// @route   POST /api/reviews
// @access  Private
export const createReview = asyncHandler(async (req: Request, res: Response) => {
  const requester = req.user as IUser;
  const { sourceType, sourceId, rating, comment } = req.body;

  let profileType: ProfileType;
  let profileId: mongoose.Types.ObjectId;

  if ((sourceType as ReviewSourceType) === REVIEW_SOURCE_TYPE.JOB) {
    const job = await Job.findById(sourceId);

    if (!job) {
      res.status(404);
      throw new Error("Job not found");
    }

    if (job.status !== JOB_STATUS.COMPLETED) {
      res.status(400);
      throw new Error("You can only review a completed job");
    }

    let targetUserId: mongoose.Types.ObjectId;

    if (job.client.userId.toString() === requester.id) {
      targetUserId = job.provider.userId;
    } else if (job.provider.userId.toString() === requester.id) {
      targetUserId = job.client.userId;
    } else {
      res.status(403);
      throw new Error("You weren't a party to this job");
    }

    const resolved = await findProfileByUserId(targetUserId);

    if (!resolved) {
      res.status(404);
      throw new Error("The other party on this job has no reviewable profile");
    }

    profileType = resolved.profileType;
    profileId = resolved.profileId;
  } else {
    const purchase = await DigitalPurchase.findById(sourceId);

    if (!purchase) {
      res.status(404);
      throw new Error("Purchase not found");
    }

    if (purchase.buyer.toString() !== requester.id) {
      res.status(403);
      throw new Error("Only the buyer can leave a review for this purchase");
    }

    if (purchase.status !== DIGITAL_PURCHASE_STATUS.SUCCESS) {
      res.status(400);
      throw new Error("You can only review a successful purchase");
    }

    // DigitalPurchase already stores the DigitalCreatorProfile id
    // directly — no userId lookup needed, unlike the Job case above.
    profileType = PROFILE_TYPE.DIGITAL_CREATOR;
    profileId = purchase.creator;
  }

  const existing = await Review.findOne({ sourceType, sourceId, reviewer: requester._id });
  if (existing) {
    res.status(400);
    throw new Error("You've already reviewed this transaction");
  }

  const review = await Review.create({
    profileType,
    profileId,
    reviewer: requester._id,
    rating,
    comment,
    sourceType,
    sourceId,
  });

  await applyReviewToProfile(profileType, profileId, rating);

  res.status(201).json(toPublicReview(review));
});

// @desc    A profile's reviews, newest first
// @route   GET /api/reviews?profileType=&profileId=
// @access  Public
export const getProfileReviews = asyncHandler(async (req: Request, res: Response) => {
  const { profileType, profileId } = req.query as { profileType?: string; profileId?: string };

  if (!profileType || !isKnownProfileType(profileType)) {
    res.status(400);
    throw new Error("A valid profileType is required");
  }

  if (!profileId || !mongoose.Types.ObjectId.isValid(profileId)) {
    res.status(400);
    throw new Error("A valid profileId is required");
  }

  const page = Math.max(Number(req.query.page) || 1, 1);
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  const skip = (page - 1) * limit;

  // Hidden reviews never show up in the public listing — see
  // reviewModel.ts's IReview.isHidden comment. `$ne: true` rather than
  // `false` so reviews created before this field existed (isHidden
  // undefined) still show up.
  const filter = { profileType, profileId, isHidden: { $ne: true } };

  const [reviews, total] = await Promise.all([
    Review.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).populate("reviewer", "fullName"),
    Review.countDocuments(filter),
  ]);

  res.status(200).json({
    data: reviews.map(toPublicReview),
    pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
  });
});

// @desc    A profile's reviews for moderation — same listing as
//          getProfileReviews above, except hidden reviews are included
//          (with their moderation detail) so an admin can find something
//          to unhide.
// @route   GET /api/reviews/moderation?profileType=&profileId=
// @access  Private (Admin / Super Admin / Customer Care — read-only)
export const getReviewsForModeration = asyncHandler(async (req: Request, res: Response) => {
  const { profileType, profileId } = req.query as { profileType?: string; profileId?: string };

  if (!profileType || !isKnownProfileType(profileType)) {
    res.status(400);
    throw new Error("A valid profileType is required");
  }

  if (!profileId || !mongoose.Types.ObjectId.isValid(profileId)) {
    res.status(400);
    throw new Error("A valid profileId is required");
  }

  const page = Math.max(Number(req.query.page) || 1, 1);
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  const skip = (page - 1) * limit;

  const filter = { profileType, profileId };

  const [reviews, total] = await Promise.all([
    Review.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).populate("reviewer", "fullName"),
    Review.countDocuments(filter),
  ]);

  res.status(200).json({
    data: reviews.map(toAdminReview),
    pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
  });
});

// @desc    Soft-hide a review — reverses its rating off the profile and
//          drops it from the public listing, but keeps the record (unlike
//          deleteReview below) so it can be unhidden later.
// @route   PATCH /api/reviews/:id/hide
// @access  Private (Admin / Super Admin only)
export const hideReview = asyncHandler(async (req: Request, res: Response) => {
  const requester = req.user as IUser;
  const review = await Review.findById(req.params.id);

  if (!review) {
    res.status(404);
    throw new Error("Review not found");
  }

  if (review.isHidden) {
    res.status(400);
    throw new Error("This review is already hidden");
  }

  await reverseReviewFromProfile(review.profileType as ProfileType, review.profileId, review.rating);

  review.isHidden = true;
  review.hiddenBy = requester._id as mongoose.Types.ObjectId;
  review.hiddenReason = req.body.reason;
  review.hiddenAt = new Date();
  await review.save();

  res.status(200).json(toAdminReview(review));
});

// @desc    Reverse a hide — restores the review to the public listing and
//          reapplies its rating to the profile.
// @route   PATCH /api/reviews/:id/unhide
// @access  Private (Admin / Super Admin only)
export const unhideReview = asyncHandler(async (req: Request, res: Response) => {
  const review = await Review.findById(req.params.id);

  if (!review) {
    res.status(404);
    throw new Error("Review not found");
  }

  if (!review.isHidden) {
    res.status(400);
    throw new Error("This review is not hidden");
  }

  await applyReviewToProfile(review.profileType as ProfileType, review.profileId, review.rating);

  review.isHidden = false;
  review.hiddenBy = undefined;
  review.hiddenReason = undefined;
  review.hiddenAt = undefined;
  await review.save();

  res.status(200).json(toAdminReview(review));
});

// @desc    Permanently delete a review — unlike hideReview, there's
//          nothing left to unhide afterward. Only reverses the rating if
//          it wasn't already hidden (hiding already reversed it once;
//          reversing twice would double-count).
// @route   DELETE /api/reviews/:id
// @access  Private (Admin / Super Admin only)
export const deleteReview = asyncHandler(async (req: Request, res: Response) => {
  const review = await Review.findById(req.params.id);

  if (!review) {
    res.status(404);
    throw new Error("Review not found");
  }

  if (!review.isHidden) {
    await reverseReviewFromProfile(review.profileType as ProfileType, review.profileId, review.rating);
  }

  await review.deleteOne();

  res.status(200).json({ message: "Review permanently deleted" });
});
