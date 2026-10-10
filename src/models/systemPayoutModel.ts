import mongoose, { Document, Model, Schema, Types } from "mongoose";
import { PAYMENT_TARGET_TYPE, PaymentTargetType } from "./paymentModel";
import { IPayoutAccount } from "./userModel";
import { isValidCurrencyCode } from "../helpers/currencyReference";

// The ledger of money PolyGrid actually owes someone (a provider's
// approved payout, or a client's approved refund) once an admin has
// signed off on it — created the moment jobController's
// approveRefundRequest/approvePayoutRequest runs, never before. Distinct
// from Payment (money moving *into* PolyGrid) and from Job's own
// refunds/payouts sub-documents (the *request*, still just an ask until
// approved) — this is the record of what's now actually owed and where
// it should go. No automated payout rail exists yet (see REQUEST_TYPE's
// own comment) — for now this is purely a record admin/finance ops reads
// to go move the money by hand; `isLocked` exists so whoever's processing
// a batch by hand can mark one as claimed without a DB transaction.
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

export interface ISystemPayout extends Document {
  requestType: SystemPayoutRequestType;
  // Polymorphic the same way Payment.targetType/targetId is — "Job" is
  // the only real value today (a store/siteforce/tenders/engineering
  // payout or refund is always a Job underneath), kept open rather than
  // hardcoded for whatever a future non-Job-backed payout target turns
  // out to be.
  targetType: PaymentTargetType;
  targetId: Types.ObjectId;
  // The specific Job.refunds[]/Job.payouts[] sub-document this came from
  // — traceability back to the original request/approval, not a second
  // source of truth for the amount (that's snapshotted below).
  requestId: Types.ObjectId;
  // Who actually receives the money — the job's client for a refund, its
  // provider for a payout.
  user: Types.ObjectId;
  amount: number;
  currency: string;
  status: SystemPayoutStatus;
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
      enum: Object.values(PAYMENT_TARGET_TYPE),
      required: true,
    },
    targetId: { type: Schema.Types.ObjectId, required: true, refPath: "targetType" },
    requestId: { type: Schema.Types.ObjectId, required: true },
    user: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    amount: { type: Number, required: true, min: 0 },
    currency: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      validate: {
        validator: isValidCurrencyCode,
        message: (props: { value: string }) => `${props.value} is not a recognized ISO 4217 currency code`,
      },
    },
    status: {
      type: String,
      enum: Object.values(SYSTEM_PAYOUT_STATUS),
      default: SYSTEM_PAYOUT_STATUS.PENDING,
    },
    payoutAccount: { type: payoutAccountSnapshotSchema, required: true },
    isLocked: { type: Boolean, default: false },
    lockedAt: { type: Date },
    lockedBy: { type: Schema.Types.ObjectId, ref: "User" },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
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
