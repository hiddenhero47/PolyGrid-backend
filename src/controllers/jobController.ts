import path from "path";
import mongoose, { FilterQuery } from "mongoose";
import asyncHandler from "express-async-handler";
import { Request, Response } from "express";
import { Job, IJob, IJobStage, JOB_TYPE, JobType, JOB_STATUS, JobStatus } from "../models/jobModel";
import { User, IUser, SYSTEM_ROLE } from "../models/userModel";
import { FileGrant } from "../models/fileGrantModel";
import { Payment, PAYMENT_TARGET_TYPE, PAYMENT_STATUS } from "../models/paymentModel";
import { PAYMENT_PROVIDER_NAME } from "../models/paymentProviderModel";
import { uploadHandler, deleteStoredFile, FILE_VISIBILITY, PRIVATE_DIR } from "../helpers/fileStorage";
import { AppError } from "../middleware/errorMiddleware";
import { connectUsers } from "./contactController";

const getPlatformFeePercent = (): number => Number(process.env.PLATFORM_FEE_PERCENT) || 0;

type NormalizedStage = Pick<IJobStage, "details" | "payment">;

// A job with no stages is modeled as one implicit stage covering the whole
// amount — so "provider marks done, client verifies" is the only
// completion code path this controller ever needs, no separate
// no-stages branch. Also enforces stage payments never exceed 100% of
// totalAmount.
const normalizeStages = (stages: unknown): NormalizedStage[] => {
  if (!Array.isArray(stages) || stages.length === 0) {
    return [{ details: [], payment: 100 }];
  }

  const normalized: NormalizedStage[] = stages.map((s) => ({
    details: Array.isArray((s as { details?: unknown })?.details)
      ? (s as { details: unknown[] }).details.map(String)
      : [],
    payment: Number((s as { payment?: unknown })?.payment) || 0,
  }));

  const total = normalized.reduce((sum, s) => sum + s.payment, 0);

  if (total > 100) {
    const error: AppError = new Error("Stage payment percentages cannot exceed 100% in total");
    error.statusCode = 400;
    throw error;
  }

  return normalized;
};

type JobRole = "client" | "provider";

const roleOf = (job: IJob, userId: string): JobRole | null => {
  if (job.client.userId.toString() === userId) return "client";
  if (job.provider.userId.toString() === userId) return "provider";
  return null;
};

const assertParty = (job: IJob, user: IUser): JobRole | null => {
  const role = roleOf(job, user.id);

  if (!role && user.systemRole !== SYSTEM_ROLE.ADMIN && user.systemRole !== SYSTEM_ROLE.SUPER_ADMIN) {
    const error: AppError = new Error("You are not a party to this job");
    error.statusCode = 403;
    throw error;
  }

  return role;
};

// @desc    Create a job with another user (already a contact, or not — this
//          also connects the two of you, same as adding a contact directly)
// @route   POST /api/jobs
// @access  Private — no subscription required, this is a free trust/tracking
//          tool available to every account.
export const createJob = asyncHandler(async (req: Request, res: Response) => {
  const requester = req.user as IUser;
  const {
    counterpartyUserId,
    myRole,
    jobTitle,
    jobDescription,
    jobType,
    totalAmount,
    currency,
    stages,
  } = req.body;

  if (!counterpartyUserId || !myRole || !jobTitle || !jobDescription || totalAmount === undefined) {
    res.status(400);
    throw new Error(
      "Please add counterpartyUserId, myRole, jobTitle, jobDescription and totalAmount",
    );
  }

  if (myRole !== "client" && myRole !== "provider") {
    res.status(400);
    throw new Error("myRole must be 'client' or 'provider'");
  }

  if (!mongoose.Types.ObjectId.isValid(counterpartyUserId)) {
    res.status(400);
    throw new Error("Invalid counterparty user id");
  }

  if (counterpartyUserId === requester.id) {
    res.status(400);
    throw new Error("You cannot create a job with yourself");
  }

  const counterparty = await User.findById(counterpartyUserId);

  if (!counterparty) {
    res.status(404);
    throw new Error("Counterparty user not found");
  }

  const resolvedStages = normalizeStages(stages);

  const client =
    myRole === "client"
      ? { userId: requester._id, isConfirmed: true }
      : { userId: counterparty._id, isConfirmed: false };

  const provider =
    myRole === "provider"
      ? { userId: requester._id, isConfirmed: true }
      : { userId: counterparty._id, isConfirmed: false };

  const job = await Job.create({
    jobTitle,
    jobDescription,
    jobType: Object.values(JOB_TYPE).includes(jobType) ? jobType : JOB_TYPE.OTHER,
    createdBy: requester._id,
    client,
    provider,
    stages: resolvedStages,
    totalAmount,
    currency: typeof currency === "string" && currency.trim() ? currency : undefined,
    platformFeePercent: getPlatformFeePercent(),
  });

  await connectUsers(requester._id, counterparty._id);

  res.status(201).json(job);
});

