import mongoose from "mongoose";
import asyncHandler from "express-async-handler";
import { Request, Response } from "express";
import { PROFILE_MODEL_REGISTRY, PROFILE_TYPE, ProfileType, isKnownProfileType } from "../constants/profileTypes";
import { toPublicProfile as toPublicConsultancyProfile } from "./consultancyProfileController";
import { toPublicContractorProfile } from "./contractorProfileController";
import { toPublicLaborProfile } from "./laborProfileController";
import { toPublicStoreProfile } from "./storeProfileController";
import { toPublicDigitalCreatorProfile } from "./digitalCreatorProfileController";
import { toPublicClientProfile } from "./clientProfileController";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const PROFILE_SERIALIZERS: Record<ProfileType, (profile: any) => unknown> = {
  [PROFILE_TYPE.CONSULTANCY]: toPublicConsultancyProfile,
  [PROFILE_TYPE.CONTRACTOR]: toPublicContractorProfile,
  [PROFILE_TYPE.LABOR]: toPublicLaborProfile,
  [PROFILE_TYPE.STORE]: toPublicStoreProfile,
  [PROFILE_TYPE.DIGITAL_CREATOR]: toPublicDigitalCreatorProfile,
  [PROFILE_TYPE.CLIENT]: toPublicClientProfile,
};

// @desc    Set a profile's moderation status to 'active' (unban/
//          reactivate) or 'banned' — the only path that can ever reach
//          'banned' on any PROFILE_MODEL_REGISTRY entry. Deliberately
//          generic, one endpoint for all six profile types, the same
//          "register it once" pattern Verification/profileSubscriptionSync
//          already use rather than six near-identical per-controller
//          endpoints. Self-service 'active'/'inactive' toggling ("I'm
//          taking a break") stays on each profile's own update endpoint
//          and never reaches here — see constants/profileStatus.ts.
// @route   PATCH /api/admin/profiles/:profileType/:id/status
// @access  Private (Admin / Super Admin only)
export const setProfileStatus = asyncHandler(async (req: Request, res: Response) => {
  const profileType = req.params.profileType as string;
  const id = req.params.id as string;

  if (!isKnownProfileType(profileType)) {
    res.status(400);
    throw new Error("Invalid profileType");
  }

  if (!mongoose.Types.ObjectId.isValid(id)) {
    res.status(404);
    throw new Error("Profile not found");
  }

  const Model = PROFILE_MODEL_REGISTRY[profileType];
  const profile = await Model.findById(id);

  if (!profile) {
    res.status(404);
    throw new Error("Profile not found");
  }

  const { status } = req.body;

  profile.status = status;
  await profile.save();

  res.status(200).json({ profileType, id: profile.id, status: profile.status });
});

// @desc    View any profile's full detail, bypassing the public view's
//          gating entirely — banned, unverified, never subscribed, all of
//          it. The public single-view endpoints (e.g.
//          consultancyProfileController.getProfile) withhold content
//          exactly because that's a discoverability paywall tied to the
//          global subscription rule; an admin/customer_care reviewer
//          deciding whether to approve a KYC submission needs to see the
//          profile regardless of whether its owner happens to be
//          currently subscribed. Same REVIEW_ROLES read access as the
//          verification queue itself (GET /api/verifications) — this
//          exists for that workflow, not as a general-purpose admin
//          profile viewer.
// @route   GET /api/admin/profiles/:profileType/:id
// @access  Private (Admin / Super Admin / Customer Care — read-only)
export const getProfileForReview = asyncHandler(async (req: Request, res: Response) => {
  const profileType = req.params.profileType as string;
  const id = req.params.id as string;

  if (!isKnownProfileType(profileType)) {
    res.status(400);
    throw new Error("Invalid profileType");
  }

  if (!mongoose.Types.ObjectId.isValid(id)) {
    res.status(404);
    throw new Error("Profile not found");
  }

  const Model = PROFILE_MODEL_REGISTRY[profileType];
  const profile = await Model.findById(id);

  if (!profile) {
    res.status(404);
    throw new Error("Profile not found");
  }

  res.status(200).json(PROFILE_SERIALIZERS[profileType](profile));
});
