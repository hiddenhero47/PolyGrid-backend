import mongoose, { FilterQuery } from "mongoose";
import asyncHandler from "express-async-handler";
import { Request, Response } from "express";
import {
  SystemPayout,
  ISystemPayout,
  SYSTEM_PAYOUT_STATUS,
  SystemPayoutStatus,
  SYSTEM_PAYOUT_REQUEST_TYPE,
  SystemPayoutRequestType,
} from "../models/systemPayoutModel";
import { Job } from "../models/jobModel";
import { User, IUser } from "../models/userModel";
import { NOTIFICATION_TYPE } from "../models/notificationModel";
import { notify } from "../helpers/notify";
import { sendTemplatedEmail } from "../helpers/emailSender";
import { AppError } from "../middleware/errorMiddleware";

const paginationParams = (req: Request) => {
  const page = Math.max(Number(req.query.page) || 1, 1);
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  return { page, limit, skip: (page - 1) * limit };
};

// Fire-and-forget from the settling admin's point of view, but awaited
// here so a Mailgun failure surfaces in this request rather than racing
// the response — same reasoning jobController.notifyPaymentRequestDecision
// already uses. The settle itself has already saved by the time this
// runs, so a failed email never undoes it, it just doesn't get told to
// the recipient (visible to them anyway via their own records).
const notifySystemPayoutSettled = async (
  payout: ISystemPayout,
  jobTitle: string,
  paid: boolean,
): Promise<void> => {
  const recipient = await User.findById(payout.user).select("email fullName");
  if (!recipient) return;

  await sendTemplatedEmail({
    to: recipient.email,
    subject: `Your ${payout.requestType} transfer ${paid ? "was sent" : "failed"}`,
    template: "systemPayoutSettled",
    variables: {
      name: recipient.fullName,
      jobTitle,
      requestType: payout.requestType,
      amount: payout.amount,
      currency: payout.currency,
      paid,
      transferReference: payout.transferReference,
      failureReason: payout.failureReason,
    },
  });

  await notify(
    payout.user,
    NOTIFICATION_TYPE.SYSTEM_PAYOUT_SETTLED,
    `Your ${payout.requestType} transfer for "${jobTitle}" ${paid ? "was sent" : "failed"}`,
    { payoutId: payout.id, requestType: payout.requestType, amount: payout.amount, currency: payout.currency, paid },
  );
};

// @desc    Every transfer PolyGrid owes someone (an approved refund or
//          payout) — the admin's "to pay" worklist. approveRefundRequest/
//          approvePayoutRequest (jobController.ts) create these records,
//          but nothing previously listed them, so an admin had no way to
//          actually see what still needs paying out by hand. Each row
//          carries the originating job's title and the recipient's name/
//          email, batched rather than populated per row.
// @route   GET /api/system-payouts?status=&requestType=&page=&limit=
// @access  Private (Admin / Super Admin only)
export const getSystemPayouts = asyncHandler(async (req: Request, res: Response) => {
  const { page, limit, skip } = paginationParams(req);
  const { status, requestType } = req.query as { status?: string; requestType?: string };

  const filter: FilterQuery<ISystemPayout> = {};

  if (status && Object.values(SYSTEM_PAYOUT_STATUS).includes(status as SystemPayoutStatus)) {
    filter.status = status as SystemPayoutStatus;
  }

  if (
    requestType &&
    Object.values(SYSTEM_PAYOUT_REQUEST_TYPE).includes(requestType as SystemPayoutRequestType)
  ) {
    filter.requestType = requestType as SystemPayoutRequestType;
  }

  const [payouts, total] = await Promise.all([
    SystemPayout.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    SystemPayout.countDocuments(filter),
  ]);

  const [jobs, users] = await Promise.all([
    Job.find({ _id: { $in: payouts.map((p) => p.targetId) } }).select("jobTitle"),
    User.find({ _id: { $in: payouts.map((p) => p.user) } }).select("fullName email"),
  ]);
  const jobById = new Map(jobs.map((job) => [job.id, job]));
  const userById = new Map(users.map((user) => [user.id, user]));

  res.status(200).json({
    data: payouts.map((payout) => ({
      id: payout.id,
      requestType: payout.requestType,
      targetType: payout.targetType,
      targetId: payout.targetId,
      jobTitle: jobById.get(payout.targetId.toString())?.jobTitle,
      amount: payout.amount,
      currency: payout.currency,
      status: payout.status,
      payoutAccount: payout.payoutAccount,
      isLocked: payout.isLocked,
      recipient: (() => {
        const user = userById.get(payout.user.toString()) as IUser | undefined;
        return user ? { id: user.id, fullName: user.fullName, email: user.email } : null;
      })(),
      transferReference: payout.transferReference,
      failureReason: payout.failureReason,
      createdAt: payout.createdAt,
    })),
    pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
  });
});

const loadPendingPayout = async (id: string): Promise<ISystemPayout> => {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    const error: AppError = new Error("System payout not found");
    error.statusCode = 404;
    throw error;
  }

  const payout = await SystemPayout.findById(id);
  if (!payout) {
    const error: AppError = new Error("System payout not found");
    error.statusCode = 404;
    throw error;
  }

  if (payout.status !== SYSTEM_PAYOUT_STATUS.PENDING) {
    const error: AppError = new Error(`This transfer has already been marked ${payout.status}`);
    error.statusCode = 400;
    throw error;
  }

  return payout;
};

// @desc    Mark a pending transfer as actually paid — the admin/finance
//          op moved the money by hand (bank transfer, Stripe dashboard,
//          …); this just records that it's done.
// @route   PATCH /api/system-payouts/:id/paid
// @access  Private (Admin / Super Admin only)
export const markSystemPayoutPaid = asyncHandler(async (req: Request, res: Response) => {
  const admin = req.user as IUser;
  const payout = await loadPendingPayout(req.params.id as string);

  const { transferReference } = req.body;

  payout.status = SYSTEM_PAYOUT_STATUS.PAID;
  payout.settledBy = admin._id as mongoose.Types.ObjectId;
  payout.settledAt = new Date();
  if (transferReference) payout.transferReference = transferReference;

  await payout.save();

  const job = await Job.findById(payout.targetId).select("jobTitle");
  await notifySystemPayoutSettled(payout, job?.jobTitle ?? "a job", true);

  res.status(200).json(payout);
});

// @desc    Mark a pending transfer as failed — always with a reason, so
//          the recipient (and whoever revisits this record later) isn't
//          just left guessing why. Never automatically retried or
//          reversed — a failed transfer just sits here until someone
//          looks into it by hand.
// @route   PATCH /api/system-payouts/:id/failed
// @access  Private (Admin / Super Admin only)
export const markSystemPayoutFailed = asyncHandler(async (req: Request, res: Response) => {
  const admin = req.user as IUser;
  const payout = await loadPendingPayout(req.params.id as string);

  const { failureReason } = req.body;

  payout.status = SYSTEM_PAYOUT_STATUS.FAILED;
  payout.settledBy = admin._id as mongoose.Types.ObjectId;
  payout.settledAt = new Date();
  payout.failureReason = failureReason;

  await payout.save();

  const job = await Job.findById(payout.targetId).select("jobTitle");
  await notifySystemPayoutSettled(payout, job?.jobTitle ?? "a job", false);

  res.status(200).json(payout);
});
