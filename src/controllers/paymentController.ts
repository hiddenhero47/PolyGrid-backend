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
import { DigitalPurchase, IDigitalPurchase, DIGITAL_PURCHASE_STATUS } from "../models/digitalPurchaseModel";
import { getPaymentProvider } from "../providers/paymentProviders";
import { getPlatformFeePercent } from "./jobController";
import {
  syncProfilesSubscription,
  supersedeActiveSubscriptions,
  getCarryoverDays,
  DAY_MS,
} from "../helpers/profileSubscriptionSync";
import { reconcilePaymentIntent } from "../helpers/paymentReconciliation";
import { copyPurchaseFiles } from "../helpers/digitalPurchaseFiles";
import {
  assertPaymentAllowed,
  resolveRail,
  buildTransactionCountries,
  resolveProviderForCountry,
  buildCallbackUrl,
} from "../helpers/paymentGuardrails";
import { constructConnectWebhookEvent } from "../helpers/stripeConnect";
import { completePaymentTarget } from "../helpers/paymentCompletion";
import { notifyPaymentHoldUpdate } from "../helpers/paymentHoldNotify";
import { getSystemSettings } from "../helpers/systemSettings";

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
  const { targetId, amount, currentPassword, otpToken, callbackPath } = req.body;

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

  await assertPaymentAllowed(requester, amount, PAYMENT_TARGET_TYPE.JOB, { currentPassword, otpToken });

  const providerUser = await User.findById(job.provider.userId).select("country");
  const rail = resolveRail(PAYMENT_TARGET_TYPE.JOB);
  const { provider: providerName, usdToNgnRate } = await resolveProviderForCountry(requester.country as string);

  const payment = await Payment.create({
    targetType: PAYMENT_TARGET_TYPE.JOB,
    targetId: job._id,
    user: requester._id,
    userEmail: requester.email,
    amount,
    currency: job.currency,
    provider: providerName,
    status: PAYMENT_STATUS.PENDING,
    rail,
    ...buildTransactionCountries(rail, requester.country, providerUser?.country),
  });

  const provider = getPaymentProvider(providerName);
  const { providerPaymentId, clientSecret, chargedAmount, chargedCurrency } = await provider.createIntent({
    amount,
    currency: job.currency,
    receiptEmail: requester.email,
    metadata: { paymentId: (payment._id as mongoose.Types.ObjectId).toString() },
    callbackUrl: buildCallbackUrl(callbackPath),
    usdToNgnRate,
  });

  payment.providerPaymentId = providerPaymentId;
  payment.providerChargedAmount = chargedAmount;
  payment.providerChargedCurrency = chargedCurrency;
  await payment.save();

  res.status(201).json({ clientSecret, paymentId: payment.id, provider: providerName });
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

  const rail = resolveRail(PAYMENT_TARGET_TYPE.SUBSCRIPTION);

  const payment = await Payment.create({
    targetType: PAYMENT_TARGET_TYPE.SUBSCRIPTION,
    targetId: subscription._id,
    user: requester._id,
    userEmail: requester.email,
    amount: 0,
    currency: plan.currency,
    provider: PAYMENT_PROVIDER_NAME.MANUAL,
    status: PAYMENT_STATUS.SUCCESS,
    rail,
    ...buildTransactionCountries(rail, requester.country),
  });

  return { subscriptionId: subscription.id, paymentId: payment.id };
};