// @desc    Get a single job
// @route   GET /api/jobs/:id
// @access  Private (client, provider, or admin)
export const getJob = asyncHandler(async (req: Request, res: Response) => {
  const job = await Job.findById(req.params.id);

  if (!job) {
    res.status(404);
    throw new Error("Job not found");
  }

  assertParty(job, req.user as IUser);

  res.status(200).json(job);
});

// @desc    List jobs I'm a party to, newest first
// @route   GET /api/jobs/mine
// @access  Private
export const getMyJobs = asyncHandler(async (req: Request, res: Response) => {
  const requester = req.user as IUser;
  const page = Math.max(Number(req.query.page) || 1, 1);
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  const skip = (page - 1) * limit;

  const filter: FilterQuery<IJob> = {
    $or: [{ "client.userId": requester._id }, { "provider.userId": requester._id }],
  };

  const status = req.query.status as string | undefined;
  if (status && Object.values(JOB_STATUS).includes(status as JobStatus)) {
    filter.status = status as JobStatus;
  }

  const [jobs, total] = await Promise.all([
    Job.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    Job.countDocuments(filter),
  ]);

  res.status(200).json({
    data: jobs,
    pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
  });
});

// @desc    Confirm a job the other party created
// @route   PATCH /api/jobs/:id/confirm
// @access  Private (the non-creator party)
export const confirmJob = asyncHandler(async (req: Request, res: Response) => {
  const requester = req.user as IUser;
  const job = await Job.findById(req.params.id);

  if (!job) {
    res.status(404);
    throw new Error("Job not found");
  }

  if (job.status !== JOB_STATUS.PENDING_CONFIRMATION) {
    res.status(400);
    throw new Error("This job is not awaiting confirmation");
  }

  const role = roleOf(job, requester.id);

  if (!role) {
    res.status(403);
    throw new Error("You are not a party to this job");
  }

  if (job[role].isConfirmed) {
    res.status(400);
    throw new Error("You have already confirmed this job");
  }

  job[role].isConfirmed = true;

  if (job.client.isConfirmed && job.provider.isConfirmed) {
    job.status = JOB_STATUS.ACTIVE;
  }

  await job.save();

  res.status(200).json(job);
});

// @desc    Edit a job's core details — only before the other party confirms
// @route   PATCH /api/jobs/:id
// @access  Private (creator only)
export const updateJob = asyncHandler(async (req: Request, res: Response) => {
  const requester = req.user as IUser;
  const job = await Job.findById(req.params.id);

  if (!job) {
    res.status(404);
    throw new Error("Job not found");
  }

  if (job.createdBy.toString() !== requester.id) {
    res.status(403);
    throw new Error("Only the job's creator can edit it");
  }

  if (job.status !== JOB_STATUS.PENDING_CONFIRMATION) {
    res.status(400);
    throw new Error(
      "This job can no longer be edited directly — propose a stage change instead",
    );
  }

  const { jobTitle, jobDescription, jobType, totalAmount, stages } = req.body;

  if (jobTitle) job.jobTitle = jobTitle;
  if (jobDescription) job.jobDescription = jobDescription;
  if (jobType && Object.values(JOB_TYPE).includes(jobType)) job.jobType = jobType as JobType;
  if (totalAmount !== undefined) job.totalAmount = totalAmount;
  if (stages !== undefined) {
    job.stages = normalizeStages(stages) as unknown as mongoose.Types.DocumentArray<IJobStage>;
  }

  await job.save();

  res.status(200).json(job);
});

