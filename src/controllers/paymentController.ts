import mongoose, { FilterQuery } from "mongoose";
import asyncHandler from "express-async-handler";
import { Request, Response } from "express";
import { Payment, IPayment, PAYMENT_STATUS, PAYMENT_TARGET_TYPE, PaymentStatus, PaymentTargetType } from "../models/paymentModel";
import { PAYMENT_PROVIDER_NAME } from "../models/paymentProviderModel";
import { IUser, User, SYSTEM_ROLE } from "../models/userModel";
import { Job, JOB_STATUS } from "../models/jobModel";
import { Plan, IPlan } from "../models/planModel";
import { Subscription, SUBSCRIPTION_STATUS } from "../models/subscriptionModel";
import { DigitalProduct } from "../models/digitalProductModel";
import { DigitalCreatorProfile } from "../models/digitalCreatorProfileModel";
import { DigitalPurchase, DIGITAL_PURCHASE_STATUS } from "../models/digitalPurchaseModel";
import { getPaymentProvider } from "../providers/paymentProviders";
import {
  syncProfilesSubscription,
  supersedeActiveSubscriptions,
  getCarryoverDays,
  DAY_MS,
} from "../helpers/profileSubscriptionSync";
import { reconcilePaymentIntent } from "../helpers/paymentReconciliation";

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

// A free plan (price 0) has no real charge to make — Stripe's own
// PaymentIntents reject a zero amount outright (there's a platform
// minimum), so routing a free plan through the same checkout call below
// would just error. Activates it directly instead: same
// create-subscription/supersede/sync sequence the webhook runs after a
// real payment succeeds, just with nothing to wait on. Still writes a
// Payment record (provider: 'manual', same as grantSubscription's
// admin-granted path) so a user's history shows how every subscription
// they've ever had was actually acquired, free ones included.
const activateFreeSubscription = async (
  requester: IUser,
  plan: IPlan,
  autoRenew: boolean,
): Promise<{ subscriptionId: string; paymentId: string }> => {
  const periodStarted = new Date();
  const carryoverDays = await getCarryoverDays(requester._id as mongoose.Types.ObjectId);
  const expiresAt = new Date(periodStarted.getTime() + (plan.duration + carryoverDays) * DAY_MS);

  const subscription = await Subscription.create({
    user: requester._id,
    plan: plan._id,
    planTier: plan.planTier,
    privileges: plan.privileges,
    autoRenew: Boolean(autoRenew),
    status: SUBSCRIPTION_STATUS.ACTIVE,
    periodStarted,
    expiresAt,
  });

  await User.updateOne({ _id: requester._id }, { currentSubscription: subscription._id });
  await supersedeActiveSubscriptions(requester._id as mongoose.Types.ObjectId, subscription._id as mongoose.Types.ObjectId);
  await syncProfilesSubscription(requester._id as mongoose.Types.ObjectId, subscription._id as mongoose.Types.ObjectId);

  const payment = await Payment.create({
    targetType: PAYMENT_TARGET_TYPE.SUBSCRIPTION,
    targetId: subscription._id,
    user: requester._id,
    userEmail: requester.email,
    amount: 0,
    currency: plan.currency,
    provider: PAYMENT_PROVIDER_NAME.MANUAL,
    status: PAYMENT_STATUS.SUCCESS,
  });

  return { subscriptionId: subscription.id, paymentId: payment.id };
};

