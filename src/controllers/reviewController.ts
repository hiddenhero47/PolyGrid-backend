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

const toPublicReview = (review: IReview) => ({
  id: review.id,
  profileType: review.profileType,
  profileId: review.profileId,
  reviewer: review.reviewer,
  rating: review.rating,
  comment: review.comment,
  createdAt: review.createdAt,
});

// @desc    Review a profile — only ever reachable from a real, completed
//          transaction with it (a Job or a successful DigitalPurchase),
//          never by naming a profile directly. The target profile is
//          resolved from the source itself (see
//          constants/profileTypes.findProfileByUserId), so there's no
//          profileId in the request body to spoof.
// @route   POST /api/reviews
// @access  Private
export const createReview = asyncHandler(async (req: Request, res: Response) => {
  const requester = req.user as IUser;
  const { sourceType, sourceId, rating, comment } = req.body;

  if (!sourceType || !Object.values(REVIEW_SOURCE_TYPE).includes(sourceType)) {
    res.status(400);
    throw new Error("sourceType must be 'Job' or 'DigitalPurchase'");
  }

  if (!sourceId || !mongoose.Types.ObjectId.isValid(sourceId)) {
    res.status(400);
    throw new Error("A valid sourceId is required");
  }

  if (!rating || rating < 1 || rating > 5) {
    res.status(400);
    throw new Error("rating must be between 1 and 5");
  }

  let profileType: ProfileType;
  let profileId: mongoose.Types.ObjectId;

  if ((sourceType as ReviewSourceType) === REVIEW_SOURCE_TYPE.JOB) {
    const job = await Job.findById(sourceId);

    if (!job) {
      res.status(404);
      throw new Error("Job not found");
    }

    if (job.client.userId.toString() !== requester.id) {
      res.status(403);
      throw new Error("Only the job's client can leave a review for it");
    }

    if (job.status !== JOB_STATUS.COMPLETED) {
      res.status(400);
      throw new Error("You can only review a completed job");
    }

    const resolved = await findProfileByUserId(job.provider.userId);

    if (!resolved) {
      res.status(404);
      throw new Error("No business profile found to review for this job");
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

  const existing = await Review.findOne({ sourceType, sourceId });
  if (existing) {
    res.status(400);
    throw new Error("This transaction has already been reviewed");
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

  const filter = { profileType, profileId };

  const [reviews, total] = await Promise.all([
    Review.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).populate("reviewer", "fullName"),
    Review.countDocuments(filter),
  ]);

  res.status(200).json({
    data: reviews.map(toPublicReview),
    pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
  });
});
