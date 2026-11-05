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
  SETTLEMENT_METHOD,
  SYSTEM_PAYOUT_TARGET_TYPE,
} from "../models/systemPayoutModel";
import { Job } from "../models/jobModel";
import { DigitalCreatorProfile } from "../models/digitalCreatorProfileModel";
import { User, IUser } from "../models/userModel";
import { Payment, PAYMENT_TARGET_TYPE, PAYMENT_STATUS } from "../models/paymentModel";
import { PAYMENT_PROVIDER_NAME } from "../models/paymentProviderModel";
import { NOTIFICATION_TYPE } from "../models/notificationModel";
import { notify } from "../helpers/notify";
import { sendTemplatedEmail } from "../helpers/emailSender";
import { AppError } from "../middleware/errorMiddleware";
import { createTransfer, createRefund } from "../helpers/stripeConnect";

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

  // Polymorphic by targetType — a Job-backed record wants the job's
  // title, a DigitalCreatorProfile-backed one (see
  // digitalCreatorProfileController.ts's requestDigitalCreatorPayout)
  // wants the creator's display name. Either way, a single `label` field
  // the admin worklist can show without caring which kind this row is.
  const [jobs, creatorProfiles, users] = await Promise.all([
    Job.find({ _id: { $in: payouts.map((p) => p.targetId) } }).select("jobTitle"),
    DigitalCreatorProfile.find({ _id: { $in: payouts.map((p) => p.targetId) } }).select("displayName"),
    User.find({ _id: { $in: payouts.map((p) => p.user) } }).select("fullName email"),
  ]);
  const jobById = new Map(jobs.map((job) => [job.id, job]));
  const creatorProfileById = new Map(creatorProfiles.map((profile) => [profile.id, profile]));
  const userById = new Map(users.map((user) => [user.id, user]));

  res.status(200).json({
    data: payouts.map((payout) => ({
      id: payout.id,
      requestType: payout.requestType,
      targetType: payout.targetType,
      targetId: payout.targetId,
      jobTitle: jobById.get(payout.targetId.toString())?.jobTitle,
      creatorDisplayName: creatorProfileById.get(payout.targetId.toString())?.displayName,
      amount: payout.amount,
      currency: payout.currency,
      status: payout.status,
      settlementMethod: payout.settlementMethod,
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

// Same polymorphic lookup getSystemPayouts does in bulk, just for one
// record — what to call this transfer's target in a notification.
const resolveTargetLabel = async (payout: ISystemPayout): Promise<string> => {
  if (payout.targetType === SYSTEM_PAYOUT_TARGET_TYPE.DIGITAL_CREATOR_PROFILE) {
    return "your digital products";
  }

  const job = await Job.findById(payout.targetId).select("jobTitle");
  return job?.jobTitle ?? "a job";
};

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

// Refunds can draw from more than one successful Stripe Payment on the
// same job (it may have been funded in several separate charges over
// time) — walks the most recent first, refunding each up to its own
// amount until the requested total is covered. Deliberately doesn't try
// to pre-calculate how much of any one charge a PRIOR refund already
// used — Stripe itself rejects over-refunding a charge, and that failure
// is exactly what the caller's try/catch leaves PENDING for a human to
// look at, rather than this silently getting the math wrong.
const refundAcrossJobPayments = async (jobId: mongoose.Types.ObjectId, amount: number): Promise<string> => {
  const payments = await Payment.find({
    targetType: PAYMENT_TARGET_TYPE.JOB,
    targetId: jobId,
    provider: PAYMENT_PROVIDER_NAME.STRIPE,
    status: PAYMENT_STATUS.SUCCESS,
    providerPaymentId: { $exists: true },
  }).sort({ createdAt: -1 });

  let remaining = amount;
  const refundIds: string[] = [];

  for (const payment of payments) {
    if (remaining <= 0) break;

    const refundAmount = Math.min(remaining, payment.amount);
    const refundId = await createRefund({
      paymentIntentId: payment.providerPaymentId as string,
      amount: refundAmount,
    });

    refundIds.push(refundId);
    remaining -= refundAmount;
  }

  if (remaining > 0) {
    throw new Error("Not enough successful Stripe payments on this job to cover the full refund amount");
  }

  return refundIds.join(", ");
};

// @desc    Mark a pending transfer as actually paid. When
//          settlementMethod is 'manual' (today's unchanged behavior),
//          this just records that the admin/finance op already moved the
//          money by hand (bank transfer, Stripe dashboard, …). When it's
//          'stripe', this is the real trigger: a payout calls
//          stripe.transfers.create to the recipient's connected account;
//          a refund calls stripe.refunds.create against the job's own
//          successful charge(s). Deliberately kept as this one explicit
//          admin click rather than firing automatically the moment a
//          request is approved — "manually go to the dashboard and
//          authorize it" is exactly what the user asked for.
// @route   PATCH /api/system-payouts/:id/paid
// @access  Private (Admin / Super Admin only)
export const markSystemPayoutPaid = asyncHandler(async (req: Request, res: Response) => {
  const admin = req.user as IUser;
  const payout = await loadPendingPayout(req.params.id as string);

  if (payout.settlementMethod === SETTLEMENT_METHOD.MANUAL) {
    const { transferReference } = req.body;
    if (transferReference) payout.transferReference = transferReference;
  } else {
    try {
      if (payout.requestType === SYSTEM_PAYOUT_REQUEST_TYPE.PAYOUT) {
        const recipient = await User.findById(payout.user).select("stripeConnectedAccountId");

        if (!recipient?.stripeConnectedAccountId) {
          res.status(400);
          throw new Error("The recipient's Stripe Connect account is no longer on file");
        }

        payout.transferReference = await createTransfer({
          amount: payout.amount,
          currency: payout.currency,
          destinationAccountId: recipient.stripeConnectedAccountId,
          description: `PolyGrid payout — SystemPayout ${payout.id}`,
          metadata: { systemPayoutId: payout.id },
        });
      } else {
        payout.transferReference = await refundAcrossJobPayments(
          payout.targetId as mongoose.Types.ObjectId,
          payout.amount,
        );
      }
    } catch (err) {
      // Left PENDING on purpose — a Stripe-side failure (insufficient
      // available balance, a charge that can't cover its share, …) is
      // exactly the "try again later / look into this by hand" case,
      // never silently marked paid or failed.
      res.status(502);
      throw new Error(`Stripe settlement failed, left pending for retry: ${(err as Error).message}`);
    }
  }

  payout.status = SYSTEM_PAYOUT_STATUS.PAID;
  payout.settledBy = admin._id as mongoose.Types.ObjectId;
  payout.settledAt = new Date();

  await payout.save();

  await notifySystemPayoutSettled(payout, await resolveTargetLabel(payout), true);

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

  await notifySystemPayoutSettled(payout, await resolveTargetLabel(payout), false);

  res.status(200).json(payout);
});
