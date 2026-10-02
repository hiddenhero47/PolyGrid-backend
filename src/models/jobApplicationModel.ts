import mongoose, { Document, Model, Schema, Types } from "mongoose";

// A worker's application to a JobOpening — the SiteForce equivalent of a
// Tenders Bid, but without a price: pay is fixed by the poster (see
// jobOpeningModel.ts), so an applicant is just saying "I'll do this,"
// not competing on rate. Less secrecy-sensitive than a sealed bid (no
// amount to hide), but still kept private to the poster — an applicant's
// identity shouldn't be handed to other applicants either.
export const APPLICATION_STATUS = {
  PENDING: "pending",
  ACCEPTED: "accepted",
  REJECTED: "rejected",
  WITHDRAWN: "withdrawn",
} as const;
export type ApplicationStatus = (typeof APPLICATION_STATUS)[keyof typeof APPLICATION_STATUS];

export interface IJobApplication extends Document {
  posting: Types.ObjectId;
  workerId: Types.ObjectId;
  // Denormalized for convenience, same reasoning as Bid.bidder.
  applicant: Types.ObjectId;
  message?: string;
  status: ApplicationStatus;
  // Set once accepted — the Job this application turned into.
  job?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const jobApplicationSchema = new Schema<IJobApplication>(
  {
    posting: { type: Schema.Types.ObjectId, ref: "JobOpening", required: true },
    workerId: { type: Schema.Types.ObjectId, ref: "LaborProfile", required: true },
    applicant: { type: Schema.Types.ObjectId, ref: "User", required: true },
    message: { type: String },
    status: {
      type: String,
      enum: Object.values(APPLICATION_STATUS),
      default: APPLICATION_STATUS.PENDING,
    },
    job: { type: Schema.Types.ObjectId, ref: "Job" },
  },
  { timestamps: true },
);

// One application per worker per posting — a revision would go through
// updating this one, not a second application.
jobApplicationSchema.index({ posting: 1, workerId: 1 }, { unique: true });
jobApplicationSchema.index({ workerId: 1, createdAt: -1 });

export const JobApplication: Model<IJobApplication> = mongoose.model<IJobApplication>(
  "JobApplication",
  jobApplicationSchema,
);
