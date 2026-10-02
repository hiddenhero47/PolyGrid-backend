import mongoose, { Document, Model, Schema, Types } from "mongoose";
import { isValidCountryCode } from "../helpers/countryReference";

// The poster-side identity for pillars with a genuine "post something,
// others respond" flow — PolyGrid Tenders' Project Bidding Board and
// PolyGrid SiteForce's Location-Based Job Board. Direct Hire (Consultancy,
// Contractor, Labor) never needs this: a client there just browses and
// hires directly, no posting step exists to attach an identity to.
//
// Why this exists at all, not just a bare subscribed User: registering it
// in PROFILE_MODEL_REGISTRY is what lets Reviews target a poster's
// reputation the same generic way they target a provider's — a worker
// physically going to a stranger's site, or a contractor committing to a
// project, benefits from the same "is this person reliable" signal a
// client already gets about them. Without a profile here, there was
// nothing for that review to point at.
//
// Posting itself only ever requires an active subscription (checked via
// `currentSubscription` below) — never `isVerified`. Real gig/service
// platforms (TaskRabbit, Handy) background-check the person going to a
// stranger's property, not the person inviting them; `isVerified`/
// `verification` are kept here purely for consistency with every other
// PROFILE_MODEL_REGISTRY entry (so the generic Verification pipeline
// works for a poster who *chooses* to verify, e.g. to earn a trust badge)
// — never required to post.
export interface IClientProfile extends Document {
  userId: Types.ObjectId;
  currentSubscription: Types.ObjectId | null;
  isVerified: boolean;
  verification: Types.ObjectId | null;
  displayName: string;
  bio?: string;
  country: string;
  city?: string;
  // Running totals maintained by reviewController.applyReviewToProfile —
  // see reviewModel.ts. Never written to directly anywhere else.
  ratingAverage: number;
  ratingCount: number;
  createdAt: Date;
  updatedAt: Date;
}

const clientProfileSchema = new Schema<IClientProfile>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, unique: true },
    currentSubscription: { type: Schema.Types.ObjectId, ref: "Subscription", default: null },
    isVerified: { type: Boolean, default: false },
    verification: { type: Schema.Types.ObjectId, ref: "Verification", default: null },
    displayName: { type: String, required: [true, "Please add a display name"], trim: true },
    bio: { type: String },
    country: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      validate: {
        validator: isValidCountryCode,
        message: (props: { value: string }) => `${props.value} is not a recognized ISO country code`,
      },
    },
    city: { type: String, trim: true },
    ratingAverage: { type: Number, default: 0, min: 0, max: 5 },
    ratingCount: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true },
);

export const ClientProfile: Model<IClientProfile> = mongoose.model<IClientProfile>(
  "ClientProfile",
  clientProfileSchema,
);
