import mongoose from "mongoose";
import asyncHandler from "express-async-handler";
import { Request, Response } from "express";
import { ClientProfile, IClientProfile } from "../models/clientProfileModel";
import { Subscription } from "../models/subscriptionModel";
import { IUser } from "../models/userModel";

export const toPublicClientProfile = (profile: IClientProfile) => ({
  id: profile.id,
  userId: profile.userId,
  isVerified: profile.isVerified,
  displayName: profile.displayName,
  bio: profile.bio,
  country: profile.country,
  city: profile.city,
  ratingAverage: profile.ratingAverage,
  ratingCount: profile.ratingCount,
  createdAt: profile.createdAt,
});

// Posting (a TenderProject or a SiteForce JobOpening) only ever requires
// an active subscription — never `isVerified` — see clientProfileModel.ts
// for why. Shared by tenderProjectController and jobOpeningController so
// both pillars gate posting identically.
export const loadEligibleClientProfile = async (
  userId: mongoose.Types.ObjectId | string,
): Promise<IClientProfile | null> => {
  const profile = await ClientProfile.findOne({ userId });
  if (!profile) return null;

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

  if (!displayName || !country) {
    res.status(400);
    throw new Error("Please add a displayName and country");
  }

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

  const { displayName, bio, country, city } = req.body;

  if (displayName) profile.displayName = displayName;
  if (bio !== undefined) profile.bio = bio;
  if (country) profile.country = country;
  if (city !== undefined) profile.city = city;

  await profile.save();

  res.status(200).json(toPublicClientProfile(profile));
});

// @desc    View a poster's reputation — deliberately never gated behind
//          their own subscription/verification status, unlike a provider
//          profile. A poster isn't "discoverable" content being paywalled;
//          the whole point of this route is letting a worker/contractor
//          check someone's track record before engaging with them, which
//          should work regardless of whether the poster is currently
//          subscribed.
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

  res.status(200).json(toPublicClientProfile(profile));
});
