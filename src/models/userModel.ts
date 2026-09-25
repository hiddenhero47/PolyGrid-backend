import mongoose, { Document, Model, Schema, Types } from "mongoose";
import crypto from "crypto";
import { isValidCountryCode } from "../helpers/countryReference";

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

export const AUTH_PROVIDER = {
  LOCAL: "local",
  GOOGLE: "google",
  APPLE: "apple",
} as const;
export type AuthProviderName = (typeof AUTH_PROVIDER)[keyof typeof AUTH_PROVIDER];

export interface ITokenEntry {
  code: string;
  expiresAt: Date;
}

export interface IPhoneNumber {
  number?: string;
  country?: string;
}

export interface IAuthProvider {
  provider: AuthProviderName;
  providerId: string;
}

// Set via fileStorage.uploadHandler (see userController.updateUserProfile)
// — always visibility: 'public', so `url` is always populated once set.
// `storagePath` is kept so a replaced avatar's old file can be deleted; it's
// stripped before this ever reaches a client response (see toPublicUser).
export interface IAvatar {
  fileName: string;
  storagePath: string;
  mime: string;
  size: number;
  url?: string;
}

// Loosely typed to match the schema's `type: Object` — 2FA setup isn't
// implemented yet (no otplib/qrcode wiring), this just reserves the shape
// house-maduekwe-backend uses (`secret`/`tempSecret`) for when it is.
export interface IUser2fa {
  enable: boolean;
  secret?: string;
  tempSecret?: string;
}

export interface IUser extends Document {
  fullName: string;
  email: string;
  password: string;
  phoneNumber?: IPhoneNumber;
  avatar?: IAvatar;
  authProviders: IAuthProvider[];
  verified: boolean;
  user2fa: IUser2fa;
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
    phoneNumber: {
      number: {
        type: String,
        trim: true,
      },
      country: {
        type: String,
        uppercase: true,
        trim: true,
        // Was a bare 2-letter regex before — matched the shape of a
        // country code without checking it was a real one (e.g. "ZZ"
        // passed). Now checked against actual ISO 3166-1 reference data.
        validate: {
          validator: (value: string) => !value || isValidCountryCode(value),
          message: (props: { value: string }) => `${props.value} is not a recognized ISO country code`,
        },
      },
    },
    avatar: {
      type: Object,
    },
    authProviders: [
      {
        provider: {
          type: String,
          enum: Object.values(AUTH_PROVIDER),
          required: true,
          index: false,
        },
        providerId: {
          type: String,
          required: true,
          index: false,
        },
      },
    ],
    verified: {
      type: Boolean,
      default: false,
    },
    user2fa: {
      type: Object,
      default: { enable: false },
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
