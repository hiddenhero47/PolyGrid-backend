import mongoose, { Document, Model, Schema, Types } from "mongoose";
import { isValidCountryCode } from "../helpers/countryReference";
import { IProfileLink, profileLinkSchema, validateLinkCount, MAX_PROFILE_LINKS } from "./profileLink";
import { IMediaFile, mediaFileSchema } from "./mediaFile";

export type { IProfileLink };
export { MAX_PROFILE_LINKS };

// PolyGrid Store's Physical Materials Marketplace profile — see
// docs/store-plan.md for the full design. The one thing that makes this
// pillar different from ConsultancyProfile: a store can own many Products,
// and there's no reasonable way to denormalize `currentSubscription` onto
// every one of them the way ConsultancyProfile denormalizes it onto
// itself (a single document). So subscription gating happens entirely at
// the *store* level — searching/viewing products always goes through a
// store first (see storeProfileController.ts's searchStores/getStore),
// and Product itself carries no subscription field of its own at all.
export const MATERIAL_CATEGORY = {
  CEMENT_CONCRETE: "cement_concrete",
  STEEL_REINFORCEMENT: "steel_reinforcement",
  AGGREGATES: "aggregates", // sand, gravel, stone
  BLOCKS_BRICKS: "blocks_bricks",
  ROOFING: "roofing",
  TIMBER_WOOD: "timber_wood",
  DOORS_WINDOWS: "doors_windows",
  ELECTRICAL: "electrical",
  PLUMBING: "plumbing",
  PAINT_FINISHES: "paint_finishes",
  TILES_FLOORING: "tiles_flooring",
  TOOLS_EQUIPMENT: "tools_equipment",
  SAFETY_GEAR: "safety_gear",
} as const;
export type MaterialCategory = (typeof MATERIAL_CATEGORY)[keyof typeof MATERIAL_CATEGORY];

export interface IStoreProfile extends Document {
  userId: Types.ObjectId;
  // Denormalized from User.currentSubscription, kept in sync by
  // profileSubscriptionSync.ts — same as ConsultancyProfile. Used to gate
  // the store itself (searchStores/getStore), never copied onto Product.
  currentSubscription: Types.ObjectId | null;
  isVerified: boolean;
  verification: Types.ObjectId | null;
  slug: string;
  storeName: string;
  description?: string;
  // The source of truth for what this store is allowed to sell — a
  // Product's own `category` must be one of these (checked in
  // productController.ts, not here, since a schema-level check can't see
  // the parent StoreProfile). Removing a category here cascades: every
  // Product under it is deleted too (see
  // storeProfileController.updateMyStoreProfile) — a store can't keep
  // selling something it just said it doesn't sell anymore.
  categories: MaterialCategory[];
  country: string;
  city?: string;
  links: IProfileLink[];
  logo?: IMediaFile;
  createdAt: Date;
  updatedAt: Date;
}

const storeProfileSchema = new Schema<IStoreProfile>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, unique: true },
    currentSubscription: { type: Schema.Types.ObjectId, ref: "Subscription", default: null },
    isVerified: { type: Boolean, default: false },
    verification: { type: Schema.Types.ObjectId, ref: "Verification", default: null },
    slug: { type: String, required: true, unique: true },
    storeName: { type: String, required: [true, "Please add a store name"], trim: true },
    description: { type: String },
    categories: {
      type: [String],
      enum: Object.values(MATERIAL_CATEGORY),
      validate: {
        validator: (categories: MaterialCategory[]) => categories.length > 0,
        message: "Select at least one category this store sells",
      },
    },
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
    // Free text on purpose — see countryReference.ts for why city is never
    // hard-validated against reference data.
    city: { type: String, trim: true },
    links: {
      type: [profileLinkSchema],
      default: [],
      validate: { validator: validateLinkCount, message: `A profile can have at most ${MAX_PROFILE_LINKS} links` },
    },
    logo: { type: mediaFileSchema },
  },
  { timestamps: true },
);

storeProfileSchema.index({ categories: 1 });
storeProfileSchema.index({ isVerified: 1, currentSubscription: 1 });

export const StoreProfile: Model<IStoreProfile> = mongoose.model<IStoreProfile>(
  "StoreProfile",
  storeProfileSchema,
);
