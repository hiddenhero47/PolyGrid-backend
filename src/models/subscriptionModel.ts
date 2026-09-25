import mongoose, { Document, Model, Schema, Types } from "mongoose";
import { PLAN_TIER, PlanTier } from "./planModel";

export const SUBSCRIPTION_STATUS = {
  // Checkout has started (a Payment/PaymentIntent exists) but hasn't
  // succeeded yet — a real, queryable state ("who started checkout and
  // never finished"), not just payments plumbing. Never becomes the user's
  // currentSubscription; only a webhook flipping this to ACTIVE does that.
  PENDING: "pending",
  ACTIVE: "active",
  PAST_DUE: "past_due",
  CANCELED: "canceled",
  EXPIRED: "expired",
} as const;
export type SubscriptionStatus =
  (typeof SUBSCRIPTION_STATUS)[keyof typeof SUBSCRIPTION_STATUS];

export interface ISubscription extends Document {
  user: Types.ObjectId;
  plan: Types.ObjectId;
  // Snapshotted from Plan at the time this subscription was created/renewed
  // — so a past subscription's record doesn't change retroactively if the
  // Plan's own privileges/tier get edited later. This is the whole point of
  // splitting Subscription out from User: full, immutable history.
  planTier: PlanTier;
  privileges: string[];
  status: SubscriptionStatus;
  autoRenew: boolean;
  paymentProviderId?: string;
  paymentId?: string;
  periodStarted: Date;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
  isActive(): boolean;
}

const subscriptionSchema = new Schema<ISubscription>(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    plan: {
      type: Schema.Types.ObjectId,
      ref: "Plan",
      required: true,
    },
    planTier: {
      type: String,
      required: true,
      enum: Object.values(PLAN_TIER),
    },
    privileges: {
      type: [String],
      default: [],
    },
    status: {
      type: String,
      enum: Object.values(SUBSCRIPTION_STATUS),
      default: SUBSCRIPTION_STATUS.ACTIVE,
    },
    autoRenew: {
      type: Boolean,
      default: false,
    },
    paymentProviderId: {
      type: String,
    },
    paymentId: {
      type: String,
    },
    periodStarted: {
      type: Date,
      required: true,
      default: () => new Date(),
    },
    expiresAt: {
      type: Date,
      required: true,
      validate: {
        validator: function (this: ISubscription, value: Date) {
          return value > this.periodStarted;
        },
        message: "expiresAt must be after periodStarted",
      },
    },
  },
  { timestamps: true },
);

// A user's history is read most often as "everything, newest first" and
// "what's currently active" — this one compound index covers both.
subscriptionSchema.index({ user: 1, createdAt: -1 });
subscriptionSchema.index({ user: 1, status: 1, expiresAt: 1 });

subscriptionSchema.methods.isActive = function (this: ISubscription): boolean {
  return (
    this.status === SUBSCRIPTION_STATUS.ACTIVE && this.expiresAt.getTime() > Date.now()
  );
};

export const Subscription: Model<ISubscription> = mongoose.model<ISubscription>(
  "Subscription",
  subscriptionSchema,
);
