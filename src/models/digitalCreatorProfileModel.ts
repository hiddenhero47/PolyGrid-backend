import mongoose, { Document, Model, Schema, Types } from "mongoose";
import { isValidCountryCode } from "../helpers/countryReference";
import { IProfileLink, profileLinkSchema, validateLinkCount, MAX_PROFILE_LINKS } from "./profileLink";
import { IMediaFile, mediaFileSchema } from "./mediaFile";

export type { IProfileLink };
export { MAX_PROFILE_LINKS };

// PolyGrid Store's Digital Storefront profile — see docs/digital-storefront-plan.md.
// Deliberately a *separate* profile type from StoreProfile (Physical),
// even though the brief describes both as one "PolyGrid Store" pillar:
// the two have almost nothing in common mechanically. Physical gates
// discovery at the store level (a store owns many products, subscription
// checked once per store); Digital's whole discovery model is a flat,
// cross-creator feed (see digitalProductModel.ts) — there's no "store
// page" step to gate at, and no shipping/category-cascade concept either.
// Forcing them into one model would mean either field carrying meaning
// for the other pillar wouldn't, which is worse than two small profiles.
export interface IDigitalCreatorProfile extends Document {
  userId: Types.ObjectId;
  // Denormalized from User.currentSubscription, synced by
  // profileSubscriptionSync.ts — same as every other pillar profile.
  // Never copied onto DigitalProduct itself; see digitalProductModel.ts
  // for why (the same reason StoreProfile's currentSubscription is never
  // copied onto Product).
  currentSubscription: Types.ObjectId | null;
  isVerified: boolean;
  verification: Types.ObjectId | null;
  slug: string;
  displayName: string;
  bio?: string;
  country: string;
  city?: string;
  links: IProfileLink[];
  avatar?: IMediaFile;
  createdAt: Date;
  updatedAt: Date;
}

const digitalCreatorProfileSchema = new Schema<IDigitalCreatorProfile>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, unique: true },
    currentSubscription: { type: Schema.Types.ObjectId, ref: "Subscription", default: null },
    isVerified: { type: Boolean, default: false },
    verification: { type: Schema.Types.ObjectId, ref: "Verification", default: null },
    slug: { type: String, required: true, unique: true },
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
    links: {
      type: [profileLinkSchema],
      default: [],
      validate: { validator: validateLinkCount, message: `A profile can have at most ${MAX_PROFILE_LINKS} links` },
    },
    avatar: { type: mediaFileSchema },
  },
  { timestamps: true },
);

digitalCreatorProfileSchema.index({ isVerified: 1, currentSubscription: 1 });

export const DigitalCreatorProfile: Model<IDigitalCreatorProfile> = mongoose.model<IDigitalCreatorProfile>(
  "DigitalCreatorProfile",
  digitalCreatorProfileSchema,
);
