import mongoose, { Document, Model, Schema, Types } from "mongoose";
import { isValidCountryCode, isValidStateCode } from "../helpers/countryReference";
import { isValidCurrencyCode } from "../helpers/currencyReference";
import { IMediaFile, mediaFileSchema } from "./mediaFile";
import { LABOR_SKILL, LaborSkill } from "./laborProfileModel";

// PolyGrid SiteForce's Location-Based Job Board — see docs/siteforce-plan.md.
// Deliberately NOT the same model as PolyGrid's own escrow `Job` — this is
// a job *opening* (a listing, like a classified ad), closer in shape to
// TenderProject than to Job. `category` reuses LABOR_SKILL directly
// (not a near-duplicate enum) — "what skill is needed" and "what skill a
// worker has" are the same vocabulary, which is what makes matching work
// at all.
//
// The one thing genuinely different from TenderProject: location is
// split into two tiers. `generalArea` (country/state/city) is always
// visible to any eligible worker browsing the board; `coordinates`/
// `address`/`googleMapsUrl`/`contactInfo`/`files` are withheld until a
// worker's application is actually ACCEPTED (see
// jobOpeningController.getJobOpening) — not merely eligible to apply, not
// merely having applied. A worker very often shows up alone, unlike a
// contractor (who brings their own crew) or a shop owner's shipment (who
// sends their own people) — so exact location/contact genuinely shouldn't
// be handed to every eligible browser the way a Tenders project's full
// detail is.
export const PAY_TYPE = {
  HOURLY: "hourly",
  DAILY: "daily",
  FIXED: "fixed",
} as const;
export type PayType = (typeof PAY_TYPE)[keyof typeof PAY_TYPE];

export const EMPLOYMENT_TYPE = {
  SHORT_TERM: "short_term",
  LONG_TERM: "long_term",
} as const;
export type EmploymentType = (typeof EMPLOYMENT_TYPE)[keyof typeof EMPLOYMENT_TYPE];

export const JOB_OPENING_STATUS = {
  OPEN: "open",
  FILLED: "filled",
  CLOSED: "closed",
  CANCELLED: "cancelled",
} as const;
export type JobOpeningStatus = (typeof JOB_OPENING_STATUS)[keyof typeof JOB_OPENING_STATUS];

export const MAX_OPENING_FILES = 10;

export interface IGeneralArea {
  country: string;
  state?: string;
  city?: string;
}

export interface ICoordinates {
  lat: number;
  lng: number;
}

export interface IJobOpening extends Document {
  postedBy: Types.ObjectId;
  title: string;
  description: string;
  category: LaborSkill;
  // How many workers this one listing is looking for — each accepted
  // application spins up its own Job (one worker, one escrow), and the
  // listing only moves to `filled` once `filledCount` reaches this.
  workersNeeded: number;
  filledCount: number;
  payRate: number;
  payType: PayType;
  currency: string;
  employmentType: EmploymentType;
  generalArea: IGeneralArea;
  // Gated — see the file-level comment above.
  coordinates?: ICoordinates;
  address?: string;
  googleMapsUrl?: string;
  contactInfo?: string;
  files: IMediaFile[];
  applicationDeadline?: Date;
  status: JobOpeningStatus;
  createdAt: Date;
  updatedAt: Date;
}

const generalAreaSchema = new Schema<IGeneralArea>(
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
    city: { type: String, trim: true },
  },
  { _id: false },
);

generalAreaSchema.path("state").validate(function (this: IGeneralArea, value?: string) {
  if (!value) return true;
  return isValidStateCode(this.country, value);
}, "state is not a recognized state/province for this country");

const coordinatesSchema = new Schema<ICoordinates>(
  {
    lat: { type: Number, required: true, min: -90, max: 90 },
    lng: { type: Number, required: true, min: -180, max: 180 },
  },
  { _id: false },
);

const jobOpeningSchema = new Schema<IJobOpening>(
  {
    postedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    title: { type: String, required: [true, "Please add a title"], trim: true },
    description: { type: String, required: [true, "Please add a description"] },
    category: { type: String, enum: Object.values(LABOR_SKILL), required: true },
    workersNeeded: { type: Number, default: 1, min: 1 },
    filledCount: { type: Number, default: 0, min: 0 },
    payRate: { type: Number, required: true, min: 0 },
    payType: { type: String, enum: Object.values(PAY_TYPE), required: true },
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
    employmentType: { type: String, enum: Object.values(EMPLOYMENT_TYPE), required: true },
    generalArea: { type: generalAreaSchema, required: true },
    coordinates: { type: coordinatesSchema },
    address: { type: String },
    googleMapsUrl: { type: String },
    contactInfo: { type: String },
    files: {
      type: [mediaFileSchema],
      default: [],
      validate: {
        validator: (files: IMediaFile[]) => files.length <= MAX_OPENING_FILES,
        message: `A job opening can have at most ${MAX_OPENING_FILES} attached files`,
      },
    },
    applicationDeadline: { type: Date },
    status: {
      type: String,
      enum: Object.values(JOB_OPENING_STATUS),
      default: JOB_OPENING_STATUS.OPEN,
    },
  },
  { timestamps: true },
);

jobOpeningSchema.index({ status: 1, category: 1, createdAt: -1 });
jobOpeningSchema.index({ postedBy: 1, createdAt: -1 });

export const JobOpening: Model<IJobOpening> = mongoose.model<IJobOpening>(
  "JobOpening",
  jobOpeningSchema,
);
