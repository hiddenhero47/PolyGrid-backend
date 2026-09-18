import mongoose, { Document, Model, Schema, Types } from "mongoose";
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

export const TOKENS = {
  RESET: "resetPassword",
} as const;

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
  // Points at this user's most recent Subscription record — null until they
  // ever subscribe. Full history lives in the Subscription collection (see
  // subscriptionModel.ts); this is just a fast pointer to "the current one".
  currentSubscription: Types.ObjectId | null;
  tokenCache: Map<string, ITokenEntry>;
  sessionId: string;
  createdAt: Date;
  updatedAt: Date;
  // Internal, non-persisted flag — set explicitly by trusted server code
  // (registerAdmin/changeUserRole) to bypass the admin-creation guard below.
  _adminCreation?: boolean;
}

const tokenEntrySchema = new Schema<ITokenEntry>(
  {
    code: { type: String, required: true },
    expiresAt: { type: Date, required: true },
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
    currentSubscription: {
      type: Schema.Types.ObjectId,
      ref: "Subscription",
      default: null,
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
