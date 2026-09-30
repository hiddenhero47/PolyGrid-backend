import mongoose from "mongoose";
import { ConsultancyProfile } from "../models/consultancyProfileModel";
import { StoreProfile } from "../models/storeProfileModel";
import { DigitalCreatorProfile } from "../models/digitalCreatorProfileModel";

// Every pillar business profile model, keyed by the string Verification's
// polymorphic profileType/refPath uses to identify it. Add the next pillar
// (Contractor, Labor) here when it's built — this is the one place
// that needs to know about all of them; profileSubscriptionSync.ts and
// verificationController.ts both read from this registry rather than each
// keeping their own list that could drift out of sync with the other.
// Registering StoreProfile here is the entire cost of getting KYC/
// verification working for it — submitVerification, approveVerification,
// and the whole VerificationTemplate lookup flow all work for stores with
// zero pillar-specific code, exactly what this registry was built for.
export const PROFILE_TYPE = {
  CONSULTANCY: "ConsultancyProfile",
  STORE: "StoreProfile",
  DIGITAL_CREATOR: "DigitalCreatorProfile",
} as const;
export type ProfileType = (typeof PROFILE_TYPE)[keyof typeof PROFILE_TYPE];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const PROFILE_MODEL_REGISTRY: Record<ProfileType, mongoose.Model<any>> = {
  [PROFILE_TYPE.CONSULTANCY]: ConsultancyProfile,
  [PROFILE_TYPE.STORE]: StoreProfile,
  [PROFILE_TYPE.DIGITAL_CREATOR]: DigitalCreatorProfile,
};

export const isKnownProfileType = (value: unknown): value is ProfileType =>
  typeof value === "string" && Object.values(PROFILE_TYPE).includes(value as ProfileType);
