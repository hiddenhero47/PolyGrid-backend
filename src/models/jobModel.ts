import mongoose, { Document, Model, Schema, Types } from "mongoose";
import { isValidCurrencyCode } from "../helpers/currencyReference";

export const JOB_TYPE = {
  ENGINEERING: "engineering",
  TENDERS: "tenders",
  STORE: "store",
  SITEFORCE: "siteforce",
  OTHER: "other",
} as const;
export type JobType = (typeof JOB_TYPE)[keyof typeof JOB_TYPE];

export const JOB_STATUS = {
  PENDING_CONFIRMATION: "pending_confirmation",
  ACTIVE: "active",
  COMPLETED: "completed",
  DISPUTED: "disputed",
  CANCELLED: "cancelled",
} as const;
export type JobStatus = (typeof JOB_STATUS)[keyof typeof JOB_STATUS];

export interface IJobStage {
  _id: Types.ObjectId;
  details: string[];
  // Provider's claim that this stage's work is done.
  isDone: boolean;
  // Client's confirmation of that claim — only this releases the stage's
  // payment share. Enforced (in jobController) to require isDone first.
  isVerified: boolean;
  // Percentage (0-100) of totalAmount this stage releases once verified.
  payment: number;
}

export interface IProposedStages {
  stages: IJobStage[];
  proposedBy: Types.ObjectId;
  // Has the *other* party (not proposedBy) accepted this revision yet?
  isVerified: boolean;
}

export interface IJobContractFile {
  fileName: string;
  uploadedAt: Date;
}

// A job can be disputed more than once over its life — kept as a history,
// not a single latest-resolution field, same "never overwrite" instinct as
// oldStages. Admin resolution happens out-of-band by email (see
// jobs-and-contacts-plan.md); `note` is the admin's own record of what was
// agreed/decided, not the email itself.
export interface IDisputeResolution {
  resolvedBy: Types.ObjectId;
  resolvedAt: Date;
  note: string;
}

export interface IJobParty {
  userId: Types.ObjectId;
  isConfirmed: boolean;
  contractFile?: IJobContractFile;
}

export interface IJob extends Document {
  jobTitle: string;
  jobDescription: string;
  jobType: JobType;
  createdBy: Types.ObjectId;
  client: IJobParty;
  provider: IJobParty;
  // The currently-accepted stage plan. Always has at least one stage — a
  // job created with none gets a single implicit 100%-payment stage, so
  // "done"/"verified" completion tracking never needs a separate no-stages
  // code path. Typed as Mongoose's DocumentArray (not a plain array) so
  // jobController can look a stage up by id with `.id(stageId)`.
  stages: Types.DocumentArray<IJobStage>;
  proposedStages?: IProposedStages;
  // Every stage set this job has ever had, pushed here right before being
  // replaced by an accepted proposal — never overwritten, same instinct as
  // Subscription's history-over-mutation approach.
  oldStages: IJobStage[][];
  totalAmount: number;
  currency: string;
  // Client's total paid in (escrow), provider's total released out, and
  // PolyGrid's total collected — amountDisposed + platformFeeCollected is
  // always the total released from escrow across all verified stages.
  amountPaid: number;
  amountDisposed: number;
  platformFeeCollected: number;
  // Snapshotted at creation — a later change to the platform's default fee
  // doesn't retroactively change an existing job's math.
  platformFeePercent: number;
  status: JobStatus;
  isDispute: boolean;
  disputedBy?: Types.ObjectId;
  disputeReason?: string;
  disputeHistory: IDisputeResolution[];
  isCancelled: boolean;
  cancelledBy?: Types.ObjectId;
  cancelledAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const jobStageSchema = new Schema<IJobStage>({
  details: { type: [String], default: [] },
  isDone: { type: Boolean, default: false },
  isVerified: { type: Boolean, default: false },
  payment: { type: Number, required: true, min: 0, max: 100 },
});

// oldStages entries are frozen snapshots — no need for Mongoose to track
// live sub-document identity/behavior on history no one will edit again.
const jobStageSnapshotSchema = new Schema<IJobStage>(
  {
    details: { type: [String], default: [] },
    isDone: { type: Boolean, default: false },
    isVerified: { type: Boolean, default: false },
    payment: { type: Number, required: true },
  },
  { _id: false },
);

const proposedStagesSchema = new Schema<IProposedStages>(
  {
    stages: { type: [jobStageSchema], default: [] },
    proposedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    isVerified: { type: Boolean, default: false },
  },
  { _id: false },
);

const contractFileSchema = new Schema<IJobContractFile>(
  {
    fileName: { type: String, required: true },
    uploadedAt: { type: Date, default: () => new Date() },
  },
  { _id: false },
);

const disputeResolutionSchema = new Schema<IDisputeResolution>(
  {
    resolvedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    resolvedAt: { type: Date, default: () => new Date() },
    note: { type: String, required: true },
  },
  { _id: false },
);

const jobPartySchema = new Schema<IJobParty>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    isConfirmed: { type: Boolean, default: false },
    contractFile: { type: contractFileSchema },
  },
  { _id: false },
);

const jobSchema = new Schema<IJob>(
  {
    jobTitle: { type: String, required: [true, "Please add a job title"], trim: true },
    jobDescription: { type: String, required: [true, "Please add a job description"] },
    jobType: {
      type: String,
      enum: Object.values(JOB_TYPE),
      default: JOB_TYPE.OTHER,
    },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    client: { type: jobPartySchema, required: true },
    provider: { type: jobPartySchema, required: true },
    stages: { type: [jobStageSchema], default: [] },
    proposedStages: { type: proposedStagesSchema },
    oldStages: { type: [[jobStageSnapshotSchema]], default: [] },
    totalAmount: { type: Number, required: true, min: 0 },
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
    amountPaid: { type: Number, default: 0, min: 0 },
    amountDisposed: { type: Number, default: 0, min: 0 },
    platformFeeCollected: { type: Number, default: 0, min: 0 },
    platformFeePercent: { type: Number, required: true, min: 0, max: 100 },
    status: {
      type: String,
      enum: Object.values(JOB_STATUS),
      default: JOB_STATUS.PENDING_CONFIRMATION,
    },
    isDispute: { type: Boolean, default: false },
    disputedBy: { type: Schema.Types.ObjectId, ref: "User" },
    disputeReason: { type: String },
    disputeHistory: { type: [disputeResolutionSchema], default: [] },
    isCancelled: { type: Boolean, default: false },
    cancelledBy: { type: Schema.Types.ObjectId, ref: "User" },
    cancelledAt: { type: Date },
  },
  { timestamps: true },
);

jobSchema.index({ "client.userId": 1, status: 1 });
jobSchema.index({ "provider.userId": 1, status: 1 });
jobSchema.index({ createdBy: 1 });
jobSchema.index({ isDispute: 1, createdAt: -1 });

export const Job: Model<IJob> = mongoose.model<IJob>("Job", jobSchema);