// @desc    Propose a revised stage plan on an active job
// @route   POST /api/jobs/:id/stages/propose
// @access  Private (client or provider)
export const proposeStages = asyncHandler(async (req: Request, res: Response) => {
  const requester = req.user as IUser;
  const job = await Job.findById(req.params.id);

  if (!job) {
    res.status(404);
    throw new Error("Job not found");
  }

  assertParty(job, requester);

  if (job.status !== JOB_STATUS.ACTIVE) {
    res.status(400);
    throw new Error("Stage changes can only be proposed on an active job");
  }

  job.proposedStages = {
    stages: normalizeStages(req.body.stages) as IJobStage[],
    proposedBy: requester._id as mongoose.Types.ObjectId,
    isVerified: false,
  };

  await job.save();

  res.status(200).json(job);
});

// @desc    Accept the other party's proposed stage plan
// @route   PATCH /api/jobs/:id/stages/accept
// @access  Private (whichever party did NOT propose it)
export const acceptProposedStages = asyncHandler(async (req: Request, res: Response) => {
  const requester = req.user as IUser;
  const job = await Job.findById(req.params.id);

  if (!job) {
    res.status(404);
    throw new Error("Job not found");
  }

  assertParty(job, requester);

  if (!job.proposedStages) {
    res.status(400);
    throw new Error("There is no pending stage proposal");
  }

  if (job.proposedStages.proposedBy.toString() === requester.id) {
    res.status(400);
    throw new Error("You cannot accept your own proposal");
  }

  job.oldStages.push(job.stages);
  job.stages = job.proposedStages.stages as unknown as mongoose.Types.DocumentArray<IJobStage>;
  job.proposedStages = undefined;

  await job.save();

  res.status(200).json(job);
});

// @desc    Reject the other party's proposed stage plan
// @route   PATCH /api/jobs/:id/stages/reject
// @access  Private (whichever party did NOT propose it)
export const rejectProposedStages = asyncHandler(async (req: Request, res: Response) => {
  const requester = req.user as IUser;
  const job = await Job.findById(req.params.id);

  if (!job) {
    res.status(404);
    throw new Error("Job not found");
  }

  assertParty(job, requester);

  if (!job.proposedStages) {
    res.status(400);
    throw new Error("There is no pending stage proposal");
  }

  if (job.proposedStages.proposedBy.toString() === requester.id) {
    res.status(400);
    throw new Error("You cannot reject your own proposal");
  }

  job.proposedStages = undefined;

  await job.save();

  res.status(200).json(job);
});

// @desc    Mark a stage's work done
// @route   PATCH /api/jobs/:id/stages/:stageId/done
// @access  Private (provider only)
export const markStageDone = asyncHandler(async (req: Request, res: Response) => {
  const requester = req.user as IUser;
  const job = await Job.findById(req.params.id);

  if (!job) {
    res.status(404);
    throw new Error("Job not found");
  }

  if (job.provider.userId.toString() !== requester.id) {
    res.status(403);
    throw new Error("Only the provider can mark a stage done");
  }

  if (job.status !== JOB_STATUS.ACTIVE) {
    res.status(400);
    throw new Error("This job is not active");
  }

  const stage = job.stages.id(req.params.stageId as string);

  if (!stage) {
    res.status(404);
    throw new Error("Stage not found");
  }

  stage.isDone = true;

  await job.save();

  res.status(200).json(job);
});

