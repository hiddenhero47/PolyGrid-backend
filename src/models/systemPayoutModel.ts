import mongoose, { Document, Model, Schema, Types } from "mongoose";
import { IPayoutAccount } from "./userModel";
import { currencyField } from "../helpers/currencyReference";

// Deliberately its own enum, not a reuse of paymentModel's
// PAYMENT_TARGET_TYPE — a Payment (money IN) is only ever for a Job,
// Subscription, or DigitalPurchase, but a SystemPayout (money OWED) can
// also target a DigitalCreatorProfile directly (one payout request
// bundles many purchases at once — see
// digitalCreatorProfileController.ts's requestDigitalCreatorPayout).
// String values match real registered Mongoose model names (same
// convention PROFILE_TYPE already uses) so `.populate('targetId')` keeps
// working generically via refPath.
export const SYSTEM_PAYOUT_TARGET_TYPE = {
  JOB: "Job",
  DIGITAL_CREATOR_PROFILE: "DigitalCreatorProfile",
} as const;
export type SystemPayoutTargetType =
  (typeof SYSTEM_PAYOUT_TARGET_TYPE)[keyof typeof SYSTEM_PAYOUT_TARGET_TYPE];

// The ledger of money PolyGrid actually owes someone (a provider's
// approved payout, or a client's approved refund) once an admin has
// signed off on it — created the moment jobController's
// approveRefundRequest/approvePayoutRequest runs, never before. Distinct
// from Payment (money moving *into* PolyGrid) and from Job's own
// refunds/payouts sub-documents (the *request*, still just an ask until
// approved) — this is the record of what's now actually owed and where
// it should go. `settlementMethod` (below) decides what actually happens
// when an admin clicks "mark paid": a real Stripe Transfer/Refund call
// when the recipient has a usable Connect account or there's a real
// charge to refund, or still the original fully-manual "admin moved the
// money by hand" flow otherwise — `isLocked` exists so whoever's
// processing a batch by hand can mark one as claimed without a DB
// transaction.
export const SYSTEM_PAYOUT_REQUEST_TYPE = {
  REFUND: "refund",
  PAYOUT: "payout",
} as const;
export type SystemPayoutRequestType =
  (typeof SYSTEM_PAYOUT_REQUEST_TYPE)[keyof typeof SYSTEM_PAYOUT_REQUEST_TYPE];

export const SYSTEM_PAYOUT_STATUS = {
  // Recorded, money not actually sent yet — every record starts here.
  PENDING: "pending",
  PAID: "paid",
  FAILED: "failed",
} as const;
export type SystemPayoutStatus = (typeof SYSTEM_PAYOUT_STATUS)[keyof typeof SYSTEM_PAYOUT_STATUS];

// Snapshotted at creation (see jobController.ts's createSystemPayout) —
// "stripe" when a real gateway call can settle this (the recipient has a
// usable Connect account for a payout, or the job has a real Stripe
// charge to refund for a refund); "manual" otherwise, the exact unchanged
// behavior from before Connect existed. systemPayoutController.ts's
// markSystemPayoutPaid is where this actually matters — it's the one
// place that now calls Stripe for real instead of just recording a flag.
export const SETTLEMENT_METHOD = {
  STRIPE: "stripe",
  MANUAL: "manual",
} as const;
export type SettlementMethod = (typeof SETTLEMENT_METHOD)[keyof typeof SETTLEMENT_METHOD];

