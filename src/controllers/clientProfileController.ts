import mongoose from "mongoose";
import asyncHandler from "express-async-handler";
import { Request, Response } from "express";
import { ClientProfile, IClientProfile } from "../models/clientProfileModel";
import { Subscription } from "../models/subscriptionModel";
import { IUser } from "../models/userModel";
import { PROFILE_STATUS } from "../constants/profileStatus";
import { IMediaFile, toPublicMediaFile } from "../models/mediaFile";
import { getAccountAvatar } from "../helpers/profileAvatarFallback";
import {
  uploadHandler,
  deleteStoredFile,
  FILE_VISIBILITY,
  IMAGE_ONLY_MIME_TYPES,
  countUploadCandidates,
} from "../helpers/fileStorage";

export const toPublicClientProfile = (profile: IClientProfile, fallbackAvatar?: IMediaFile) => ({
  id: profile.id,
  userId: profile.userId,
  isVerified: profile.isVerified,
  status: profile.status,
  avatar: profile.avatar ? toPublicMediaFile(profile.avatar) : fallbackAvatar ? toPublicMediaFile(fallbackAvatar) : undefined,
  displayName: profile.displayName,
  bio: profile.bio,
  country: profile.country,
  city: profile.city,
  ratingAverage: profile.ratingAverage,
  ratingCount: profile.ratingCount,
  createdAt: profile.createdAt,
});

// Posting (a TenderProject or a SiteForce JobOpening) requires a
// verified, currently-subscribed, and active ClientProfile — same rule,
// same reasoning, as every other PROFILE_MODEL_REGISTRY entry (see
// loadEligibleContractorProfile/loadEligibleLaborProfile). A worker or
// contractor is about to travel to an address this poster controls;
// an unverified poster is exactly the safety gap verification exists
// to close, not just a courtesy extended to the party being invited
// in. `status` (constants/profileStatus.ts) keeps a poster who's taking
// a break, or one an admin has banned, from posting either. Shared by
// tenderProjectController and jobOpeningController so both pillars gate
// posting identically.
export const loadEligibleClientProfile = async (
  userId: mongoose.Types.ObjectId | string,
): Promise<IClientProfile | null> => {
  const profile = await ClientProfile.findOne({ userId });
  if (!profile?.isVerified || profile.status !== PROFILE_STATUS.ACTIVE) return null;

  const subscription = profile.currentSubscription
    ? await Subscription.findById(profile.currentSubscription)
    : null;

  return subscription?.isActive() ? profile : null;
};

// @desc    Create my client (poster) profile
// @route   POST /api/client-profiles
// @access  Private — one per user
export const createClientProfile = asyncHandler(async (req: Request, res: Response) => {
  const requester = req.user as IUser;

  const existing = await ClientProfile.findOne({ userId: requester._id });
  if (existing) {
    res.status(400);
    throw new Error("You already have a client profile");
  }

  const { displayName, bio, country, city } = req.body;

  const profile = await ClientProfile.create({
    userId: requester._id,
    currentSubscription: requester.currentSubscription,
    displayName,
    bio,
    country,
    city,
  });

  res.status(201).json(toPublicClientProfile(profile));
});

// @desc    Get my own client profile
// @route   GET /api/client-profiles/me
// @access  Private
export const getMyClientProfile = asyncHandler(async (req: Request, res: Response) => {
  const profile = await ClientProfile.findOne({ userId: (req.user as IUser)._id });

  if (!profile) {
    res.status(404);
    throw new Error("You don't have a client profile yet");
  }

  const fallbackAvatar = profile.avatar ? undefined : await getAccountAvatar(profile.userId);
  res.status(200).json(toPublicClientProfile(profile, fallbackAvatar));
});

// @desc    Replace my profile's own avatar — optional; the profile page
//          falls back to the account avatar until one is set here.
// @route   POST /api/client-profiles/me/avatar
// @access  Private
export const uploadAvatar = asyncHandler(async (req: Request, res: Response) => {
  const profile = await ClientProfile.findOne({ userId: (req.user as IUser)._id });

  if (!profile) {
    res.status(404);
    throw new Error("You don't have a client profile yet");
  }

  if (countUploadCandidates(req) !== 1) {
    res.status(400);
    throw new Error("Attach exactly one avatar image");
  }

  const { results, errorLogs } = await uploadHandler({
    req,
    visibility: FILE_VISIBILITY.PUBLIC,
    allowedMimeTypes: IMAGE_ONLY_MIME_TYPES,
  });
  const saved = results[0];

  if (!saved) {
    res.status(400);
    throw new Error(errorLogs[0] || "No valid image provided");
  }

  const oldAvatar = profile.avatar;

  profile.avatar = {
    fileName: saved.fileName,
    storagePath: saved.storagePath,
    mime: saved.mime,
    size: saved.size,
    url: saved.url,
  };
  await profile.save();

  if (oldAvatar) {
    await deleteStoredFile(oldAvatar.storagePath);
  }

  res.status(200).json(toPublicClientProfile(profile));
});

// @desc    Update my client profile
// @route   PATCH /api/client-profiles/me
// @access  Private
export const updateMyClientProfile = asyncHandler(async (req: Request, res: Response) => {
  const profile = await ClientProfile.findOne({ userId: (req.user as IUser)._id });

  if (!profile) {
    res.status(404);
    throw new Error("You don't have a client profile yet");
  }

  if (profile.status === PROFILE_STATUS.BANNED) {
    res.status(403);
    throw new Error("This profile has been banned — contact support");
  }

  const { displayName, bio, country, city, status } = req.body;

  if (displayName) profile.displayName = displayName;
  if (bio !== undefined) profile.bio = bio;
  if (country) profile.country = country;
  if (city !== undefined) profile.city = city;
  // `status` here is validated (updateMyClientProfileSchema) to only
  // ever be 'active'/'inactive' — self-service never reaches 'banned',
  // same as every other pillar profile's own update endpoint. Only the
  // generic admin endpoint (adminProfileController.setProfileStatus)
  // can ever set 'banned'.
  if (status !== undefined) profile.status = status;

  await profile.save();

  res.status(200).json(toPublicClientProfile(profile));
});

// @desc    View a poster's reputation — deliberately never gated behind
//          their own subscription/verification status, unlike a provider
//          profile. A poster isn't "discoverable" content being paywalled;
//          the whole point of this route is letting a worker/contractor
//          check someone's track record before engaging with them, which
//          should work regardless of whether the poster is currently
//          subscribed. A banned poster is the one exception — that's a
//          moderation action, not a subscription lapse, and hides the
//          profile the same {available: false} way an unsubscribed
//          provider profile already does. An inactive (on-a-break)
//          poster's page stays visible, same reasoning.
// @route   GET /api/client-profiles/:id
// @access  Public
export const getClientProfile = asyncHandler(async (req: Request, res: Response) => {
  const id = req.params.id as string;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    res.status(404);
    throw new Error("Profile not found");
  }

  const profile = await ClientProfile.findById(id);
  if (!profile) {
    res.status(404);
    throw new Error("Profile not found");
  }

  if (profile.status === PROFILE_STATUS.BANNED) {
    res.status(200).json({ available: false, message: "This profile is not currently available." });
    return;
  }

  const fallbackAvatar = profile.avatar ? undefined : await getAccountAvatar(profile.userId);
  res.status(200).json(toPublicClientProfile(profile, fallbackAvatar));
});