// @desc    Verify a stage's work — releases its payment share from escrow
// @route   PATCH /api/jobs/:id/stages/:stageId/verify
// @access  Private (client only)
export const verifyStage = asyncHandler(async (req: Request, res: Response) => {
  const requester = req.user as IUser;
  const job = await Job.findById(req.params.id);

  if (!job) {
    res.status(404);
    throw new Error("Job not found");
  }

  if (job.client.userId.toString() !== requester.id) {
    res.status(403);
    throw new Error("Only the client can verify a stage");
  }

  if (job.status !== JOB_STATUS.ACTIVE) {
    res.status(400);
    throw new Error("This job is not active");
  }

  const stage = job.stages.id(req.params.stageId as string);

  if (!stage) {
    res.status(404);
    throw new Error("Stage not found");
  }

  if (!stage.isDone) {
    res.status(400);
    throw new Error("The provider has not marked this stage done yet");
  }

  if (stage.isVerified) {
    res.status(400);
    throw new Error("This stage has already been verified");
  }

  stage.isVerified = true;

  const stageAmount = (job.totalAmount * stage.payment) / 100;
  const feeAmount = (stageAmount * job.platformFeePercent) / 100;

  job.amountDisposed += stageAmount - feeAmount;
  job.platformFeeCollected += feeAmount;

  if (job.stages.every((s) => s.isVerified)) {
    job.status = JOB_STATUS.COMPLETED;
  }

  await job.save();

  res.status(200).json(job);
});

// @desc    Upload (or replace) my copy of the job's contract — a private
//          file automatically shared with the other party
// @route   POST /api/jobs/:id/contract
// @access  Private (client or provider)
export const uploadContract = asyncHandler(async (req: Request, res: Response) => {
  const requester = req.user as IUser;
  const job = await Job.findById(req.params.id);

  if (!job) {
    res.status(404);
    throw new Error("Job not found");
  }

  const role = roleOf(job, requester.id);

  if (!role) {
    res.status(403);
    throw new Error("You are not a party to this job");
  }

  const otherPartyId = role === "client" ? job.provider.userId : job.client.userId;

  const { results, errorLogs } = await uploadHandler({
    req,
    visibility: FILE_VISIBILITY.PRIVATE,
    ownerId: requester.id,
  });

  if (results.length === 0) {
    res.status(400);
    throw new Error(errorLogs[0] || "No valid file provided");
  }

  const saved = results[0];
  const existing = job[role].contractFile;

  if (existing) {
    await deleteStoredFile(path.join(PRIVATE_DIR, requester.id, existing.fileName));
    await FileGrant.deleteOne({ fileName: existing.fileName });
  }

  await FileGrant.create({
    ownerId: requester._id,
    fileName: saved.fileName,
    allowedUsers: [otherPartyId],
  });

  job[role].contractFile = { fileName: saved.fileName, uploadedAt: new Date() };

  await job.save();

  res.status(201).json(job);
});

// @desc    Raise a dispute on a job
// @route   PATCH /api/jobs/:id/dispute
// @access  Private (client or provider)
export const raiseDispute = asyncHandler(async (req: Request, res: Response) => {
  const requester = req.user as IUser;
  const job = await Job.findById(req.params.id);

  if (!job) {
    res.status(404);
    throw new Error("Job not found");
  }

  assertParty(job, requester);

  if (job.status === JOB_STATUS.CANCELLED || job.status === JOB_STATUS.COMPLETED) {
    res.status(400);
    throw new Error("This job can no longer be disputed");
  }

  const { reason } = req.body;

  if (!reason) {
    res.status(400);
    throw new Error("A dispute reason is required");
  }

  job.isDispute = true;
  job.disputedBy = requester._id as mongoose.Types.ObjectId;
  job.disputeReason = reason;
  job.status = JOB_STATUS.DISPUTED;

  await job.save();

  res.status(200).json(job);
});

