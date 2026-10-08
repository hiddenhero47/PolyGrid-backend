import mongoose, { Document, Model, Schema, Types } from "mongoose";
import { isValidCurrencyCode } from "../helpers/currencyReference";
import { IMediaFile, mediaFileSchema } from "./mediaFile";

// A downloadable listing — floor plans, structural drafting details, site
// layout templates, BOQ sheets. See docs/digital-storefront-plan.md for
// the full design, in particular why this carries no subscription field
// of its own despite the flat, cross-creator "browse everything" feed
// being exactly the shape that made denormalizing subscription per-item
// look necessary: it isn't. `listFeed` (digitalProductController.ts) runs
// one aggregation directly against this collection with a two-hop
// `$lookup` (DigitalProduct -> its creator's DigitalCreatorProfile ->
// Subscription) and a live `$match` on active — still one query per page
// regardless of how many products exist, no per-product field to keep in
// sync, no staleness risk. The same trick `searchStores`/`searchConsultants`
// use, just anchored on the product instead of the profile, because here
// the product-level view genuinely is the primary discovery surface.
export const DIGITAL_PRODUCT_CATEGORY = {
  FLOOR_PLAN: "floor_plan",
  STRUCTURAL_DRAFTING: "structural_drafting",
  SITE_LAYOUT_TEMPLATE: "site_layout_template",
  BOQ_SHEET: "boq_sheet",
  OTHER: "other",
} as const;
export type DigitalProductCategory =
  (typeof DIGITAL_PRODUCT_CATEGORY)[keyof typeof DIGITAL_PRODUCT_CATEGORY];

// Same reasoning as every other media cap in this codebase.
export const MAX_PREVIEW_IMAGES = 6;
export const MAX_DELIVERABLE_FILES = 10;

export interface IDigitalProduct extends Document {
  creatorId: Types.ObjectId;
  category: DigitalProductCategory;
  title: string;
  // What you get by buying it — explicitly asked for: a creator explains
  // their work here, distinct from `title`.
  description?: string;
  // Public — shown to anyone browsing, same as ConsultancyProfile's
  // portfolio media or a Product's images.
  previewImages: IMediaFile[];
  price: number;
  currency: string;
  // The actual product — private files (visibility: FILE_VISIBILITY.PRIVATE
  // at upload time is what makes `url` undefined here; see mediaFile.ts).
  // Never served directly: only digitalProductController.getDownloadLink,
  // after checking the requester actually bought this (or is its
  // creator), mints a signed URL for one of these.
  files: IMediaFile[];
  // Creators can never hard-delete a listing (see docs/digital-storefront-
  // plan.md) — a past buyer's download access must keep working
  // regardless of what the creator does later. `isActive: false` just
  // hides it from the feed/creator page/direct view; the record and its
  // files stay exactly as they were.
  isActive: boolean;
  // Separate from (and in addition to) `isActive` and the creator's own
  // isVerified/status — this is admin/customer_care confirming the
  // *listing itself* is what it claims to be (the deliverable files
  // actually match the title/description/price), not a statement about
  // the creator. Defaults false: a brand-new listing is invisible in the
  // feed/direct view until someone's actually checked it, the same
  // "unverified by default" instinct every PROFILE_MODEL_REGISTRY entry
  // already uses. Set via digitalProductController.setDigitalProductVerification
  // — never by the creator.
  isVerified: boolean;
  verifiedBy?: Types.ObjectId;
  verifiedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const digitalProductSchema = new Schema<IDigitalProduct>(
  {
    creatorId: { type: Schema.Types.ObjectId, ref: "DigitalCreatorProfile", required: true, index: true },
    category: { type: String, enum: Object.values(DIGITAL_PRODUCT_CATEGORY), required: true },
    title: { type: String, required: [true, "Please add a title"], trim: true },
    description: { type: String },
    previewImages: {
      type: [mediaFileSchema],
      default: [],
      validate: {
        validator: (images: IMediaFile[]) => images.length <= MAX_PREVIEW_IMAGES,
        message: `A product can have at most ${MAX_PREVIEW_IMAGES} preview images`,
      },
    },
    price: { type: Number, required: true, min: 0 },
    currency: {
      type: String,
      required: true,
      default: "USD",
      uppercase: true,
      trim: true,
      validate: {
        validator: isValidCurrencyCode,
        message: (props: { value: string }) => `${props.value} is not a recognized ISO 4217 currency code`,
      },
    },
    files: {
      type: [mediaFileSchema],
      validate: {
        validator: (files: IMediaFile[]) => files.length > 0 && files.length <= MAX_DELIVERABLE_FILES,
        message: `A product needs at least one deliverable file, and at most ${MAX_DELIVERABLE_FILES}`,
      },
    },
    isActive: { type: Boolean, default: true },
    isVerified: { type: Boolean, default: false },
    verifiedBy: { type: Schema.Types.ObjectId, ref: "User" },
    verifiedAt: { type: Date },
  },
  { timestamps: true },
);

// The feed's two query shapes: "everything active+verified, optionally
// by category" and "one creator's active+verified work" (the
// creator-page view).
digitalProductSchema.index({ isActive: 1, isVerified: 1, category: 1, createdAt: -1 });
digitalProductSchema.index({ creatorId: 1, isActive: 1, isVerified: 1, createdAt: -1 });

export const DigitalProduct: Model<IDigitalProduct> = mongoose.model<IDigitalProduct>(
  "DigitalProduct",
  digitalProductSchema,
);