const handleSubscriptionPaymentIntent = async (req: Request, res: Response): Promise<void> => {
  const requester = req.user as IUser;
  const { planTier, autoRenew, currentPassword, otpToken, callbackPath } = req.body;

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

  await assertPaymentAllowed(requester, plan.price, PAYMENT_TARGET_TYPE.SUBSCRIPTION, { currentPassword, otpToken });

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

  const rail = resolveRail(PAYMENT_TARGET_TYPE.SUBSCRIPTION);
  const { provider: providerName, usdToNgnRate } = await resolveProviderForCountry(requester.country as string);

  const payment = await Payment.create({
    targetType: PAYMENT_TARGET_TYPE.SUBSCRIPTION,
    targetId: subscription._id,
    user: requester._id,
    userEmail: requester.email,
    amount: plan.price,
    currency: plan.currency,
    provider: providerName,
    status: PAYMENT_STATUS.PENDING,
    rail,
    ...buildTransactionCountries(rail, requester.country),
  });

  const provider = getPaymentProvider(providerName);
  const { providerPaymentId, clientSecret, chargedAmount, chargedCurrency } = await provider.createIntent({
    amount: plan.price,
    currency: plan.currency,
    receiptEmail: requester.email,
    metadata: { paymentId: (payment._id as mongoose.Types.ObjectId).toString() },
    callbackUrl: buildCallbackUrl(callbackPath),
    usdToNgnRate,
  });

  payment.providerPaymentId = providerPaymentId;
  payment.providerChargedAmount = chargedAmount;
  payment.providerChargedCurrency = chargedCurrency;
  await payment.save();

  res
    .status(201)
    .json({
      requiresPayment: true,
      clientSecret,
      paymentId: payment.id,
      subscriptionId: subscription.id,
      provider: providerName,
    });
};

