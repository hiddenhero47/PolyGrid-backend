import mongoose, { Document, Model, Schema, Types } from "mongoose";
import { isValidCurrencyCode } from "../helpers/currencyReference";
import { IMediaFile, mediaFileSchema } from "./mediaFile";

// A contractor's bid on a TenderProject — sealed from every other
// contractor (see tenderProjectModel.ts); only the project's own poster
// ever sees the full list (tenderProjectController.getProjectBids).
export const BID_STATUS = {
  PENDING: "pending",
  ACCEPTED: "accepted",
  REJECTED: "rejected",
  WITHDRAWN: "withdrawn",
} as const;
export type BidStatus = (typeof BID_STATUS)[keyof typeof BID_STATUS];

// Same cap reasoning as every other media array in this codebase.
export const MAX_BID_FILES = 5;

export interface IBid extends Document {
  project: Types.ObjectId;
  contractorId: Types.ObjectId;
  // Denormalized for convenience (checking "is this bid mine" without a
  // second lookup through ContractorProfile) — same reasoning
  // DigitalPurchase.buyer+creator both being stored already established.
  bidder: Types.ObjectId;
  amount: number;
  currency: string;
  proposal: string;
  estimatedDurationDays?: number;
  files: IMediaFile[];
  status: BidStatus;
  createdAt: Date;
  updatedAt: Date;
}

const bidSchema = new Schema<IBid>(
  {
    project: { type: Schema.Types.ObjectId, ref: "TenderProject", required: true },
    contractorId: { type: Schema.Types.ObjectId, ref: "ContractorProfile", required: true },
    bidder: { type: Schema.Types.ObjectId, ref: "User", required: true },
    amount: { type: Number, required: true, min: 0 },
    currency: {
      type: String,
      default: "USD",
      uppercase: true,
      trim: true,
      validate: {
        validator: isValidCurrencyCode,
        message: (props: { value: string }) => `${props.value} is not a recognized ISO 4217 currency code`,
      },
    },
    proposal: { type: String, required: [true, "Please add a proposal"] },
    estimatedDurationDays: { type: Number, min: 1 },
    files: {
      type: [mediaFileSchema],
      default: [],
      validate: {
        validator: (files: IMediaFile[]) => files.length <= MAX_BID_FILES,
        message: `A bid can have at most ${MAX_BID_FILES} attached files`,
      },
    },
    status: {
      type: String,
      enum: Object.values(BID_STATUS),
      default: BID_STATUS.PENDING,
    },
  },
  { timestamps: true },
);

// One bid per contractor per project — a revision goes through
// updateMyBid, not a second bid.
bidSchema.index({ project: 1, contractorId: 1 }, { unique: true });
bidSchema.index({ contractorId: 1, createdAt: -1 });

export const Bid: Model<IBid> = mongoose.model<IBid>("Bid", bidSchema);