const handleSubscriptionPaymentIntent = async (req: Request, res: Response): Promise<void> => {
  const requester = req.user as IUser;
  const { planTier, autoRenew } = req.body;

  const plan = await Plan.findOne({ planTier, isActive: true });

  if (!plan) {
    res.status(400);
    throw new Error("No active plan found for that tier");
  }

  if (plan.price <= 0) {
    const { subscriptionId, paymentId } = await activateFreeSubscription(requester, plan, Boolean(autoRenew));
    res.status(201).json({ requiresPayment: false, status: "active", subscriptionId, paymentId });
    return;
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
    .json({ requiresPayment: true, clientSecret, paymentId: payment.id, subscriptionId: subscription.id });
};

// A digital product is bought directly, no Job/escrow involved at all —
// see docs/digital-storefront-plan.md. Blocks a duplicate purchase (one
// pending or successful DigitalPurchase per buyer+product is enough; a
// second attempt just points at the existing one rather than creating a
// competing PaymentIntent for something already bought or in progress).
// Also blocks buying from a creator who isn't currently subscribed/
// verified — same as that product being unreachable through the feed or
// its creator's page in the first place.
const handleDigitalPurchasePaymentIntent = async (req: Request, res: Response): Promise<void> => {
  const requester = req.user as IUser;
  const { targetId } = req.body;

  const product = await DigitalProduct.findById(targetId);
  if (!product || !product.isActive) {
    res.status(404);
    throw new Error("Digital product not found");
  }

  const creator = await DigitalCreatorProfile.findById(product.creatorId);
  const subscription = creator?.currentSubscription
    ? await Subscription.findById(creator.currentSubscription)
    : null;

  if (!creator?.isVerified || !subscription?.isActive()) {
    res.status(404);
    throw new Error("Digital product not found");
  }

  if (creator.userId.toString() === requester.id) {
    res.status(400);
    throw new Error("You can't buy your own product");
  }

  const existing = await DigitalPurchase.findOne({ product: product._id, buyer: requester._id });
  if (existing) {
    res.status(400);
    throw new Error(
      existing.status === DIGITAL_PURCHASE_STATUS.SUCCESS
        ? "You already own this product"
        : "You already have a pending purchase for this product",
    );
  }

  const purchase = await DigitalPurchase.create({
    product: product._id,
    buyer: requester._id,
    creator: creator._id,
    priceSnapshot: product.price,
    currency: product.currency,
    status: DIGITAL_PURCHASE_STATUS.PENDING,
    // Frozen now, before anything else can change — see
    // DigitalPurchase.fileManifest and docs/digital-storefront-plan.md.
    fileManifest: product.files.map((file) => ({
      fileName: file.fileName,
      key: file.key,
      mime: file.mime,
      size: file.size,
    })),
  });

  const payment = await Payment.create({
    targetType: PAYMENT_TARGET_TYPE.DIGITAL_PURCHASE,
    targetId: purchase._id,
    user: requester._id,
    userEmail: requester.email,
    amount: product.price,
    currency: product.currency,
    provider: PAYMENT_PROVIDER_NAME.STRIPE,
    status: PAYMENT_STATUS.PENDING,
  });

  const provider = getPaymentProvider(PAYMENT_PROVIDER_NAME.STRIPE);
  const { providerPaymentId, clientSecret } = await provider.createIntent({
    amount: product.price,
    currency: product.currency,
    receiptEmail: requester.email,
    metadata: { paymentId: (payment._id as mongoose.Types.ObjectId).toString() },
  });

  payment.providerPaymentId = providerPaymentId;
  await payment.save();

  res.status(201).json({ clientSecret, paymentId: payment.id, purchaseId: purchase.id });
};

// @desc    Create a Stripe PaymentIntent to fund a job's escrow, purchase a
//          subscription, or buy a digital product. Only creates the
//          intent — nothing is confirmed paid until the webhook says so.
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

  return handleDigitalPurchasePaymentIntent(req, res);
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

  await reconcilePaymentIntent(payment, intentObject.id, intent);
});

// @desc    Re-check a still-pending payment directly against the provider —
//          recovery path for when the webhook never arrives (misconfigured
//          webhook URL, an outage, a dev tunnel restarting mid-session):
//          the charge may have genuinely succeeded at Stripe while this
//          payment is stuck 'pending' here. Runs the exact same
//          reconciliation the webhook would have, so it's always safe to
//          call — on an already-'success' payment it's a pure no-op.
// @route   POST /api/payments/:id/refresh
// @access  Private (payment owner or admin)
export const refreshPayment = asyncHandler(async (req: Request, res: Response) => {
  const requester = req.user as IUser;
  const id = req.params.id as string;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    res.status(404);
    throw new Error("Payment not found");
  }

  const payment = await Payment.findById(id);
  if (!payment) {
    res.status(404);
    throw new Error("Payment not found");
  }

  const isOwner = payment.user.toString() === requester.id;
  const isAdmin =
    requester.systemRole === SYSTEM_ROLE.ADMIN || requester.systemRole === SYSTEM_ROLE.SUPER_ADMIN;

  if (!isOwner && !isAdmin) {
    res.status(403);
    throw new Error("You can't refresh someone else's payment");
  }

  if (payment.provider !== PAYMENT_PROVIDER_NAME.STRIPE) {
    res.status(400);
    throw new Error("Only Stripe payments can be refreshed this way");
  }

  if (!payment.providerPaymentId) {
    res.status(400);
    throw new Error("This payment was never started with the provider");
  }

  const provider = getPaymentProvider(PAYMENT_PROVIDER_NAME.STRIPE);
  const intent = await provider.retrieveIntent(payment.providerPaymentId);

  const result = await reconcilePaymentIntent(payment, payment.providerPaymentId, intent);

  res.status(200).json(result);
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