// Called when the buyer already has a PENDING DigitalPurchase for this
// product — their first attempt was abandoned (closed the card form) or
// the card failed, not actually completed. Never creates a second
// DigitalPurchase/competing PaymentIntent for the same buyer+product;
// always resolves back to this exact purchase.
const resumeDigitalPurchaseIntent = async (
  req: Request,
  res: Response,
  purchase: IDigitalPurchase,
): Promise<void> => {
  const requester = req.user as IUser;

  // Most recent first — resumeDigitalPurchaseIntent's own fallback branch
  // below can leave more than one Payment against the same purchase (an
  // old, dead one plus a fresh one), so the latest is always the live one.
  const payment = await Payment.findOne({
    targetType: PAYMENT_TARGET_TYPE.DIGITAL_PURCHASE,
    targetId: purchase._id,
  }).sort({ createdAt: -1 });

  if (payment?.providerPaymentId) {
    // Disputed — Stripe's own PaymentIntent still reads 'succeeded' (a
    // dispute doesn't change that), but reconcilePaymentIntent now
    // refuses to touch a DISPUTED payment at all (see its own comment),
    // so checked here first to refuse outright rather than retrieve an
    // intent only to then report a success that never happens. No
    // DIGITAL_PURCHASE_STATUS terminal-failure state exists to flip the
    // purchase itself to — this purchase is surfaced to admins via
    // GET /api/payments?hasDispute=true instead.
    if (payment.status === PAYMENT_STATUS.DISPUTED) {
      res.status(400);
      throw new Error("This purchase was disputed and can no longer be completed");
    }

    // Whichever gateway actually created this intent — not necessarily
    // what the buyer's country resolves to right now (that's only
    // consulted below, for a brand new intent); this one must match the
    // intent it's retrieving.
    const provider = getPaymentProvider(payment.provider);
    const intent = await provider.retrieveIntent(payment.providerPaymentId);

    // The charge actually went through at Stripe but our own webhook
    // never caught up (the exact scenario POST /payments/:id/refresh
    // exists for) — reconcile it now rather than ever creating a second
    // intent for a purchase that's already paid for. Reports the
    // *payment's* resulting status, not Stripe's intent.status — a held
    // payment reconciles to "success" at the Payment level (idempotency
    // guard short-circuits) but the purchase itself is still pending, so
    // this surfaces that rather than claiming the purchase is done.
    if (intent.status === "succeeded") {
      const result = await reconcilePaymentIntent(payment, payment.providerPaymentId, intent);
      res.status(200).json({
        status: result.status,
        held: payment.isOnHold,
        paymentId: payment.id,
        purchaseId: purchase.id,
      });
      return;
    }

    // Still live (requires_payment_method/confirmation/action,
    // processing) — this is the common case (a declined card, or the
    // buyer just closing the form). Stripe-only: its clientSecret can be
    // reused to retry confirmation from exactly where the buyer left
    // off, no new intent needed. Paystack has no equivalent — its
    // authorization_url is only ever returned once, at initialize time
    // (never again from retrieveIntent/verify), and nothing persists it
    // — so a still-pending Paystack attempt always falls through to a
    // fresh checkout below, same as a genuinely dead one.
    if (payment.provider === PAYMENT_PROVIDER_NAME.STRIPE && intent.status !== "canceled") {
      const clientSecret = (intent.raw as { client_secret: string | null } | null)?.client_secret ?? null;
      res
        .status(200)
        .json({ clientSecret, paymentId: payment.id, purchaseId: purchase.id, resumed: true, provider: payment.provider });
      return;
    }
  }

  await assertPaymentAllowed(requester, purchase.priceSnapshot, PAYMENT_TARGET_TYPE.DIGITAL_PURCHASE, {
    currentPassword: req.body?.currentPassword,
    otpToken: req.body?.otpToken,
  });

  const purchaseCreator = await DigitalCreatorProfile.findById(purchase.creator).select("userId");
  const creatorUser = purchaseCreator
    ? await User.findById(purchaseCreator.userId).select("country")
    : null;
  const rail = resolveRail(PAYMENT_TARGET_TYPE.DIGITAL_PURCHASE);
  const { provider: providerName, usdToNgnRate } = await resolveProviderForCountry(requester.country as string);

  // No provider intent at all (shouldn't happen in practice), or it's
  // genuinely dead (canceled) — a brand new Payment record, never the
  // old one. createIntent's idempotency key is derived from the Payment
  // id (see stripeProvider.ts), so reusing the old Payment's id here
  // would just hand back that same dead intent; a new Payment gives
  // the provider's own idempotency layer a fresh identity to mint a real
  // new one against.
  const freshPayment = await Payment.create({
    targetType: PAYMENT_TARGET_TYPE.DIGITAL_PURCHASE,
    targetId: purchase._id,
    user: requester._id,
    userEmail: requester.email,
    amount: purchase.priceSnapshot,
    currency: purchase.currency,
    provider: providerName,
    status: PAYMENT_STATUS.PENDING,
    rail,
    ...buildTransactionCountries(rail, requester.country, creatorUser?.country),
  });

  const { providerPaymentId, clientSecret, chargedAmount, chargedCurrency } = await getPaymentProvider(providerName).createIntent({
    amount: purchase.priceSnapshot,
    currency: purchase.currency,
    receiptEmail: requester.email,
    metadata: { paymentId: (freshPayment._id as mongoose.Types.ObjectId).toString() },
    callbackUrl: buildCallbackUrl(req.body?.callbackPath),
    usdToNgnRate,
  });

  freshPayment.providerPaymentId = providerPaymentId;
  freshPayment.providerChargedAmount = chargedAmount;
  freshPayment.providerChargedCurrency = chargedCurrency;
  await freshPayment.save();

  res
    .status(201)
    .json({ clientSecret, paymentId: freshPayment.id, purchaseId: purchase.id, resumed: true, provider: providerName });
};

