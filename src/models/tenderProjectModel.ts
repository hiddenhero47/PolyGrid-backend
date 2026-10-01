import mongoose, { Document, Model, Schema, Types } from "mongoose";
import { isValidCountryCode, isValidStateCode } from "../helpers/countryReference";
import { isValidCurrencyCode } from "../helpers/currencyReference";
import { IMediaFile, mediaFileSchema } from "./mediaFile";

// PolyGrid Tenders' Project Bidding Board — see docs/tenders-plan.md.
// Posting requires any active PolyGrid subscription (requireActiveSubscription,
// checked on the poster's own User — there's no dedicated "poster" business
// profile the way a contractor has ContractorProfile); bidding requires a
// verified + currently-subscribed ContractorProfile. Bidding is sealed —
// a contractor only ever sees their own bid (see bidModel.ts); the poster
// sees every bid on their own project.
export const TENDER_CATEGORY = {
  GENERAL_CONTRACTING: "general_contracting",
  STRUCTURAL: "structural",
  ELECTRICAL: "electrical",
  PLUMBING: "plumbing",
  ROOFING: "roofing",
  ARCHITECTURAL_DESIGN: "architectural_design",
  EXCAVATION_EARTHWORKS: "excavation_earthworks",
  HVAC: "hvac",
  MASONRY: "masonry",
  CARPENTRY: "carpentry",
  PAINTING_FINISHING: "painting_finishing",
  LANDSCAPING: "landscaping",
  OTHER: "other",
} as const;
export type TenderCategory = (typeof TENDER_CATEGORY)[keyof typeof TENDER_CATEGORY];

export const TENDER_PROJECT_STATUS = {
  OPEN: "open",
  AWARDED: "awarded",
  CLOSED: "closed",
  CANCELLED: "cancelled",
} as const;
export type TenderProjectStatus = (typeof TENDER_PROJECT_STATUS)[keyof typeof TENDER_PROJECT_STATUS];

// Same cap reasoning as every other media array in this codebase —
// unbounded attachments mean unbounded disk usage with no real ceiling.
export const MAX_PROJECT_FILES = 10;

export interface IProjectLocation {
  country: string;
  state?: string;
}

export interface ITenderProject extends Document {
  postedBy: Types.ObjectId;
  title: string;
  description: string;
  category: TenderCategory;
  // Both optional — a poster can legitimately decline to disclose a
  // budget at all (common in real tenders, to avoid bids converging on a
  // revealed number). Set both equal for a fixed, disclosed budget.
  budgetMin?: number;
  budgetMax?: number;
  currency: string;
  location: IProjectLocation;
  // Specs/drawings/site photos — private: full project detail (this
  // field included) is only ever shown to the poster, an eligible
  // contractor, or an admin (see tenderProjectController.getTenderProject),
  // never a public preview.
  files: IMediaFile[];
  bidDeadline: Date;
  status: TenderProjectStatus;
  // Running count of active (non-withdrawn, non-rejected) bids — the one
  // thing a competing contractor is allowed to see about other bids
  // ("12 bids so far"), never the amounts or identities behind it. Kept
  // as a running total rather than counting Bid documents on every read,
  // same "denormalized running total" pattern as Job's own ledger fields.
  bidCount: number;
  awardedBid?: Types.ObjectId;
  job?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const projectLocationSchema = new Schema<IProjectLocation>(
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
    state: { type: String, uppercase: true, trim: true },
  },
  { _id: false },
);

// `this` is the location subdocument (a plain function, not an arrow, so
// Mongoose can bind it) — a state only makes sense alongside its own
// country, same resolveShippingLocations-style check used for Product's
// shipping locations.
projectLocationSchema.path("state").validate(function (this: IProjectLocation, value?: string) {
  if (!value) return true;
  return isValidStateCode(this.country, value);
}, "state is not a recognized state/province for this country");

const tenderProjectSchema = new Schema<ITenderProject>(
  {
    postedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    title: { type: String, required: [true, "Please add a title"], trim: true },
    description: { type: String, required: [true, "Please add a description"] },
    category: { type: String, enum: Object.values(TENDER_CATEGORY), required: true },
    budgetMin: { type: Number, min: 0 },
    budgetMax: { type: Number, min: 0 },
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
    location: { type: projectLocationSchema, required: true },
    files: {
      type: [mediaFileSchema],
      default: [],
      validate: {
        validator: (files: IMediaFile[]) => files.length <= MAX_PROJECT_FILES,
        message: `A project can have at most ${MAX_PROJECT_FILES} attached files`,
      },
    },
    bidDeadline: { type: Date, required: [true, "Please add a bid deadline"] },
    status: {
      type: String,
      enum: Object.values(TENDER_PROJECT_STATUS),
      default: TENDER_PROJECT_STATUS.OPEN,
    },
    bidCount: { type: Number, default: 0, min: 0 },
    awardedBid: { type: Schema.Types.ObjectId, ref: "Bid" },
    job: { type: Schema.Types.ObjectId, ref: "Job" },
  },
  { timestamps: true },
);

tenderProjectSchema.index({ status: 1, category: 1, createdAt: -1 });
tenderProjectSchema.index({ postedBy: 1, createdAt: -1 });

export const TenderProject: Model<ITenderProject> = mongoose.model<ITenderProject>(
  "TenderProject",
  tenderProjectSchema,
);
