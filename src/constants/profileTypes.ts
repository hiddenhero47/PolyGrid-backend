import mongoose from "mongoose";
import { ConsultancyProfile } from "../models/consultancyProfileModel";
import { StoreProfile } from "../models/storeProfileModel";
import { DigitalCreatorProfile } from "../models/digitalCreatorProfileModel";
import { ContractorProfile } from "../models/contractorProfileModel";
import { ClientProfile } from "../models/clientProfileModel";
import { LaborProfile } from "../models/laborProfileModel";

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
  CONTRACTOR: "ContractorProfile",
  CLIENT: "ClientProfile",
  LABOR: "LaborProfile",
} as const;
export type ProfileType = (typeof PROFILE_TYPE)[keyof typeof PROFILE_TYPE];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const PROFILE_MODEL_REGISTRY: Record<ProfileType, mongoose.Model<any>> = {
  [PROFILE_TYPE.CONSULTANCY]: ConsultancyProfile,
  [PROFILE_TYPE.STORE]: StoreProfile,
  [PROFILE_TYPE.DIGITAL_CREATOR]: DigitalCreatorProfile,
  [PROFILE_TYPE.CONTRACTOR]: ContractorProfile,
  [PROFILE_TYPE.CLIENT]: ClientProfile,
  [PROFILE_TYPE.LABOR]: LaborProfile,
};

export const isKnownProfileType = (value: unknown): value is ProfileType =>
  typeof value === "string" && Object.values(PROFILE_TYPE).includes(value as ProfileType);

// Every profile type's "what do I call this on a list row" field — each
// pillar settled on its own name (ConsultancyProfile/ContractorProfile/
// LaborProfile: headline, StoreProfile: storeName,
// DigitalCreatorProfile/ClientProfile: displayName) rather than a shared
// `name` field, so anything rendering a profile generically (admin
// search, review moderation) needs this map instead of just reading
// `.name`. Kept here, next to PROFILE_MODEL_REGISTRY, for the same
// reason that lives here — one place that knows about every profile
// type, read by adminProfileController.ts and reviewController.ts.
export const PROFILE_NAME_FIELD: Record<ProfileType, string> = {
  [PROFILE_TYPE.CONSULTANCY]: "headline",
  [PROFILE_TYPE.CONTRACTOR]: "headline",
  [PROFILE_TYPE.LABOR]: "headline",
  [PROFILE_TYPE.STORE]: "storeName",
  [PROFILE_TYPE.DIGITAL_CREATOR]: "displayName",
  [PROFILE_TYPE.CLIENT]: "displayName",
};

// ClientProfile is the one profile type with no slug at all (it has no
// public storefront page to slug) — omitted here rather than mapped to
// a fake field name, so callers can tell "doesn't apply" apart from "has
// one, just empty."
export const PROFILE_SLUG_FIELD: Partial<Record<ProfileType, string>> = {
  [PROFILE_TYPE.CONSULTANCY]: "slug",
  [PROFILE_TYPE.CONTRACTOR]: "slug",
  [PROFILE_TYPE.LABOR]: "slug",
  [PROFILE_TYPE.STORE]: "slug",
  [PROFILE_TYPE.DIGITAL_CREATOR]: "slug",
};

// Which pillar profile (if any) a given userId owns — reviewController
// uses this to figure out who actually earns a review coming from a
// completed Job, without the Job itself needing to know or trust a
// client-supplied profileId. Checks every registry entry rather than
// trusting Job.jobType, since nothing currently guarantees a Job created
// through the generic POST /api/jobs (Direct Hire has no dedicated
// "hire" endpoint of its own) actually has the right jobType set.
export const findProfileByUserId = async (
  userId: mongoose.Types.ObjectId | string,
): Promise<{ profileType: ProfileType; profileId: mongoose.Types.ObjectId } | null> => {
  for (const [profileType, Model] of Object.entries(PROFILE_MODEL_REGISTRY) as [
    ProfileType,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mongoose.Model<any>,
  ][]) {
    const profile = await Model.findOne({ userId }).select("_id");
    if (profile) return { profileType, profileId: profile._id as mongoose.Types.ObjectId };
  }

  return null;
};