// A digital product is bought directly, no Job/escrow involved at all —
// see docs/digital-storefront-plan.md. Blocks a duplicate purchase (one
// pending or successful DigitalPurchase per buyer+product is enough; a
// second attempt resumes the existing pending one — see
// resumeDigitalPurchaseIntent — rather than creating a competing
// PaymentIntent for something already bought or in progress).
// Also blocks buying from a creator who isn't currently subscribed/
// verified — same as that product being unreachable through the feed or
// its creator's page in the first place.
const handleDigitalPurchasePaymentIntent = async (req: Request, res: Response): Promise<void> => {
  const requester = req.user as IUser;
  const { targetId, currentPassword, otpToken, callbackPath } = req.body;

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
    if (existing.status === DIGITAL_PURCHASE_STATUS.SUCCESS) {
      res.status(400);
      throw new Error("You already own this product");
    }

    // Still pending — the earlier attempt may just have been abandoned
    // (closed the card form, a declined card), not actually failed at
    // Stripe. Resume it instead of permanently locking the buyer out of
    // ever buying this product again, which is what unconditionally
    // 400-ing here used to do.
    return resumeDigitalPurchaseIntent(req, res, existing);
  }

  if (product.price > 0) {
    await assertPaymentAllowed(requester, product.price, PAYMENT_TARGET_TYPE.DIGITAL_PURCHASE, {
      currentPassword,
      otpToken,
    });
  }

  const rail = resolveRail(PAYMENT_TARGET_TYPE.DIGITAL_PURCHASE);
  const creatorUser = await User.findById(creator.userId).select("country");

  const purchase = await DigitalPurchase.create({
    product: product._id,
    buyer: requester._id,
    creator: creator._id,
    priceSnapshot: product.price,
    currency: product.currency,
    status: DIGITAL_PURCHASE_STATUS.PENDING,
    // Snapshotted now — a later env change never retroactively changes
    // what this purchase owes the creator (see Job.platformFeePercent's
    // own reasoning).
    platformFeePercent: getPlatformFeePercent(),
    // Frozen now, before anything else can change — see
    // DigitalPurchase.fileManifest and docs/digital-storefront-plan.md.
    fileManifest: product.files.map((file) => ({
      fileName: file.fileName,
      key: file.key,
      mime: file.mime,
      size: file.size,
    })),
  });

  // A free product (price 0) has no real charge to make — Stripe's own
  // PaymentIntents reject a zero amount outright, same reasoning as
  // activateFreeSubscription above. Marks the purchase successful and
  // copies its files directly, with nothing to wait on.
  if (product.price <= 0) {
    purchase.status = DIGITAL_PURCHASE_STATUS.SUCCESS;
    await purchase.save();

    const payment = await Payment.create({
      targetType: PAYMENT_TARGET_TYPE.DIGITAL_PURCHASE,
      targetId: purchase._id,
      user: requester._id,
      userEmail: requester.email,
      amount: 0,
      currency: product.currency,
      provider: PAYMENT_PROVIDER_NAME.MANUAL,
      status: PAYMENT_STATUS.SUCCESS,
      rail,
      ...buildTransactionCountries(rail, requester.country, creatorUser?.country),
    });

    await copyPurchaseFiles(purchase._id as mongoose.Types.ObjectId);

    res.status(201).json({ requiresPayment: false, purchaseId: purchase.id, paymentId: payment.id });
    return;
  }

  const { provider: providerName, usdToNgnRate } = await resolveProviderForCountry(requester.country as string);

  const payment = await Payment.create({
    targetType: PAYMENT_TARGET_TYPE.DIGITAL_PURCHASE,
    targetId: purchase._id,
    user: requester._id,
    userEmail: requester.email,
    amount: product.price,
    currency: product.currency,
    provider: providerName,
    status: PAYMENT_STATUS.PENDING,
    rail,
    ...buildTransactionCountries(rail, requester.country, creatorUser?.country),
  });

  const provider = getPaymentProvider(providerName);
  const { providerPaymentId, clientSecret, chargedAmount, chargedCurrency } = await provider.createIntent({
    amount: product.price,
    currency: product.currency,
    receiptEmail: requester.email,
    metadata: { paymentId: (payment._id as mongoose.Types.ObjectId).toString() },
    callbackUrl: buildCallbackUrl(callbackPath),
    usdToNgnRate,
  });

  payment.providerPaymentId = providerPaymentId;
  payment.providerChargedAmount = chargedAmount;
  payment.providerChargedCurrency = chargedCurrency;
  await payment.save();

  res.status(201).json({ clientSecret, paymentId: payment.id, purchaseId: purchase.id, provider: providerName });
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

  if (event.type === "charge.dispute.created") {
    await handleChargeDispute(event.data as { payment_intent: string | null });
    return;
  }

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

