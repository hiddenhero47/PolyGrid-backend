import path from "path";
import mongoose, { FilterQuery } from "mongoose";
import asyncHandler from "express-async-handler";
import { Request, Response } from "express";
import {
  Job,
  IJob,
  IJobStage,
  JOB_TYPE,
  JobType,
  JOB_STATUS,
  JobStatus,
  PAYMENT_REQUEST_STATUS,
} from "../models/jobModel";
import { User, IUser, SYSTEM_ROLE } from "../models/userModel";
import { FileGrant } from "../models/fileGrantModel";
import { Payment, PAYMENT_TARGET_TYPE, PAYMENT_STATUS } from "../models/paymentModel";
import { PAYMENT_PROVIDER_NAME } from "../models/paymentProviderModel";
import { uploadHandler, deleteStoredFile, FILE_VISIBILITY, PRIVATE_DIR } from "../helpers/fileStorage";
import { sendTemplatedEmail } from "../helpers/emailSender";
import { AppError } from "../middleware/errorMiddleware";
import { connectUsers } from "./contactController";

// Fire-and-forget from the requester's point of view, but awaited here so
// a Mailgun failure surfaces in this request rather than racing the
// response — same non-blocking-of-the-core-action spirit as every other
// notification in this codebase, just not wrapped in try/catch: the
// approve/decline itself has already saved by the time this runs, so a
// failed email never undoes a real decision, it just doesn't get told to
// the requester (visible to them anyway via GET /api/jobs/:id).
const notifyPaymentRequestDecision = async (
  job: IJob,
  requestType: "refund" | "payout",
  requestedBy: mongoose.Types.ObjectId,
  amount: number | undefined,
  currency: string,
  approved: boolean,
  declineReason?: string,
): Promise<void> => {
  const requesterUser = await User.findById(requestedBy).select("email fullName");
  if (!requesterUser) return;

  await sendTemplatedEmail({
    to: requesterUser.email,
    subject: `Your ${requestType} request was ${approved ? "approved" : "declined"}`,
    template: "paymentRequestDecision",
    variables: {
      name: requesterUser.fullName,
      jobTitle: job.jobTitle,
      requestType,
      approved,
      amount: amount !== undefined ? amount : "the full available amount",
      currency,
      declineReason,
    },
  });
};

// Exported for storeOrderController.ts — a store checkout creates a Job
// directly (not through the HTTP createJob endpoint below, since the shop
// owner needs to end up as its creator even though the buyer is the one
// calling checkout), and needs the exact same fee snapshot, not a second
// copy of this that could drift.
export const getPlatformFeePercent = (): number => Number(process.env.PLATFORM_FEE_PERCENT) || 0;

type NormalizedStage = Pick<IJobStage, "details" | "payment">;

