import mongoose, { Document, Model, Schema } from "mongoose";

export const PLAN_TIER = {
  FREE: "free",
  PRO: "pro",
  ENTERPRISE: "enterprise",
} as const;
export type PlanTier = (typeof PLAN_TIER)[keyof typeof PLAN_TIER];

export interface IPlan extends Document {
  planTier: PlanTier;
  name: string;
  privileges: string[];
  // Subscription length in days — used to compute a Subscription's
  // `expiresAt` from `periodStarted` when it's created/renewed.
  duration: number;
  // Seat cap for the account this plan is attached to — null means
  // unlimited. Not enforced anywhere yet (no team/org model exists), it's
  // just stored on the plan for when that lands.
  maxUsers: number | null;
  price: number;
  currency: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const planSchema = new Schema<IPlan>(
  {
    planTier: {
      type: String,
      required: true,
      unique: true,
      enum: Object.values(PLAN_TIER),
    },
    name: {
      type: String,
      required: [true, "Please add a plan name"],
      trim: true,
    },
    privileges: {
      type: [String],
      default: [],
    },
    duration: {
      type: Number,
      required: [true, "Please add a duration in days"],
      min: 1,
    },
    maxUsers: {
      type: Number,
      default: null,
      min: 1,
    },
    price: {
      type: Number,
      required: true,
      min: 0,
    },
    currency: {
      type: String,
      default: "USD",
      uppercase: true,
      trim: true,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true },
);

export const Plan: Model<IPlan> = mongoose.model<IPlan>("Plan", planSchema);
