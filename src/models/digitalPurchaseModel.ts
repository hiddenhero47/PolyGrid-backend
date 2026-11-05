import mongoose, { Document, Model, Schema, Types } from "mongoose";
import { currencyField } from "../helpers/currencyReference";
import { IDigitalFile, digitalFileSchema } from "./digitalFile";

// A direct purchase — no Job involved at all, unlike every other pillar's
// paid interaction. See docs/digital-storefront-plan.md: the brief
// explicitly wants "purchase and download immediately," not an escrow/
// negotiation step, so this plugs straight into the existing generic
// Payment/Stripe flow (PAYMENT_TARGET_TYPE.DIGITAL_PURCHASE) the same way
// Subscription does — created PENDING the moment checkout starts, and
// only the webhook (on a real successful charge) flips it to SUCCESS,
// which is what actually grants download access
// (digitalProductController.getDownloadLink checks for a SUCCESS record,
// nothing else). Same "exists in an interim state before payment is
// real" instinct as SUBSCRIPTION_STATUS.PENDING.
export const DIGITAL_PURCHASE_STATUS = {
  PENDING: "pending",
  SUCCESS: "success",
} as const;
export type DigitalPurchaseStatus =
  (typeof DIGITAL_PURCHASE_STATUS)[keyof typeof DIGITAL_PURCHASE_STATUS];

// The creator's own earnings on this purchase never had any payout path
// at all before Stripe Connect — this is that path, first time. Mirrors
// Job's requestPayout/approvePayoutRequest shape, just without a
// counterparty (there's no single "client" on a digital purchase to ask —
// see digitalCreatorProfileController.ts's requestDigitalCreatorPayout,
// which bundles every `unpaid` purchase into one SystemPayout at once).
export const DIGITAL_PURCHASE_PAYOUT_STATUS = {
  UNPAID: "unpaid",
  REQUESTED: "requested",
  PAID: "paid",
} as const;
export type DigitalPurchasePayoutStatus =
  (typeof DIGITAL_PURCHASE_PAYOUT_STATUS)[keyof typeof DIGITAL_PURCHASE_PAYOUT_STATUS];

export interface IDigitalPurchase extends Document {
  product: Types.ObjectId;
  buyer: Types.ObjectId;
  // Denormalized for query convenience (a creator's own "who bought my
  // stuff" list without populating through product every time) — never
  // used for access control, which always checks the specific `product`.
  creator: Types.ObjectId;
  priceSnapshot: number;
  currency: string;
  status: DigitalPurchaseStatus;
  // Frozen the moment checkout starts (handleDigitalPurchasePaymentIntent)
  // — exactly which creator-side S3 keys this purchase is entitled to,
  // captured before the creator can add/remove anything. This is what
  // makes the eventual copy race-safe: no matter what the creator does to
  // `DigitalProduct.files` while payment is still processing, the webhook
  // always copies from these exact keys, which removeDigitalProductFile
  // guarantees are never deleted.
  fileManifest: IDigitalFile[];
  // The buyer's OWN copied objects, independent of the product afterward.
  // Empty until digitalPurchaseFiles.copyPurchaseFiles runs (triggered by
  // the webhook on a successful payment), emptied again by the weekly
  // retention sweep (helpers/digitalPurchaseRetention.ts) once this buyer's
  // subscription has lapsed for 7+ days. getDigitalProductDownloadLink
  // reads from here, never from DigitalProduct.files, for a buyer.
  files: IDigitalFile[];
  // Set only by the retention sweep when it wipes `files` — distinguishes
  // "deliberately expired" (this set) from "the purchase-time copy never
  // completed" (files empty, this still null — an operational gap, not an
  // expiry).
  filesDeletedAt: Date | null;
  // Snapshotted at purchase time from getPlatformFeePercent() (the same
  // single source of truth Job uses) — a later env change never
  // retroactively changes what an already-made purchase owes the
  // creator, same reasoning as Job.platformFeePercent.
  platformFeePercent: number;
  payoutStatus: DigitalPurchasePayoutStatus;
  // Set when a creator payout request bundles this purchase in — the
  // backstop against ever counting the same purchase toward two
  // different payout requests.
  payoutRequestId?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const digitalPurchaseSchema = new Schema<IDigitalPurchase>(
  {
    product: { type: Schema.Types.ObjectId, ref: "DigitalProduct", required: true, index: true },
    buyer: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    creator: { type: Schema.Types.ObjectId, ref: "DigitalCreatorProfile", required: true },
    priceSnapshot: { type: Number, required: true, min: 0 },
    currency: { ...currencyField, required: true },
    status: {
      type: String,
      enum: Object.values(DIGITAL_PURCHASE_STATUS),
      default: DIGITAL_PURCHASE_STATUS.PENDING,
    },
    fileManifest: { type: [digitalFileSchema], default: [] },
    files: { type: [digitalFileSchema], default: [] },
    filesDeletedAt: { type: Date, default: null },
    platformFeePercent: { type: Number, required: true, min: 0, max: 100 },
    payoutStatus: {
      type: String,
      enum: Object.values(DIGITAL_PURCHASE_PAYOUT_STATUS),
      default: DIGITAL_PURCHASE_PAYOUT_STATUS.UNPAID,
    },
    payoutRequestId: { type: Schema.Types.ObjectId },
  },
  { timestamps: true },
);

// requestDigitalCreatorPayout's own read pattern (digitalCreatorProfileController.ts):
// every SUCCESS, UNPAID purchase for one creator.
digitalPurchaseSchema.index({ creator: 1, status: 1, payoutStatus: 1 });

// "Have I already bought this" (download-access check, and blocking a
// duplicate purchase) and "my purchase history" are the only two lookups
// this ever needs.
digitalPurchaseSchema.index({ buyer: 1, product: 1 });
digitalPurchaseSchema.index({ buyer: 1, createdAt: -1 });
// The retention sweep's read pattern (helpers/digitalPurchaseRetention.ts):
// every successful purchase still holding a live copy.
digitalPurchaseSchema.index({ status: 1 });

export const DigitalPurchase: Model<IDigitalPurchase> = mongoose.model<IDigitalPurchase>(
  "DigitalPurchase",
  digitalPurchaseSchema,
);
