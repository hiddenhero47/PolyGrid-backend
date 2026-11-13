import mongoose, { Document, Model, Schema, Types } from "mongoose";
import { isValidCountryCode } from "../helpers/countryReference";
import {
  PAYOUT_KYC_METHOD,
  PayoutKycMethod,
  PAYOUT_KYC_ID_TYPE,
  PayoutKycIdType,
  IPayoutKycDocuments,
  payoutKycDocumentSchema,
} from "./payoutKycModel";
import { IdentityVerificationProviderName } from "../providers/identityVerificationProviders/types";

// An append-only bookkeeping log — NOT a live-state model like PayoutKyc
// itself (which only ever holds one record per user, overwritten on
// every resubmission, and deleted outright on revoke). Every time a
// PayoutKyc record actually becomes VERIFIED — an automated match
// succeeding in payoutKycController.ts's submitPayoutKyc, or an admin
// approving a document-track submission in approvePayoutKyc — one entry
// is written here and never touched again, so admins keep a permanent
// record of every verification that ever happened, even after the user
// later revokes their KYC (which clears the live PayoutKyc record, but
// never this history) or gets re-verified under a different name.
//
// `fullName`/`country` are snapshotted here rather than read live off
// the User at report time, precisely because both can legitimately
// change after a revoke+resubmit cycle — this is a record of what was
// true *at the moment this verification happened*, not what's true now.
export interface IPayoutKycHistoryEntry extends Document {
  user: Types.ObjectId;
  fullName: { firstName: string; lastName: string };
  country: string;
  method: PayoutKycMethod;

  // Automated track only.
  idType?: PayoutKycIdType;
  provider?: IdentityVerificationProviderName;
  last4?: string;
  providerReference?: string;

  // Document track only.
  documents?: IPayoutKycDocuments;
  reviewedBy?: Types.ObjectId;

  verifiedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const payoutKycHistorySchema = new Schema<IPayoutKycHistoryEntry>(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    fullName: {
      firstName: { type: String, required: true, trim: true },
      lastName: { type: String, required: true, trim: true },
    },
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

    verifiedAt: { type: Date, required: true },
  },
  { timestamps: true },
);

export const PayoutKycHistory: Model<IPayoutKycHistoryEntry> = mongoose.model<IPayoutKycHistoryEntry>(
  "PayoutKycHistory",
  payoutKycHistorySchema,
);