// @desc    List every currently disputed job — the admin's working queue.
//          Correspondence with the two parties happens by email (their
//          addresses are right here, via the populated userId), not through
//          any in-app chat — that's a deliberate v1 decision, not a gap.
// @route   GET /api/jobs/disputes
// @access  Private (Admin / Super Admin only)
export const getDisputedJobs = asyncHandler(async (req: Request, res: Response) => {
  const page = Math.max(Number(req.query.page) || 1, 1);
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  const skip = (page - 1) * limit;

  const filter: FilterQuery<IJob> = { isDispute: true };

  const [jobs, total] = await Promise.all([
    Job.find(filter)
      .sort({ updatedAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("client.userId", "fullName email")
      .populate("provider.userId", "fullName email")
      .populate("disputedBy", "fullName email"),
    Job.countDocuments(filter),
  ]);

  res.status(200).json({
    data: jobs,
    pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
  });
});

// @desc    Clear a dispute and return the job to active, recording how it
//          was resolved. The resolution itself happens over email, outside
//          this system — `note` is the admin's own record of the outcome
//          (e.g. "refunded stage 2 per agreement over email"), not the
//          correspondence itself.
// @route   PATCH /api/jobs/:id/dispute/resolve
// @access  Private (Admin / Super Admin only)
// Bare-minimum "unstick a job" tool — no in-app mediation/refund workflow.
export const resolveDispute = asyncHandler(async (req: Request, res: Response) => {
  const admin = req.user as IUser;
  const job = await Job.findById(req.params.id);

  if (!job) {
    res.status(404);
    throw new Error("Job not found");
  }

  if (!job.isDispute) {
    res.status(400);
    throw new Error("This job is not disputed");
  }

  const { note } = req.body;

  if (!note) {
    res.status(400);
    throw new Error("A resolution note is required");
  }

  job.disputeHistory.push({
    resolvedBy: admin._id as mongoose.Types.ObjectId,
    resolvedAt: new Date(),
    note,
  });

  job.isDispute = false;
  job.disputedBy = undefined;
  job.disputeReason = undefined;
  job.status = JOB_STATUS.ACTIVE;

  await job.save();

  res.status(200).json(job);
});

// @desc    Cancel a job that's still awaiting confirmation
// @route   PATCH /api/jobs/:id/cancel
// @access  Private (creator only)
// Once both parties have confirmed, use a dispute instead — cancelling
// something both sides already committed to (possibly with money in
// escrow) shouldn't be unilateral.
export const cancelJob = asyncHandler(async (req: Request, res: Response) => {
  const requester = req.user as IUser;
  const job = await Job.findById(req.params.id);

  if (!job) {
    res.status(404);
    throw new Error("Job not found");
  }

  if (job.createdBy.toString() !== requester.id) {
    res.status(403);
    throw new Error("Only the job's creator can cancel it");
  }

  if (job.status !== JOB_STATUS.PENDING_CONFIRMATION) {
    res.status(400);
    throw new Error(
      "Only a job still awaiting confirmation can be cancelled directly — raise a dispute instead",
    );
  }

  job.isCancelled = true;
  job.cancelledBy = requester._id as mongoose.Types.ObjectId;
  job.cancelledAt = new Date();
  job.status = JOB_STATUS.CANCELLED;

  await job.save();

  res.status(200).json(job);
});

// @desc    Record a payment the client has made into escrow
// @route   POST /api/jobs/:id/payments
// @access  Private (Admin / Super Admin only)
// Interim tool standing in for a real payment provider webhook — same
// pattern as subscriptionController.grantSubscription. Also creates a
// Payment record (provider: 'manual') so this leaves the same audit trail
// a real gateway payment would, not just a number bumped on the job.
export const recordPayment = asyncHandler(async (req: Request, res: Response) => {
  const admin = req.user as IUser;
  const job = await Job.findById(req.params.id);

  if (!job) {
    res.status(404);
    throw new Error("Job not found");
  }

  const { amount } = req.body;

  if (!amount || amount <= 0) {
    res.status(400);
    throw new Error("A positive amount is required");
  }

  const client = await User.findById(job.client.userId).select("email");

  job.amountPaid += amount;
  await job.save();

  await Payment.create({
    targetType: PAYMENT_TARGET_TYPE.JOB,
    targetId: job._id,
    user: job.client.userId,
    userEmail: client?.email ?? "",
    amount,
    currency: job.currency,
    provider: PAYMENT_PROVIDER_NAME.MANUAL,
    status: PAYMENT_STATUS.SUCCESS,
    recordedBy: admin._id,
  });

  res.status(200).json(job);
});