// A job with no stages is modeled as one implicit stage covering the whole
// amount — so "provider marks done, client verifies" is the only
// completion code path this controller ever needs, no separate
// no-stages branch. Also enforces stage payments never exceed 100% of
// totalAmount. Exported for the same reason as getPlatformFeePercent above.
export const normalizeStages = (stages: unknown): NormalizedStage[] => {
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
  if (totalAmount !== undefined && totalAmount !== job.totalAmount) {
    job.amountHistory.push({
      previousAmount: job.totalAmount,
      changedBy: requester._id as mongoose.Types.ObjectId,
      changedAt: new Date(),
    });
    job.totalAmount = totalAmount;
  }
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

  job.amountDisbursed += stageAmount - feeAmount;
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

// @desc    Every payment ever made toward this job, newest first — the
//          admin working view of a job's payment history. Not a field on
//          Job at all: Payment already carries {targetType, targetId} on
//          a compound index, so this is one indexed query, nothing to
//          denormalize or keep in sync.
// @route   GET /api/jobs/:id/payments
// @access  Private (Admin / Super Admin / Customer Care — read-only)
export const getJobPayments = asyncHandler(async (req: Request, res: Response) => {
  const job = await Job.findById(req.params.id).select("_id");

  if (!job) {
    res.status(404);
    throw new Error("Job not found");
  }

  const payments = await Payment.find({
    targetType: PAYMENT_TARGET_TYPE.JOB,
    targetId: job._id,
  }).sort({ createdAt: -1 });

  res.status(200).json(payments);
});

// @desc    The client asks for money back on this job. Sits PENDING until
//          an admin decides it — nothing about the job's balance or
//          status changes yet, that only happens on approval.
// @route   POST /api/jobs/:id/refund-requests
// @access  Private (the job's client only)
export const requestRefund = asyncHandler(async (req: Request, res: Response) => {
  const requester = req.user as IUser;
  const job = await Job.findById(req.params.id);

  if (!job) {
    res.status(404);
    throw new Error("Job not found");
  }

  if (job.client.userId.toString() !== requester.id) {
    res.status(403);
    throw new Error("Only this job's client can request a refund");
  }

  if (job.refunds.some((r) => r.status === PAYMENT_REQUEST_STATUS.PENDING)) {
    res.status(400);
    throw new Error("You already have a pending refund request on this job");
  }

  // Fails at this level first, before even looking at the requested
  // amount — asking for anything at all makes no sense once every dollar
  // paid in has already been refunded.
  if (job.amountPaid - job.totalRefunded <= 0) {
    res.status(400);
    throw new Error("There's nothing left to refund on this job");
  }

  const { amount, reason } = req.body;

  if (!amount || amount <= 0) {
    res.status(400);
    throw new Error("A positive amount is required");
  }

  if (!reason) {
    res.status(400);
    throw new Error("A refund reason is required");
  }

  if (job.totalRefunded + amount > job.amountPaid) {
    res.status(400);
    throw new Error(
      `Requesting ${amount} would exceed what's actually been paid into this job (${job.amountPaid - job.totalRefunded} refundable)`,
    );
  }

  job.refunds.push({
    amount,
    reason,
    status: PAYMENT_REQUEST_STATUS.PENDING,
    requestedBy: requester._id as mongoose.Types.ObjectId,
    requestedAt: new Date(),
  } as never);

  await job.save();

  res.status(201).json(job);
});

// @desc    Every pending refund request across every job — the admin's
//          working queue.
// @route   GET /api/jobs/refund-requests
// @access  Private (Admin / Super Admin / Customer Care — read-only)
export const getPendingRefundRequests = asyncHandler(async (req: Request, res: Response) => {
  const page = Math.max(Number(req.query.page) || 1, 1);
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  const skip = (page - 1) * limit;

  const filter: FilterQuery<IJob> = { "refunds.status": PAYMENT_REQUEST_STATUS.PENDING };

  const [jobs, total] = await Promise.all([
    Job.find(filter)
      .sort({ updatedAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("client.userId", "fullName email")
      .populate("provider.userId", "fullName email"),
    Job.countDocuments(filter),
  ]);

  const data = jobs.map((job) => ({
    jobId: job._id,
    jobTitle: job.jobTitle,
    client: job.client,
    provider: job.provider,
    refund: job.refunds.find((r) => r.status === PAYMENT_REQUEST_STATUS.PENDING),
  }));

  res.status(200).json({ data, pagination: { total, page, limit, totalPages: Math.ceil(total / limit) } });
});

// @desc    Approve a pending refund request — the only thing that actually
//          moves totalRefunded and closes the job. Closing is a one-time
//          transition: it's what the *first* approved refund on a job
//          does; a later, corrective request just adds to the history
//          without re-closing an already-closed job or moving closedAt.
// @route   PATCH /api/jobs/:id/refund-requests/:refundId/approve
// @access  Private (Admin / Super Admin only)
export const approveRefundRequest = asyncHandler(async (req: Request, res: Response) => {
  const admin = req.user as IUser;
  const job = await Job.findById(req.params.id);

  if (!job) {
    res.status(404);
    throw new Error("Job not found");
  }

  const refund = job.refunds.id(req.params.refundId as string);

  if (!refund) {
    res.status(404);
    throw new Error("Refund request not found");
  }

  if (refund.status !== PAYMENT_REQUEST_STATUS.PENDING) {
    res.status(400);
    throw new Error(`This refund request has already been ${refund.status}`);
  }

  // Re-checked at decision time, not just at request time — other
  // refunds may have been approved in between.
  if (job.totalRefunded + refund.amount > job.amountPaid) {
    res.status(400);
    throw new Error(
      `Approving ${refund.amount} would exceed what's actually been paid into this job (${job.amountPaid - job.totalRefunded} refundable)`,
    );
  }

  refund.status = PAYMENT_REQUEST_STATUS.APPROVED;
  refund.decidedBy = admin._id as mongoose.Types.ObjectId;
  refund.decidedAt = new Date();
  job.totalRefunded += refund.amount;

  if (job.status !== JOB_STATUS.CLOSED) {
    job.status = JOB_STATUS.CLOSED;
    job.closedAt = new Date();
  }

  await job.save();
  await notifyPaymentRequestDecision(job, "refund", refund.requestedBy, refund.amount, job.currency, true);

  res.status(200).json(job);
});

// @desc    Decline a pending refund request — always with a reason, so the
//          client isn't just left guessing why.
// @route   PATCH /api/jobs/:id/refund-requests/:refundId/decline
// @access  Private (Admin / Super Admin only)
export const declineRefundRequest = asyncHandler(async (req: Request, res: Response) => {
  const admin = req.user as IUser;
  const job = await Job.findById(req.params.id);

  if (!job) {
    res.status(404);
    throw new Error("Job not found");
  }

  const refund = job.refunds.id(req.params.refundId as string);

  if (!refund) {
    res.status(404);
    throw new Error("Refund request not found");
  }

  if (refund.status !== PAYMENT_REQUEST_STATUS.PENDING) {
    res.status(400);
    throw new Error(`This refund request has already been ${refund.status}`);
  }

  const { declineReason } = req.body;

  if (!declineReason) {
    res.status(400);
    throw new Error("A decline reason is required");
  }

  refund.status = PAYMENT_REQUEST_STATUS.DECLINED;
  refund.decidedBy = admin._id as mongoose.Types.ObjectId;
  refund.decidedAt = new Date();
  refund.declineReason = declineReason;

  await job.save();
  await notifyPaymentRequestDecision(
    job,
    "refund",
    refund.requestedBy,
    refund.amount,
    job.currency,
    false,
    declineReason,
  );

  res.status(200).json(job);
});

// @desc    The provider asks to be paid their earned-but-undisbursed
//          funds. `amount` is optional — omit it to ask for whatever's
//          available. Sits PENDING until an admin decides it.
// @route   POST /api/jobs/:id/payout-requests
// @access  Private (the job's provider only)
export const requestPayout = asyncHandler(async (req: Request, res: Response) => {
  const requester = req.user as IUser;
  const job = await Job.findById(req.params.id);

  if (!job) {
    res.status(404);
    throw new Error("Job not found");
  }

  if (job.provider.userId.toString() !== requester.id) {
    res.status(403);
    throw new Error("Only this job's provider can request a payout");
  }

  if (job.payouts.some((p) => p.status === PAYMENT_REQUEST_STATUS.PENDING)) {
    res.status(400);
    throw new Error("You already have a pending payout request on this job");
  }

  if (job.isDispute) {
    res.status(400);
    throw new Error("This job is disputed — it can't be paid out until that's resolved");
  }

  if (job.status === JOB_STATUS.CANCELLED || job.status === JOB_STATUS.CLOSED) {
    res.status(400);
    throw new Error(`A ${job.status} job has nothing left to pay out`);
  }

  // amountDisbursed is what verified stages have released from escrow —
  // but verifyStage releases against totalAmount regardless of how much
  // has actually been paid in yet, so this takes the smaller of the two
  // rather than trusting amountDisbursed on its own.
  const available = Math.min(job.amountDisbursed, job.amountPaid) - job.amountPaidOut;

  if (available <= 0) {
    res.status(400);
    throw new Error("Nothing is currently available to request a payout on");
  }

  // req.body is undefined, not {}, when a request sends no body at all —
  // legitimate here, since `amount` is meant to be entirely optional.
  const { amount, note } = req.body ?? {};

  if (amount !== undefined && (!Number(amount) || Number(amount) <= 0)) {
    res.status(400);
    throw new Error("amount must be a positive number");
  }

  if (amount !== undefined && Number(amount) > available) {
    res.status(400);
    throw new Error(`Requesting ${amount} would exceed the ${available} currently available`);
  }

  job.payouts.push({
    amount: amount !== undefined ? Number(amount) : undefined,
    note,
    status: PAYMENT_REQUEST_STATUS.PENDING,
    requestedBy: requester._id as mongoose.Types.ObjectId,
    requestedAt: new Date(),
  } as never);

  await job.save();

  res.status(201).json(job);
});

// @desc    Every pending payout request across every job — the admin's
//          working queue.
// @route   GET /api/jobs/payout-requests
// @access  Private (Admin / Super Admin / Customer Care — read-only)
export const getPendingPayoutRequests = asyncHandler(async (req: Request, res: Response) => {
  const page = Math.max(Number(req.query.page) || 1, 1);
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  const skip = (page - 1) * limit;

  const filter: FilterQuery<IJob> = { "payouts.status": PAYMENT_REQUEST_STATUS.PENDING };

  const [jobs, total] = await Promise.all([
    Job.find(filter)
      .sort({ updatedAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("client.userId", "fullName email")
      .populate("provider.userId", "fullName email"),
    Job.countDocuments(filter),
  ]);

  const data = jobs.map((job) => ({
    jobId: job._id,
    jobTitle: job.jobTitle,
    client: job.client,
    provider: job.provider,
    // Available is recomputed fresh, not read off the request — it may
    // have shrunk (another payout approved in the meantime) since this
    // was requested.
    available: Math.min(job.amountDisbursed, job.amountPaid) - job.amountPaidOut,
    payout: job.payouts.find((p) => p.status === PAYMENT_REQUEST_STATUS.PENDING),
  }));

  res.status(200).json({ data, pagination: { total, page, limit, totalPages: Math.ceil(total / limit) } });
});

// @desc    Approve a pending payout request — the only thing that actually
//          moves amountPaidOut. Resolves `amount` to a concrete number if
//          the request itself omitted one (admin may also override the
//          requested number outright via its own `amount` in the body).
//          Unlike a refund, never changes the job's status.
// @route   PATCH /api/jobs/:id/payout-requests/:payoutId/approve
// @access  Private (Admin / Super Admin only)
export const approvePayoutRequest = asyncHandler(async (req: Request, res: Response) => {
  const admin = req.user as IUser;
  const job = await Job.findById(req.params.id);

  if (!job) {
    res.status(404);
    throw new Error("Job not found");
  }

  const payout = job.payouts.id(req.params.payoutId as string);

  if (!payout) {
    res.status(404);
    throw new Error("Payout request not found");
  }

  if (payout.status !== PAYMENT_REQUEST_STATUS.PENDING) {
    res.status(400);
    throw new Error(`This payout request has already been ${payout.status}`);
  }

  // Re-checked at decision time, not just at request time — other
  // payouts may have been approved in between, shrinking what's left.
  const available = Math.min(job.amountDisbursed, job.amountPaid) - job.amountPaidOut;

  if (available <= 0) {
    res.status(400);
    throw new Error("Nothing is currently available to pay out");
  }

  const { amount } = req.body ?? {};
  const resolvedAmount = amount !== undefined ? Number(amount) : payout.amount ?? available;

  if (!resolvedAmount || resolvedAmount <= 0) {
    res.status(400);
    throw new Error("A positive amount is required");
  }

  if (resolvedAmount > available) {
    res.status(400);
    throw new Error(`Approving ${resolvedAmount} would exceed the ${available} currently available`);
  }

  payout.amount = resolvedAmount;
  payout.status = PAYMENT_REQUEST_STATUS.APPROVED;
  payout.decidedBy = admin._id as mongoose.Types.ObjectId;
  payout.decidedAt = new Date();
  job.amountPaidOut += resolvedAmount;

  await job.save();
  await notifyPaymentRequestDecision(job, "payout", payout.requestedBy, resolvedAmount, job.currency, true);

  res.status(200).json(job);
});

// @desc    Decline a pending payout request — always with a reason.
// @route   PATCH /api/jobs/:id/payout-requests/:payoutId/decline
// @access  Private (Admin / Super Admin only)
export const declinePayoutRequest = asyncHandler(async (req: Request, res: Response) => {
  const admin = req.user as IUser;
  const job = await Job.findById(req.params.id);

  if (!job) {
    res.status(404);
    throw new Error("Job not found");
  }

  const payout = job.payouts.id(req.params.payoutId as string);

  if (!payout) {
    res.status(404);
    throw new Error("Payout request not found");
  }

  if (payout.status !== PAYMENT_REQUEST_STATUS.PENDING) {
    res.status(400);
    throw new Error(`This payout request has already been ${payout.status}`);
  }

  const { declineReason } = req.body;

  if (!declineReason) {
    res.status(400);
    throw new Error("A decline reason is required");
  }

  payout.status = PAYMENT_REQUEST_STATUS.DECLINED;
  payout.decidedBy = admin._id as mongoose.Types.ObjectId;
  payout.decidedAt = new Date();
  payout.declineReason = declineReason;

  await job.save();
  await notifyPaymentRequestDecision(
    job,
    "payout",
    payout.requestedBy,
    payout.amount,
    job.currency,
    false,
    declineReason,
  );

  res.status(200).json(job);
});
