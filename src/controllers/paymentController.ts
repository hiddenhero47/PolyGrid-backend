import mongoose, { FilterQuery } from "mongoose";
import asyncHandler from "express-async-handler";
import { Request, Response } from "express";
import { Payment, IPayment, PAYMENT_STATUS, PAYMENT_TARGET_TYPE, PaymentStatus, PaymentTargetType } from "../models/paymentModel";
import { PAYMENT_PROVIDER_NAME } from "../models/paymentProviderModel";
import { IUser, User } from "../models/userModel";
import { Job, JOB_STATUS } from "../models/jobModel";
import { Plan } from "../models/planModel";
import { Subscription, SUBSCRIPTION_STATUS } from "../models/subscriptionModel";
import { getPaymentProvider } from "../providers/paymentProviders";

const DAY_MS = 24 * 60 * 60 * 1000;

const paginationParams = (req: Request) => {
  const page = Math.max(Number(req.query.page) || 1, 1);
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  return { page, limit, skip: (page - 1) * limit };
};

// @desc    Get the logged-in user's own payment history, newest first
// @route   GET /api/payments/me
// @access  Private
export const getMyPayments = asyncHandler(async (req: Request, res: Response) => {
  const { page, limit, skip } = paginationParams(req);
  const filter: FilterQuery<IPayment> = { user: (req.user as IUser)._id };

  const status = req.query.status as string | undefined;
  if (status && Object.values(PAYMENT_STATUS).includes(status as PaymentStatus)) {
    filter.status = status as PaymentStatus;
  }

  const [data, total] = await Promise.all([
    Payment.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    Payment.countDocuments(filter),
  ]);

  res.status(200).json({
    data,
    pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
  });
});

const handleJobPaymentIntent = async (req: Request, res: Response): Promise<void> => {
  const requester = req.user as IUser;
  const { targetId, amount } = req.body;

  if (!targetId || !mongoose.Types.ObjectId.isValid(targetId) || !amount || amount <= 0) {
    res.status(400);
    throw new Error("Please add a valid targetId and a positive amount");
  }

  const job = await Job.findById(targetId);

  if (!job) {
    res.status(404);
    throw new Error("Job not found");
  }

  if (job.client.userId.toString() !== requester.id) {
    res.status(403);
    throw new Error("Only the job's client can fund it");
  }

  if (job.status !== JOB_STATUS.ACTIVE) {
    res.status(400);
    throw new Error("This job is not active");
  }

  const payment = await Payment.create({
    targetType: PAYMENT_TARGET_TYPE.JOB,
    targetId: job._id,
    user: requester._id,
    userEmail: requester.email,
    amount,
    currency: job.currency,
    provider: PAYMENT_PROVIDER_NAME.STRIPE,
    status: PAYMENT_STATUS.PENDING,
  });

  const provider = getPaymentProvider(PAYMENT_PROVIDER_NAME.STRIPE);
  const { providerPaymentId, clientSecret } = await provider.createIntent({
    amount,
    currency: job.currency,
    receiptEmail: requester.email,
    metadata: { paymentId: (payment._id as mongoose.Types.ObjectId).toString() },
  });

  payment.providerPaymentId = providerPaymentId;
  await payment.save();

  res.status(201).json({ clientSecret, paymentId: payment.id });
};

const handleSubscriptionPaymentIntent = async (req: Request, res: Response): Promise<void> => {
  const requester = req.user as IUser;
  const { planTier, autoRenew } = req.body;

  if (!planTier) {
    res.status(400);
    throw new Error("Please add a planTier");
  }

  const plan = await Plan.findOne({ planTier, isActive: true });

  if (!plan) {
    res.status(400);
    throw new Error("No active plan found for that tier");
  }

  // Tentative — the clock actually starts once the webhook confirms
  // payment, not at checkout time. Recomputed then; this just satisfies
  // the schema's required fields for a not-yet-paid-for subscription.
  const periodStarted = new Date();
  const expiresAt = new Date(periodStarted.getTime() + plan.duration * DAY_MS);

  const subscription = await Subscription.create({
    user: requester._id,
    plan: plan._id,
    planTier: plan.planTier,
    privileges: plan.privileges,
    autoRenew: Boolean(autoRenew),
    status: SUBSCRIPTION_STATUS.PENDING,
    periodStarted,
    expiresAt,
  });

  const payment = await Payment.create({
    targetType: PAYMENT_TARGET_TYPE.SUBSCRIPTION,
    targetId: subscription._id,
    user: requester._id,
    userEmail: requester.email,
    amount: plan.price,
    currency: plan.currency,
    provider: PAYMENT_PROVIDER_NAME.STRIPE,
    status: PAYMENT_STATUS.PENDING,
  });

  const provider = getPaymentProvider(PAYMENT_PROVIDER_NAME.STRIPE);
  const { providerPaymentId, clientSecret } = await provider.createIntent({
    amount: plan.price,
    currency: plan.currency,
    receiptEmail: requester.email,
    metadata: { paymentId: (payment._id as mongoose.Types.ObjectId).toString() },
  });

  payment.providerPaymentId = providerPaymentId;
  await payment.save();

  res
    .status(201)
    .json({ clientSecret, paymentId: payment.id, subscriptionId: subscription.id });
};