export interface ISystemPayout extends Document {
  requestType: SystemPayoutRequestType;
  // Polymorphic — "Job" (a store/siteforce/tenders/engineering payout or
  // refund is always a Job underneath) or "DigitalCreatorProfile" (a
  // digital creator's bundled payout request, no originating Job at all).
  targetType: SystemPayoutTargetType;
  targetId: Types.ObjectId;
  // The specific Job.refunds[]/Job.payouts[] sub-document this came from
  // — traceability back to the original request/approval, not a second
  // source of truth for the amount (that's snapshotted below). Not
  // meaningful for a DigitalCreatorProfile target (there's no single
  // originating sub-document to point at — the SystemPayout itself IS
  // the record); set to the SystemPayout's own future _id isn't possible
  // at creation time, so requestDigitalCreatorPayout uses a fresh
  // ObjectId here purely to satisfy the schema's uniqueness constraint.
  requestId: Types.ObjectId;
  // Who actually receives the money — the job's client for a refund, its
  // provider for a payout.
  user: Types.ObjectId;
  amount: number;
  currency: string;
  status: SystemPayoutStatus;
  settlementMethod: SettlementMethod;
  // Snapshotted off User.payoutAccount at approval time — never a live
  // reference, so a recipient changing their account afterward can't
  // silently redirect money already approved for a specific destination.
  payoutAccount: IPayoutAccount;
  isLocked: boolean;
  lockedAt?: Date;
  lockedBy?: Types.ObjectId;
  // The admin who approved the underlying request (and so caused this
  // record to be created) — not necessarily the same person who'll
  // eventually lock/pay it.
  createdBy: Types.ObjectId;
  // Set once systemPayoutController.markPaid/markFailed actually settles
  // this record — same "who decided, and when" shape as
  // IRefund/IPayout's own decidedBy/decidedAt, just for the transfer
  // itself rather than the original approval.
  settledBy?: Types.ObjectId;
  settledAt?: Date;
  // Whatever the admin making the transfer by hand wants to reference it
  // by later (a bank reference number, a Stripe payout id, …) — optional,
  // since no automated payout rail exists yet to always have one.
  transferReference?: string;
  // Required when marking this failed — same "never just a flipped flag,
  // always say why" instinct declineReason already uses.
  failureReason?: string;
  createdAt: Date;
  updatedAt: Date;
}

const payoutAccountSnapshotSchema = new Schema<IPayoutAccount>(
  {
    accountName: { type: String, required: true },
    accountNumber: { type: String, required: true },
    bankName: { type: String, required: true },
    bankCode: { type: String },
    country: { type: String, required: true },
  },
  { _id: false },
);

const systemPayoutSchema = new Schema<ISystemPayout>(
  {
    requestType: {
      type: String,
      enum: Object.values(SYSTEM_PAYOUT_REQUEST_TYPE),
      required: true,
    },
    targetType: {
      type: String,
      enum: Object.values(SYSTEM_PAYOUT_TARGET_TYPE),
      required: true,
    },
    targetId: { type: Schema.Types.ObjectId, required: true, refPath: "targetType" },
    requestId: { type: Schema.Types.ObjectId, required: true },
    user: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    amount: { type: Number, required: true, min: 0 },
    currency: { ...currencyField, required: true },
    status: {
      type: String,
      enum: Object.values(SYSTEM_PAYOUT_STATUS),
      default: SYSTEM_PAYOUT_STATUS.PENDING,
    },
    settlementMethod: {
      type: String,
      enum: Object.values(SETTLEMENT_METHOD),
      required: true,
    },
    payoutAccount: { type: payoutAccountSnapshotSchema, required: true },
    isLocked: { type: Boolean, default: false },
    lockedAt: { type: Date },
    lockedBy: { type: Schema.Types.ObjectId, ref: "User" },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    settledBy: { type: Schema.Types.ObjectId, ref: "User" },
    settledAt: { type: Date },
    transferReference: { type: String },
    failureReason: { type: String },
  },
  { timestamps: true },
);

systemPayoutSchema.index({ targetType: 1, targetId: 1 });
systemPayoutSchema.index({ status: 1, isLocked: 1 });
// One record per originating request — approving the same refund/payout
// twice is already blocked upstream (PAYMENT_REQUEST_STATUS guards that),
// but this is the hard backstop against ever double-recording one.
systemPayoutSchema.index({ requestId: 1 }, { unique: true });

export const SystemPayout: Model<ISystemPayout> = mongoose.model<ISystemPayout>(
  "SystemPayout",
  systemPayoutSchema,
);