// @desc    Paystack webhook — on charge.success, marks the Payment
//          successful and activates its target, same as stripeWebhook.
//          Separate route/signing scheme from Stripe's own webhook (see
//          paystackProvider.ts's constructWebhookEvent) — Paystack has no
//          charge.dispute.created equivalent wired up here yet.
// @route   POST /api/payments/paystack/webhook
// @access  Public — authenticated by Paystack's signature, not a user
//          token. Mounted on a raw body (see app.ts); never put `protect`
//          here.
export const paystackWebhook = asyncHandler(async (req: Request, res: Response) => {
  const signature = req.headers["x-paystack-signature"];

  if (typeof signature !== "string") {
    res.status(400);
    throw new Error("Missing Paystack signature");
  }

  const provider = getPaymentProvider(PAYMENT_PROVIDER_NAME.PAYSTACK);

  let event: { type: string; data: unknown };

  try {
    event = provider.constructWebhookEvent(req.body, signature);
  } catch (err) {
    res.status(400);
    throw new Error(`Webhook signature verification failed: ${(err as Error).message}`);
  }

  // Same "ack immediately" reasoning as stripeWebhook.
  res.sendStatus(200);

  if (event.type !== "charge.success") return;

  const chargeObject = event.data as { reference: string; metadata?: { paymentId?: string } };
  const paymentId = chargeObject.metadata?.paymentId;

  if (!paymentId || !mongoose.Types.ObjectId.isValid(paymentId)) return;

  const payment = await Payment.findById(paymentId);
  if (!payment) return;

  // Never trust the webhook payload's own claims — always re-fetch.
  const intent = await provider.retrieveIntent(chargeObject.reference);

  await reconcilePaymentIntent(payment, chargeObject.reference, intent);
});

// This is what makes the fraud hold (helpers/paymentReconciliation.ts)
// actually protective rather than just a dumb delay: if a dispute arrives
// while the payment is still held, nothing was ever credited/unlocked/
// activated — flip it to DISPUTED and stop, the hold did its job. If
// value was already released (never held, or the hold already cleared),
// automatic clawback is out of scope — this just records disputedAt so
// it's discoverable (GET /api/payments?hasDispute=true), and an admin
// decides what to do about it by hand.
const handleChargeDispute = async (dispute: { payment_intent: string | null }): Promise<void> => {
  if (!dispute.payment_intent) return;

  const payment = await Payment.findOne({ providerPaymentId: dispute.payment_intent });
  if (!payment) return;

  payment.disputedAt = new Date();

  if (payment.isOnHold) {
    payment.isOnHold = false;
    payment.status = PAYMENT_STATUS.DISPUTED;
  }

  await payment.save();
};

