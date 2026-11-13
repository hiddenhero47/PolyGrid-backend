import mongoose, { Document, Model, Schema, Types } from "mongoose";
import { isValidCountryCode } from "../helpers/countryReference";
import { IVerificationDocument } from "./verificationModel";
import { IdentityVerificationProviderName } from "../providers/identityVerificationProviders/types";

// A brand-new, dedicated concept — NOT the Verification/VerificationTemplate
// system (that one is marketplace-trust profile credentials, e.g. "is this
// a real consultancy"; this one is "is this person who they say they are
// before PolyGrid lets an admin approve sending them money" — see
// jobController.ts's createSystemPayout and
// digitalCreatorProfileController.ts's requestDigitalCreatorPayout, the two
// places that gate on PayoutKyc.status === "verified"). One record per
// user — a fresh submission replaces it (unlike Verification's permanent
// history), since there's only ever one live answer to "is this user
// payout-KYC verified right now."
//
// Two tracks, decided by the user's own country via
// SystemSettings.countryKycProviders at submission time (see
// payoutKycController.ts): BVN/NIN only exist for Nigeria, so any other
// country falls back to a document check instead.
export const PAYOUT_KYC_METHOD = {
  // Number + name match against a real vendor (Dojah today) — instant
  // result, no documents, no admin review; the vendor's match result
  // *is* the decision.
  AUTOMATED: "automated",
  // 3 fixed images (ID front, ID back, a face/selfie) — admin-reviewed,
  // since there's no automated match to decide it instead.
  DOCUMENT: "document",
} as const;
export type PayoutKycMethod = (typeof PAYOUT_KYC_METHOD)[keyof typeof PAYOUT_KYC_METHOD];

export const PAYOUT_KYC_STATUS = {
  PENDING: "pending",
  VERIFIED: "verified",
  FAILED: "failed",
} as const;
export type PayoutKycStatus = (typeof PAYOUT_KYC_STATUS)[keyof typeof PAYOUT_KYC_STATUS];

export const PAYOUT_KYC_ID_TYPE = {
  BVN: "bvn",
  NIN: "nin",
} as const;
export type PayoutKycIdType = (typeof PAYOUT_KYC_ID_TYPE)[keyof typeof PAYOUT_KYC_ID_TYPE];

// Always exactly these 3 slots, regardless of country — fixed, not a
// VerificationTemplate-style per-country catalog, since the user wants a
// flat "front, back, face" requirement everywhere the document track
// applies.
export interface IPayoutKycDocuments {
  idFront?: IVerificationDocument;
  idBack?: IVerificationDocument;
  face?: IVerificationDocument;
}

export interface IPayoutKyc extends Document {
  user: Types.ObjectId;
  country: string; // ISO 3166-1 alpha-2, snapshotted from User.country at submission time
  method: PayoutKycMethod;

  // Automated track only.
  idType?: PayoutKycIdType;
  provider?: IdentityVerificationProviderName;
  // Masked tail of the submitted number, for support/admin reference
  // only — the number itself is never stored (see payoutKycController.ts).
  last4?: string;
  providerReference?: string;

  // Document track only.
  documents?: IPayoutKycDocuments;
  reviewedBy?: Types.ObjectId;
  reviewedAt?: Date;
  rejectionReason?: string;

  status: PayoutKycStatus;
  verifiedAt?: Date;
  failureReason?: string;

  createdAt: Date;
  updatedAt: Date;
}

// Exported so payoutKycHistoryModel.ts can reuse the same sub-schema
// shape for its own (document-track) snapshot, rather than redefining it.
export const payoutKycDocumentSchema = new Schema<IVerificationDocument>(
  {
    type: { type: String, required: true },
    fileName: { type: String, required: true },
    mime: { type: String, required: true },
    size: { type: Number, required: true },
    uploadedAt: { type: Date, required: true },
  },
  { _id: false },
);

const payoutKycSchema = new Schema<IPayoutKyc>(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true, unique: true },
    country: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      validate: { validator: isValidCountryCode, message: "Not a recognized ISO country code" },
    },
    method: { type: String, required: true, enum: Object.values(PAYOUT_KYC_METHOD) },

    idType: { type: String, enum: Object.values(PAYOUT_KYC_ID_TYPE) },
    provider: { type: String },
    last4: { type: String },
    providerReference: { type: String },

    documents: {
      idFront: { type: payoutKycDocumentSchema },
      idBack: { type: payoutKycDocumentSchema },
      face: { type: payoutKycDocumentSchema },
    },
    reviewedBy: { type: Schema.Types.ObjectId, ref: "User" },
    reviewedAt: { type: Date },
    rejectionReason: { type: String },

    status: {
      type: String,
      required: true,
      enum: Object.values(PAYOUT_KYC_STATUS),
      default: PAYOUT_KYC_STATUS.PENDING,
    },
    verifiedAt: { type: Date },
    failureReason: { type: String },
  },
  { timestamps: true },
);

export const PayoutKyc: Model<IPayoutKyc> = mongoose.model<IPayoutKyc>("PayoutKyc", payoutKycSchema);