// @desc    Create a Stripe PaymentIntent to fund a job's escrow or purchase
//          a subscription. Only creates the intent — nothing is confirmed
//          paid until the webhook says so.
// @route   POST /api/payments/intent
// @access  Private
export const createPaymentIntent = asyncHandler(async (req: Request, res: Response) => {
  const { targetType } = req.body;

  if (targetType === PAYMENT_TARGET_TYPE.JOB) {
    return handleJobPaymentIntent(req, res);
  }

  if (targetType === PAYMENT_TARGET_TYPE.SUBSCRIPTION) {
    return handleSubscriptionPaymentIntent(req, res);
  }

  res.status(400);
  throw new Error("targetType must be 'Job' or 'Subscription'");
});

// @desc    Stripe webhook — on payment_intent.succeeded, marks the Payment
//          successful and activates its target (funds the job's escrow, or
//          activates the pending subscription)
// @route   POST /api/payments/stripe/webhook
// @access  Public — authenticated by Stripe's signature, not a user token.
//          Mounted on a raw body (see app.ts); never put `protect` here.
export const stripeWebhook = asyncHandler(async (req: Request, res: Response) => {
  const signature = req.headers["stripe-signature"];

  if (typeof signature !== "string") {
    res.status(400);
    throw new Error("Missing Stripe signature");
  }

  const provider = getPaymentProvider(PAYMENT_PROVIDER_NAME.STRIPE);

  let event: { type: string; data: unknown };

  try {
    event = provider.constructWebhookEvent(req.body, signature);
  } catch (err) {
    res.status(400);
    throw new Error(`Webhook signature verification failed: ${(err as Error).message}`);
  }

  // Acknowledge immediately — Stripe only needs a 2xx to stop retrying
  // delivery; our own DB work happening after this shouldn't be mistaken
  // for a failed delivery if it's slow. Same reasoning as HM's
  // processStripeEvent. errorMiddleware.ts checks res.headersSent before
  // writing again, so a later throw here is handled safely.
  res.sendStatus(200);

  if (event.type !== "payment_intent.succeeded") return;

  const intentObject = event.data as { id: string; metadata?: { paymentId?: string } };
  const paymentId = intentObject.metadata?.paymentId;

  if (!paymentId || !mongoose.Types.ObjectId.isValid(paymentId)) return;

  const payment = await Payment.findById(paymentId);
  if (!payment) return;

  // Never trust the webhook payload's own claims — always re-fetch.
  const intent = await provider.retrieveIntent(intentObject.id);

  const isSuccess = intent.status === "succeeded";
  const isAmount = Math.round(intent.amount * 100) === Math.round(payment.amount * 100);
  const isCurrency = intent.currency.toUpperCase() === payment.currency.toUpperCase();

  if (!isSuccess || !isAmount || !isCurrency) return;

  // Idempotency: Stripe redelivering the same event for an already-recorded
  // payment is a no-op, not a double-credit.
  if (payment.status === PAYMENT_STATUS.SUCCESS && payment.providerPaymentId === intentObject.id) {
    return;
  }

  payment.status = PAYMENT_STATUS.SUCCESS;
  payment.providerPaymentId = intentObject.id;
  payment.providerFeeAmount = intent.feeAmount;
  payment.rawProviderPayload = intent.raw as Record<string, unknown>;
  await payment.save();

  if (payment.targetType === PAYMENT_TARGET_TYPE.JOB) {
    await Job.updateOne({ _id: payment.targetId }, { $inc: { amountPaid: payment.amount } });
    return;
  }

  const subscription = await Subscription.findById(payment.targetId);

  if (subscription && subscription.status === SUBSCRIPTION_STATUS.PENDING) {
    const plan = await Plan.findById(subscription.plan);
    const periodStarted = new Date();

    subscription.status = SUBSCRIPTION_STATUS.ACTIVE;
    subscription.periodStarted = periodStarted;
    subscription.expiresAt = new Date(periodStarted.getTime() + (plan?.duration ?? 30) * DAY_MS);
    await subscription.save();

    await User.updateOne(
      { _id: subscription.user },
      { currentSubscription: subscription._id },
    );
  }
});
// @route   GET /api/payments
// @access  Private (Admin / Super Admin only)
export const getPayments = asyncHandler(async (req: Request, res: Response) => {
  const { page, limit, skip } = paginationParams(req);
  const { status, targetType, targetId, user, provider } = req.query as {
    status?: string;
    targetType?: string;
    targetId?: string;
    user?: string;
    provider?: string;
  };

  const filter: FilterQuery<IPayment> = {};

  if (status && Object.values(PAYMENT_STATUS).includes(status as PaymentStatus)) {
    filter.status = status as PaymentStatus;
  }

  if (targetType && Object.values(PAYMENT_TARGET_TYPE).includes(targetType as PaymentTargetType)) {
    filter.targetType = targetType as PaymentTargetType;
  }

  if (targetId && mongoose.Types.ObjectId.isValid(targetId)) {
    filter.targetId = targetId as unknown as mongoose.Types.ObjectId;
  }

  if (user && mongoose.Types.ObjectId.isValid(user)) {
    filter.user = user as unknown as mongoose.Types.ObjectId;
  }

  if (provider) {
    filter.provider = provider as IPayment["provider"];
  }

  const [data, total] = await Promise.all([
    Payment.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    Payment.countDocuments(filter),
  ]);

  res.status(200).json({
    data,
    pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
  });
});
