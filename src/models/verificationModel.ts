import mongoose, { Document, Model, Schema, Types } from "mongoose";
import { isValidCountryCode, isValidStateCode } from "../helpers/countryReference";

// The KYC/verification submission — deliberately its own model, not
// embedded on a profile, for two reasons: (1) it's genuinely reusable
// across every future pillar profile (Contractor, Store, Labor — see
// profileType below), not just ConsultancyProfile; (2) a profile can be
// verified more than once over its life (rejected -> resubmitted ->
// approved), and each submission stays a permanent record rather than
// being overwritten — same "history, not mutation" instinct as
// Subscription/Job stages elsewhere in this codebase. A profile's
// `isVerified`/`verification` pointer always reflects only the *latest*
// submission; earlier ones (including rejections) remain queryable here.
export const VERIFICATION_STATUS = {
  PENDING: "pending",
  APPROVED: "approved",
  REJECTED: "rejected",
} as const;
export type VerificationStatus = (typeof VERIFICATION_STATUS)[keyof typeof VERIFICATION_STATUS];

// No 'unverified' status value — a profile with no Verification document at
// all *is* unverified. Modeling that as a stored enum value with nothing
// behind it would just be a state that means "no record exists," which the
// absence of a record already means for free.
export interface IVerificationDocument {
  type: string; // e.g. "business_certificate" — matches a VerificationTemplate.documents[].type
  fileName: string; // a private file this user already owns (see fileStorage.ts)
  // Snapshotted from the real file at submission time (magic bytes, not the
  // fileName's extension — see fileStorage.getPrivateFileMetadata) — not
  // just a label. Also doubles as the existence/ownership check: a fileName
  // that doesn't resolve to a real file under this user's private folder is
  // rejected before a Verification is ever created.
  mime: string;
  size: number;
  uploadedAt: Date;
}

export interface IVerificationLocation {
  country: string; // ISO 3166-1 alpha-2, e.g. "NG"
  state?: string; // region/state, where a country's template varies by it
}

export interface IVerification extends Document {
  // Polymorphic, same refPath pattern as Payment.targetType/targetId —
  // resolves to whichever pillar profile model this verification is for.
  profileType: string;
  profileId: Types.ObjectId;
  user: Types.ObjectId;
  location: IVerificationLocation;
  // The exact VerificationTemplate version this submission was validated
  // against (see verificationTemplateModel.ts) — kept even if an admin
  // later supersedes it with a new version, so this record stays
  // interpretable against the rules that actually applied at submission
  // time.
  templateId: Types.ObjectId;
  // Whatever templateId.fields defined, validated + cast against that exact
  // schema at submission time. Deliberately not a per-country hardcoded set
  // of columns (an earlier version of this had regulatoryBody/
  // registrationNumber fields baked in for Nigeria specifically) — what's
  // actually being asked for is entirely template-driven now.
  form: Record<string, unknown>;
  documents: IVerificationDocument[];
  status: VerificationStatus;
  submittedAt: Date;
  reviewedBy?: Types.ObjectId;
  reviewedAt?: Date;
  rejectionReason?: string;
  createdAt: Date;
  updatedAt: Date;
}

const verificationDocumentSchema = new Schema<IVerificationDocument>(
  {
    type: { type: String, required: true },
    fileName: { type: String, required: true },
    mime: { type: String, required: true },
    size: { type: Number, required: true },
    uploadedAt: { type: Date, required: true },
  },
  { _id: false },
);

const verificationLocationSchema = new Schema<IVerificationLocation>(
  {
    country: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      validate: {
        validator: isValidCountryCode,
        message: (props: { value: string }) => `${props.value} is not a recognized ISO country code`,
      },
    },
    state: {
      type: String,
      trim: true,
      uppercase: true,
      validate: {
        validator: function (this: IVerificationLocation, value: string | undefined) {
          if (!value) return true;
          return isValidStateCode(this.country, value);
        },
        message: "Not a recognized state/province for this country",
      },
    },
  },
  { _id: false },
);

const verificationSchema = new Schema<IVerification>(
  {
    profileType: { type: String, required: true },
    profileId: { type: Schema.Types.ObjectId, required: true, refPath: "profileType" },
    user: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    location: { type: verificationLocationSchema, required: true },
    templateId: { type: Schema.Types.ObjectId, ref: "VerificationTemplate", required: true },
    form: { type: Object, default: {} },
    documents: { type: [verificationDocumentSchema], default: [] },
    status: {
      type: String,
      enum: Object.values(VERIFICATION_STATUS),
      default: VERIFICATION_STATUS.PENDING,
    },
    submittedAt: { type: Date, default: () => new Date() },
    reviewedBy: { type: Schema.Types.ObjectId, ref: "User" },
    reviewedAt: { type: Date },
    rejectionReason: { type: String },
  },
  { timestamps: true },
);

verificationSchema.index({ profileType: 1, profileId: 1, createdAt: -1 });
verificationSchema.index({ status: 1, createdAt: -1 });

export const Verification: Model<IVerification> = mongoose.model<IVerification>(
  "Verification",
  verificationSchema,
);
