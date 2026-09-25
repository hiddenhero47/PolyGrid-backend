import mongoose from "mongoose";
import { ConsultancyProfile } from "../models/consultancyProfileModel";

// Every pillar business profile model, keyed by the string Verification's
// polymorphic profileType/refPath uses to identify it. Add the next pillar
// (Contractor, Store, Labor) here when it's built — this is the one place
// that needs to know about all of them; profileSubscriptionSync.ts and
// verificationController.ts both read from this registry rather than each
// keeping their own list that could drift out of sync with the other.
export const PROFILE_TYPE = {
  CONSULTANCY: "ConsultancyProfile",
} as const;
export type ProfileType = (typeof PROFILE_TYPE)[keyof typeof PROFILE_TYPE];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const PROFILE_MODEL_REGISTRY: Record<ProfileType, mongoose.Model<any>> = {
  [PROFILE_TYPE.CONSULTANCY]: ConsultancyProfile,
};

export const isKnownProfileType = (value: unknown): value is ProfileType =>
  typeof value === "string" && Object.values(PROFILE_TYPE).includes(value as ProfileType);
