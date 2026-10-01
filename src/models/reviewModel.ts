import mongoose, { Document, Model, Schema, Types } from "mongoose";

// A review targets a business PROFILE, not the specific job/item it came
// from — per the brief, another prospective client doesn't care about one
// past job, they care whether this profile is reliable overall. `profileType`
// reuses the same string values as constants/profileTypes.ts's PROFILE_TYPE
// (not imported directly — profileTypes.ts registers the profile *models*,
// and importing it here would be a model importing its own registry's
// consumer-side constant for no real benefit; the enum values are the
// actual coupling, kept in sync by convention same as Verification's own
// profileType already is).
//
// What makes a review legitimate: it must come from a real, completed
// transaction — never just "anyone can review anyone." `sourceType`/
// `sourceId` is the same polymorphic refPath trick Payment.targetType/
// targetId already uses, pointing at whichever transaction proves it: a
// completed Job (Engineering, Tenders Direct Hire or Bidding, Store
// Physical — anything that settles through Job) or a successful
// DigitalPurchase (Digital Storefront, which never uses a Job at all).
// reviewController.createReview resolves which profile actually earns the
// review from the source itself — the caller never gets to just name a
// profileId directly, which is what stops someone from reviewing a
// profile they never actually transacted with.
export const REVIEW_SOURCE_TYPE = {
  JOB: "Job",
  DIGITAL_PURCHASE: "DigitalPurchase",
} as const;
export type ReviewSourceType = (typeof REVIEW_SOURCE_TYPE)[keyof typeof REVIEW_SOURCE_TYPE];

export interface IReview extends Document {
  profileType: string;
  profileId: Types.ObjectId;
  reviewer: Types.ObjectId;
  rating: number;
  comment?: string;
  sourceType: ReviewSourceType;
  sourceId: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const reviewSchema = new Schema<IReview>(
  {
    profileType: { type: String, required: true },
    profileId: { type: Schema.Types.ObjectId, required: true, refPath: "profileType" },
    reviewer: { type: Schema.Types.ObjectId, ref: "User", required: true },
    rating: { type: Number, required: true, min: 1, max: 5 },
    comment: { type: String },
    sourceType: {
      type: String,
      required: true,
      enum: Object.values(REVIEW_SOURCE_TYPE),
    },
    sourceId: { type: Schema.Types.ObjectId, required: true, refPath: "sourceType" },
  },
  { timestamps: true },
);

reviewSchema.index({ profileType: 1, profileId: 1, createdAt: -1 });
// One review per completed transaction — not per reviewer+profile, since a
// repeat client with several separate jobs/purchases from the same profile
// genuinely has a separate thing to say each time. Ownership of the source
// (was *this* reviewer actually the paying party on it) is enforced in the
// controller, not here.
reviewSchema.index({ sourceType: 1, sourceId: 1 }, { unique: true });

export const Review: Model<IReview> = mongoose.model<IReview>("Review", reviewSchema);
