import mongoose, { Document, Model, Schema } from "mongoose";
import crypto from "crypto";

export const SYSTEM_ROLE = {
  SUPER_ADMIN: "super_admin",
  ADMIN: "admin",
  USER: "user",
} as const;
export type SystemRole = (typeof SYSTEM_ROLE)[keyof typeof SYSTEM_ROLE];

export const ACCOUNT_TYPE = {
  NORMAL: "normal",
  BUSINESS: "business",
} as const;
export type AccountType = (typeof ACCOUNT_TYPE)[keyof typeof ACCOUNT_TYPE];

export const PLAN_TIER = {
  FREE: "free",
  PRO: "pro",
  ENTERPRISE: "enterprise",
} as const;
export type PlanTier = (typeof PLAN_TIER)[keyof typeof PLAN_TIER];

export const SUBSCRIPTION_STATUS = {
  ACTIVE: "active",
  PAST_DUE: "past_due",
  CANCELED: "canceled",
  EXPIRED: "expired",
} as const;
export type SubscriptionStatus =
  (typeof SUBSCRIPTION_STATUS)[keyof typeof SUBSCRIPTION_STATUS];

export const TOKENS = {
  RESET: "resetPassword",
} as const;

export interface ISubscription {
  planTier: PlanTier;
  status: SubscriptionStatus;
  currentPeriodStart: Date;
  expiresAt: Date;
  autoRenew: boolean;
  paymentProviderId?: string;
}

export interface ITokenEntry {
  code: string;
  expiresAt: Date;
}

export interface IUser extends Document {
  fullName: string;
  email: string;
  password: string;
  phone?: string;
  systemRole: SystemRole;
  activeAccountType: AccountType;
  subscription: ISubscription;
  tokenCache: Map<string, ITokenEntry>;
  sessionId: string;
  createdAt: Date;
  updatedAt: Date;
  // Internal, non-persisted flag — set explicitly by trusted server code
  // (registerAdmin/changeUserRole) to bypass the admin-creation guard below.
  _adminCreation?: boolean;
  hasActiveSubscription(): boolean;
}

const tokenEntrySchema = new Schema<ITokenEntry>(
  {
    code: { type: String, required: true },
    expiresAt: { type: Date, required: true },
  },
  { _id: false },
);

const subscriptionSchema = new Schema<ISubscription>(
  {
    planTier: {
      type: String,
      enum: Object.values(PLAN_TIER),
      default: PLAN_TIER.FREE,
    },
    status: {
      type: String,
      enum: Object.values(SUBSCRIPTION_STATUS),
      default: SUBSCRIPTION_STATUS.EXPIRED,
    },
    currentPeriodStart: { type: Date, default: () => new Date() },
    expiresAt: { type: Date, default: () => new Date() },
    autoRenew: { type: Boolean, default: false },
    paymentProviderId: { type: String },
  },
  { _id: false },
);

const userSchema = new Schema<IUser>(
  {
    fullName: {
      type: String,
      required: [true, "Please add a full name"],
      trim: true,
    },
    email: {
      type: String,
      required: [true, "Please add an email"],
      unique: true,
      lowercase: true,
      trim: true,
    },
    password: {
      type: String,
      required: [true, "Please add a password"],
    },
    phone: {
      type: String,
      trim: true,
    },
    systemRole: {
      type: String,
      default: SYSTEM_ROLE.USER,
      enum: Object.values(SYSTEM_ROLE),
    },
    activeAccountType: {
      type: String,
      default: ACCOUNT_TYPE.NORMAL,
      enum: Object.values(ACCOUNT_TYPE),
    },
    subscription: {
      type: subscriptionSchema,
      default: () => ({}),
    },
    tokenCache: {
      type: Map,
      of: tokenEntrySchema,
      default: {},
    },
    sessionId: {
      type: String,
      default: () => crypto.randomUUID(),
    },
  },
  { timestamps: true },
);

userSchema.index({ sessionId: 1 });
userSchema.index({ "subscription.status": 1, "subscription.expiresAt": 1 });

userSchema.methods.hasActiveSubscription = function (this: IUser): boolean {
  return (
    this.subscription.status === SUBSCRIPTION_STATUS.ACTIVE &&
    this.subscription.expiresAt.getTime() > Date.now()
  );
};

// Mirrors house-maduekwe-backend's userModel guard: enforce a single Super
// Admin and block direct Admin creation unless a trusted caller has set the
// transient `_adminCreation` flag on the document before saving.
userSchema.pre("save", async function (next) {
  const User = mongoose.model<IUser>("User");

  try {
    if (!this.isNew && !this.isModified("systemRole")) {
      return next();
    }

    if (this.systemRole === SYSTEM_ROLE.SUPER_ADMIN) {
      const existingSuperAdmin = await User.exists({
        systemRole: SYSTEM_ROLE.SUPER_ADMIN,
      });

      if (existingSuperAdmin || !this._adminCreation) {
        const error: Error & { statusCode?: number } = new Error(
          "Only one Super Admin can exist in the system",
        );
        error.statusCode = 403;
        return next(error);
      }
    }

    if (this.systemRole === SYSTEM_ROLE.ADMIN && !this._adminCreation) {
      const error: Error & { statusCode?: number } = new Error(
        "Admin creation not allowed",
      );
      error.statusCode = 403;
      return next(error);
    }

    next();
  } catch (err) {
    next(err as Error);
  }
});

export const User: Model<IUser> = mongoose.model<IUser>("User", userSchema);
