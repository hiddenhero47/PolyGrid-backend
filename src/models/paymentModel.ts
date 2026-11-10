import mongoose, { Document, Model, Schema, Types } from "mongoose";
import { PAYMENT_PROVIDER_NAME, PaymentProviderName } from "./paymentProviderModel";
import { currencyField, PLATFORM_CURRENCY } from "../helpers/currencyReference";

// Polymorphic — a Payment is always *for* something: a Job (topping up
// escrow), a Subscription (buying/renewing a plan), or a DigitalPurchase
// (a direct one-off buy, no escrow/negotiation — see
// digitalPurchaseModel.ts). `targetId` uses Mongoose's refPath so
// `.populate('targetId')` resolves to the right collection automatically
// instead of needing three near-identical models.
export const PAYMENT_TARGET_TYPE = {
  JOB: "Job",
  SUBSCRIPTION: "Subscription",
  DIGITAL_PURCHASE: "DigitalPurchase",
} as const;
export type PaymentTargetType = (typeof PAYMENT_TARGET_TYPE)[keyof typeof PAYMENT_TARGET_TYPE];

export const PAYMENT_STATUS = {
  PENDING: "pending",
  SUCCESS: "success",
  FAILED: "failed",
  REFUNDED: "refunded",
  CANCELLED: "cancelled",
  // The charge succeeded but a dispute arrived while it was still on
  // hold (isOnHold below) — never set for a payment whose value was
  // already released; see paymentController.ts's stripeWebhook handling
  // of charge.dispute.created. The hold did its job: no escrow credit, no
  // download, no subscription activation ever happened for this one.
  DISPUTED: "disputed",
} as const;
export type PaymentStatus = (typeof PAYMENT_STATUS)[keyof typeof PAYMENT_STATUS];

// Which pocket this charge's bulk lands in once Stripe Connect is in play
// (see helpers/stripeConnect.ts) — `platform` for a Subscription (100%
// stays with PolyGrid), `marketplace` for a Job or DigitalPurchase (the
// provider/creator's cut moves to their own connected account later, via
// a real Transfer — see systemPayoutController.ts's markSystemPayoutPaid).
// Orthogonal to `provider` below (stripe vs manual) — this is about where
// the money is headed, not which gateway moved it.
export const PAYMENT_RAIL = {
  PLATFORM: "platform",
  MARKETPLACE: "marketplace",
} as const;
export type PaymentRail = (typeof PAYMENT_RAIL)[keyof typeof PAYMENT_RAIL];

export interface IPayment extends Document {
  targetType: PaymentTargetType;
  targetId: Types.ObjectId;
  user: Types.ObjectId;
  // Snapshotted, same reasoning as Contact — a payment record should still
  // show the address it was made through even if the user later changes it.
  userEmail: string;
  amount: number;
  currency: string;
  rail: PaymentRail;
  // The buyer's own country at charge time, and where the bulk of this
  // charge is ultimately headed — SYSTEM_COUNTRY for a platform-rail
  // payment, the provider/creator's own country for a marketplace-rail
  // one. Descriptive metadata for now (which gateway/provider a given
  // country pair could use later) — not itself a gate; see
  // helpers/paymentGuardrails.ts for the actual supported-country check,
  // which only ever looks at transactionCountryFrom.
  transactionCountryFrom?: string;
  transactionCountryTo?: string;
  // The gateway's own actual reported cut (0 for a manual entry) — separate
  // from PaymentProvider.percentageFee/flatFee, which is an estimate/config,
  // not ground truth for any specific transaction.
  providerFeeAmount: number;
  provider: PaymentProviderName;
  // e.g. a Stripe PaymentIntent id — absent for a manual entry.
  providerPaymentId?: string;
  // What was actually sent to the gateway for this charge — normally
  // identical to amount/currency above (every provider but one echoes
  // them straight through, see providers/paymentProviders/types.ts's
  // CreateIntentResult), except a Paystack charge converted from USD to
  // NGN at send-time (SystemSettings.usdToNgnRate — this Paystack
  // integration has no USD support). reconcilePaymentIntent compares the
  // gateway's response against THESE, not amount/currency directly, so a
  // converted charge is never flagged as an amount/currency mismatch.
  // Optional/unset on a payment created before this field existed, or
  // any 'manual' entry — reconcilePaymentIntent falls back to
  // amount/currency when absent.
  providerChargedAmount?: number;
  providerChargedCurrency?: string;
  status: PaymentStatus;
  // Card-fraud mitigation (see helpers/paymentReconciliation.ts,
  // helpers/paymentHoldRelease.ts) — a successful charge over
  // SystemSettings.fraudHoldThresholdAmount sets isOnHold + holdReleaseAt
  // instead of immediately crediting escrow/unlocking a download/
  // activating a subscription; the sweep releases it once holdReleaseAt
  // passes. disputedAt is set whenever a charge.dispute.created webhook
  // arrives for this payment, hold or not — see PAYMENT_STATUS.DISPUTED
  // above for the "caught it in time" case.
  isOnHold: boolean;
  holdReleaseAt?: Date;
  disputedAt?: Date;
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
    currency: { ...currencyField, required: true, default: PLATFORM_CURRENCY },
    rail: { type: String, required: true, enum: Object.values(PAYMENT_RAIL) },
    transactionCountryFrom: { type: String, uppercase: true, trim: true },
    transactionCountryTo: { type: String, uppercase: true, trim: true },
    providerFeeAmount: { type: Number, default: 0, min: 0 },
    provider: {
      type: String,
      required: true,
      enum: Object.values(PAYMENT_PROVIDER_NAME),
    },
    providerPaymentId: { type: String },
    providerChargedAmount: { type: Number, min: 0 },
    providerChargedCurrency: { type: String, uppercase: true, trim: true },
    status: {
      type: String,
      enum: Object.values(PAYMENT_STATUS),
      default: PAYMENT_STATUS.PENDING,
    },
    isOnHold: { type: Boolean, default: false },
    holdReleaseAt: { type: Date },
    disputedAt: { type: Date },
    rawProviderPayload: { type: Object },
    recordedBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

paymentSchema.index({ targetType: 1, targetId: 1 });
paymentSchema.index({ user: 1, createdAt: -1 });
paymentSchema.index({ status: 1 });
// helpers/paymentHoldRelease.ts's own read pattern: every payment still
// on hold whose release time has passed.
paymentSchema.index({ isOnHold: 1, holdReleaseAt: 1 });
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