// @desc    Stripe Connect webhook — on account.updated, keeps
//          User.stripeConnectPayoutsEnabled in sync with Stripe's own
//          Account.payouts_enabled (true once onboarding/KYC is actually
//          complete). Registered as a separate "Connect" webhook in the
//          Stripe dashboard, with its own signing secret — see
//          helpers/stripeConnect.ts's constructConnectWebhookEvent.
// @route   POST /api/payments/stripe/connect-webhook
// @access  Public — authenticated by Stripe's signature, not a user token.
//          Mounted on a raw body (see app.ts); never put `protect` here.
export const stripeConnectWebhook = asyncHandler(async (req: Request, res: Response) => {
  const signature = req.headers["stripe-signature"];

  if (typeof signature !== "string") {
    res.status(400);
    throw new Error("Missing Stripe signature");
  }

  let event: { type: string; data: { object: { id: string; payouts_enabled?: boolean } } };

  try {
    event = constructConnectWebhookEvent(req.body, signature);
  } catch (err) {
    res.status(400);
    throw new Error(`Webhook signature verification failed: ${(err as Error).message}`);
  }

  // Acknowledge immediately — same reasoning as stripeWebhook above.
  res.sendStatus(200);

  if (event.type !== "account.updated") return;

  const account = event.data.object;

  await User.updateOne(
    { stripeConnectedAccountId: account.id },
    { stripeConnectPayoutsEnabled: Boolean(account.payouts_enabled) },
  );
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

  if (payment.provider === PAYMENT_PROVIDER_NAME.MANUAL) {
    res.status(400);
    throw new Error("Manually-recorded payments can't be refreshed this way");
  }

  if (!payment.providerPaymentId) {
    res.status(400);
    throw new Error("This payment was never started with the provider");
  }

  const provider = getPaymentProvider(payment.provider);
  const intent = await provider.retrieveIntent(payment.providerPaymentId);

  const result = await reconcilePaymentIntent(payment, payment.providerPaymentId, intent);

  res.status(200).json(result);
});

// @desc    Manually release a held payment (helpers/paymentReconciliation.ts)
//          right now — crediting escrow/unlocking a download/activating a
//          subscription immediately, regardless of whether holdReleaseAt
//          has passed. Admin discretion is its own override here, same
//          spirit as jobController.ts's approveRefundRequest/
//          approvePayoutRequest bypassReason — deliberately general-
//          purpose (works on any held payment, not only ones above
//          SystemSettings.manualReviewThresholdAmount), since the sweep
//          (helpers/paymentHoldRelease.ts) already handles the ordinary
//          case on its own; this is for whenever an admin wants to act
//          sooner than the timer, or on one the sweep deliberately
//          skipped for review.
// @route   POST /api/payments/:id/approve-hold
// @access  Private (Admin / Super Admin only)
export const approveHeldPayment = asyncHandler(async (req: Request, res: Response) => {
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

  if (!payment.isOnHold) {
    res.status(400);
    throw new Error("This payment isn't on hold");
  }

  await completePaymentTarget(payment);

  payment.isOnHold = false;
  await payment.save();

  await notifyPaymentHoldUpdate(payment, true);

  res.status(200).json(payment);
});
// @route   GET /api/payments
// @access  Private (Admin / Super Admin only)
export const getPayments = asyncHandler(async (req: Request, res: Response) => {
  const { page, limit, skip } = paginationParams(req);
  const { status, targetType, targetId, user, provider, hasDispute, pendingManualReview, isOnHold } = req.query as {
    status?: string;
    targetType?: string;
    targetId?: string;
    user?: string;
    provider?: string;
    hasDispute?: string;
    pendingManualReview?: string;
    isOnHold?: string;
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

  // Surfaces a dispute whose value was already released (no automatic
  // clawback — see paymentController.ts's handleChargeDispute) without
  // needing a new admin-notification mechanism; a fully-intercepted
  // dispute is already findable via status=disputed above.
  if (hasDispute === "true") {
    filter.disputedAt = { $exists: true };
  }

  // Every currently-held payment, regardless of amount — broader than
  // pendingManualReview below (which only covers the ones above the
  // review threshold, and with a threshold set higher than
  // maxTransactionAmount, that can be none of them at all). Lets the
  // admin ledger list routine 24h holds as a group too.
  if (isOnHold === "true") {
    filter.isOnHold = true;
  }

  // Resolved against the *current* setting value, not a stored flag —
  // same instinct as every other SystemSettings-driven check this
  // session — so raising/lowering manualReviewThresholdAmount is
  // reflected immediately, not just for payments created afterward.
  if (pendingManualReview === "true") {
    const settings = await getSystemSettings();
    filter.isOnHold = true;
    filter.amount = { $gt: settings.manualReviewThresholdAmount };
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
