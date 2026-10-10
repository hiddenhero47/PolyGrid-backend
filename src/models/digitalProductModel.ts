import mongoose, { Document, Model, Schema, Types } from "mongoose";
import { isValidCurrencyCode } from "../helpers/currencyReference";
import { IMediaFile, mediaFileSchema } from "./mediaFile";
import { IDigitalFile, digitalFileSchema } from "./digitalFile";

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

// A removed deliverable file, held for BIN_GRACE_MS (helpers/
// digitalProductBin.ts) before its underlying storage object is actually
// deleted — the grace period a purchase mid-checkout needs to still copy
// it via its frozen fileManifest (see docs/digital-storefront-plan.md).
// `deleteAt` is checked (and, once past, acted on) by
// helpers/digitalProductBin.ts's clearProductBin, called lazily whenever
// this product is read or written — never a cron sweep, since a product
// this inactive/unvisited has nothing time-sensitive riding on its bin
// being cleared promptly.
export interface IBinEntry {
  file: IDigitalFile;
  deleteAt: Date;
}

const binEntrySchema = new Schema<IBinEntry>(
  {
    file: { type: digitalFileSchema, required: true },
    deleteAt: { type: Date, required: true },
  },
  { _id: false },
);

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
  // The actual product — lives wherever the configured storage provider
  // puts it (see docs/digital-storefront-plan.md). Never served directly:
  // only digitalProductController.getDigitalProductDownloadLink, after
  // checking the requester actually bought this (or is its creator),
  // mints a short-lived download link for one of these. A creator can add
  // (addDigitalProductFiles) or remove (removeDigitalProductFile) entries
  // here freely — removal moves the entry into `bin` rather than deleting
  // it immediately, because a purchase already in flight may still be
  // entitled to copy it (see DigitalPurchase.fileManifest). A past buyer's
  // own access never reads this array at all once they've bought — see
  // `files` on DigitalPurchase — so editing/removing here can never
  // affect them.
  files: IDigitalFile[];
  // Removed files awaiting permanent deletion — see IBinEntry above and
  // helpers/digitalProductBin.ts.
  bin: IBinEntry[];
  // Creators can never hard-delete a listing (see docs/digital-storefront-
  // plan.md) — a past buyer's download access must keep working
  // regardless of what the creator does later. `isActive: false` just
  // hides it from the feed/creator page/direct view; the record stays
  // exactly as it was.
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
      type: [digitalFileSchema],
      validate: {
        // An active listing always needs at least one file; a permanently
        // deactivated one (helpers/profileProductCleanup.ts's
        // deactivateAndClearDigitalProduct — reclaiming storage from a
        // long-lapsed creator's catalog) has had everything deliberately
        // emptied out, so the minimum doesn't apply to it.
        validator: function (this: IDigitalProduct, files: IDigitalFile[]) {
          if (!this.isActive) return files.length <= MAX_DELIVERABLE_FILES;
          return files.length > 0 && files.length <= MAX_DELIVERABLE_FILES;
        },
        message: `A product needs at least one deliverable file, and at most ${MAX_DELIVERABLE_FILES}`,
      },
    },
    bin: { type: [binEntrySchema], default: [] },
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
