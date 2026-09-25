import mongoose, { Document, Model, Schema, Types } from "mongoose";
import { PAYMENT_PROVIDER_NAME, PaymentProviderName } from "./paymentProviderModel";
import { isValidCurrencyCode } from "../helpers/currencyReference";

// Polymorphic — a Payment is always *for* something, and that something is
// either a Job (topping up escrow) or a Subscription (buying/renewing a
// plan). `targetId` uses Mongoose's refPath so `.populate('targetId')`
// resolves to the right collection automatically instead of needing two
// near-identical models. Add a case here (and to PAYMENT_TARGET_TYPE) if a
// third kind of purchase (e.g. a Store order) needs payments later.
export const PAYMENT_TARGET_TYPE = {
  JOB: "Job",
  SUBSCRIPTION: "Subscription",
} as const;
export type PaymentTargetType = (typeof PAYMENT_TARGET_TYPE)[keyof typeof PAYMENT_TARGET_TYPE];

export const PAYMENT_STATUS = {
  PENDING: "pending",
  SUCCESS: "success",
  FAILED: "failed",
  REFUNDED: "refunded",
  CANCELLED: "cancelled",
} as const;
export type PaymentStatus = (typeof PAYMENT_STATUS)[keyof typeof PAYMENT_STATUS];

export interface IPayment extends Document {
  targetType: PaymentTargetType;
  targetId: Types.ObjectId;
  user: Types.ObjectId;
  // Snapshotted, same reasoning as Contact — a payment record should still
  // show the address it was made through even if the user later changes it.
  userEmail: string;
  amount: number;
  currency: string;
  // The gateway's own actual reported cut (0 for a manual entry) — separate
  // from PaymentProvider.percentageFee/flatFee, which is an estimate/config,
  // not ground truth for any specific transaction.
  providerFeeAmount: number;
  provider: PaymentProviderName;
  // e.g. a Stripe PaymentIntent id — absent for a manual entry.
  providerPaymentId?: string;
  status: PaymentStatus;
  // Snapshot of the gateway's event/response payload, for audit — not
  // something application code should read back to make decisions from.
  rawProviderPayload?: Record<string, unknown>;
  // Set only when provider === 'manual' — which admin recorded this.
  recordedBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const paymentSchema = new Schema<IPayment>(
  {
    targetType: {
      type: String,
      required: true,
      enum: Object.values(PAYMENT_TARGET_TYPE),
    },
    targetId: {
      type: Schema.Types.ObjectId,
      required: true,
      refPath: "targetType",
    },
    user: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    userEmail: { type: String, required: true },
    amount: { type: Number, required: true, min: 0 },
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
    providerFeeAmount: { type: Number, default: 0, min: 0 },
    provider: {
      type: String,
      required: true,
      enum: Object.values(PAYMENT_PROVIDER_NAME),
    },
    providerPaymentId: { type: String },
    status: {
      type: String,
      enum: Object.values(PAYMENT_STATUS),
      default: PAYMENT_STATUS.PENDING,
    },
    rawProviderPayload: { type: Object },
    recordedBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

paymentSchema.index({ targetType: 1, targetId: 1 });
paymentSchema.index({ user: 1, createdAt: -1 });
paymentSchema.index({ status: 1 });
// Guards against the same gateway transaction ever being recorded twice.
// Deliberately `partialFilterExpression`, not `sparse`: for a *compound*
// index, "sparse" only excludes a document when EVERY indexed field is
// missing — since `provider` is always set, a manual entry (which never
// sets `providerPaymentId`) would still be indexed with it as null, and a
// second manual entry would collide on that same null. A partial index
// excludes any document missing `providerPaymentId` specifically,
// regardless of `provider` — confirmed empirically, not just by docs.
paymentSchema.index(
  { provider: 1, providerPaymentId: 1 },
  { unique: true, partialFilterExpression: { providerPaymentId: { $exists: true } } },
);

export const Payment: Model<IPayment> = mongoose.model<IPayment>("Payment", paymentSchema);
