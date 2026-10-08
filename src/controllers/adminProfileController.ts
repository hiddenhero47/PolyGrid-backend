import mongoose from "mongoose";
import asyncHandler from "express-async-handler";
import { Request, Response } from "express";
import { PROFILE_MODEL_REGISTRY, isKnownProfileType } from "../constants/profileTypes";

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
