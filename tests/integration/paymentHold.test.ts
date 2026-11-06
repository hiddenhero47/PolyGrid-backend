// No real Mailgun call — same "mock the third-party integration
// entirely" boundary tests/README.md documents for helpers/emailSender.
jest.mock("../../src/helpers/emailSender", () => ({
  sendTemplatedEmail: jest.fn().mockResolvedValue({}),
  loadTemplates: jest.fn().mockResolvedValue(undefined),
}));

// Same boundary for the digital-purchase completion path's file copy —
// only ever exercised by the release test below, never by the hold tests
// (completion is exactly what a hold defers).
jest.mock("../../src/providers/digitalStorageProviders", () => {
  const adapter = { copyDigitalFile: jest.fn() };
  return { getDigitalStorageProvider: () => adapter };
});

import request from "supertest";
import Stripe from "stripe";
import createApp from "../../src/app";
import { connectTestDB, disconnectTestDB, clearTestDB } from "../setup/db";
import {
  createUser,
  createAdmin,
  createActiveJob,
  createPlan,
  createSubscription,
  createUserWithActiveSubscription,
  createDigitalCreatorProfile,
  createDigitalProduct,
  createDigitalPurchase,
  generateToken,
} from "../setup/fixtures";
import { Payment, PAYMENT_TARGET_TYPE, PAYMENT_STATUS, PAYMENT_RAIL } from "../../src/models/paymentModel";
import { PAYMENT_PROVIDER_NAME } from "../../src/models/paymentProviderModel";
import { Job } from "../../src/models/jobModel";
import { Subscription, SUBSCRIPTION_STATUS } from "../../src/models/subscriptionModel";
import { DigitalPurchase, DIGITAL_PURCHASE_STATUS } from "../../src/models/digitalPurchaseModel";
import { SystemSettings } from "../../src/models/systemSettingsModel";
import { Notification, NOTIFICATION_TYPE } from "../../src/models/notificationModel";
import { reconcilePaymentIntent } from "../../src/helpers/paymentReconciliation";
import { releaseExpiredPaymentHolds } from "../../src/helpers/paymentHoldRelease";
import { getOutstandingExposure } from "../../src/helpers/paymentGuardrails";
import { stripeProvider } from "../../src/providers/paymentProviders/stripeProvider";

const app = createApp();

// The webhook handler acks Stripe with 200 before its DB work finishes
// (same reasoning as payment.test.ts's own waitFor) — supertest's request
// resolves the instant that response is sent, which can be before
// handleChargeDispute's payment.save() actually completes.
const waitFor = async (
  check: () => Promise<boolean>,
  { timeoutMs = 5000, intervalMs = 100 } = {},
): Promise<void> => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
};

beforeAll(async () => {
  await connectTestDB();
});

afterEach(async () => {
  await clearTestDB();
  jest.clearAllMocks();
  jest.restoreAllMocks();
});

afterAll(async () => {
  await disconnectTestDB();
});

const succeededIntent = (amount: number, currency = "USD") => ({
  status: "succeeded",
  amount,
  currency,
  feeAmount: 0,
  raw: {},
});

describe("reconcilePaymentIntent — fraud hold (helpers/paymentReconciliation.ts)", () => {
  it("holds a Job payment over the threshold instead of crediting escrow immediately", async () => {
    await SystemSettings.create({
      maxOutstandingExposure: 0,
      maxTransactionAmount: 0,
      supportedCountries: [],
      fraudHoldThresholdAmount: 100,
      fraudHoldHours: 24,
      cardBlockThresholdAmount: 0,
    });

    const client = await createUser();
    const provider = await createUser();
    const job = await createActiveJob({ client, provider });

    const payment = await Payment.create({
      targetType: PAYMENT_TARGET_TYPE.JOB,
      targetId: job._id,
      user: client._id,
      userEmail: client.email,
      amount: 500,
      currency: "USD",
      provider: PAYMENT_PROVIDER_NAME.STRIPE,
      status: PAYMENT_STATUS.PENDING,
      rail: PAYMENT_RAIL.MARKETPLACE,
      providerPaymentId: "pi_hold_job",
    });

    const result = await reconcilePaymentIntent(payment, "pi_hold_job", succeededIntent(500));

    expect(result.status).toBe("success");
    expect(payment.status).toBe("success");
    expect(payment.isOnHold).toBe(true);
    expect(payment.holdReleaseAt).toBeInstanceOf(Date);
    expect(payment.holdReleaseAt!.getTime()).toBeGreaterThan(Date.now());

    const updatedJob = await Job.findById(job._id);
    expect(updatedJob?.amountPaid).toBe(0);

    // The bell needs to open this exact job, not a generic payments page.
    const notification = await Notification.findOne({
      userId: client._id,
      type: NOTIFICATION_TYPE.PAYMENT_ON_HOLD,
    });
    expect(notification?.data).toMatchObject({
      targetType: PAYMENT_TARGET_TYPE.JOB,
      targetId: job._id,
    });
  });

  it("holds a digital purchase over the threshold instead of unlocking the download", async () => {
    await SystemSettings.create({
      maxOutstandingExposure: 0,
      maxTransactionAmount: 0,
      supportedCountries: [],
      fraudHoldThresholdAmount: 100,
      fraudHoldHours: 24,
      cardBlockThresholdAmount: 0,
    });

    const creatorUser = await createUser();
    const profile = await createDigitalCreatorProfile({ user: creatorUser });
    const product = await createDigitalProduct({ creator: profile, price: 500 });
    const buyer = await createUser();
    const purchase = await createDigitalPurchase({
      product,
      buyer,
      creator: profile,
      status: DIGITAL_PURCHASE_STATUS.PENDING,
      files: [],
    });

    const payment = await Payment.create({
      targetType: PAYMENT_TARGET_TYPE.DIGITAL_PURCHASE,
      targetId: purchase._id,
      user: buyer._id,
      userEmail: buyer.email,
      amount: 500,
      currency: "USD",
      provider: PAYMENT_PROVIDER_NAME.STRIPE,
      status: PAYMENT_STATUS.PENDING,
      rail: PAYMENT_RAIL.MARKETPLACE,
      providerPaymentId: "pi_hold_digital",
    });

    await reconcilePaymentIntent(payment, "pi_hold_digital", succeededIntent(500));

    expect(payment.isOnHold).toBe(true);

    const updatedPurchase = await DigitalPurchase.findById(purchase._id);
    expect(updatedPurchase?.status).toBe("pending");
    expect(updatedPurchase?.files).toHaveLength(0);
  });

  it("holds a subscription payment over the threshold instead of activating it", async () => {
    await SystemSettings.create({
      maxOutstandingExposure: 0,
      maxTransactionAmount: 0,
      supportedCountries: [],
      fraudHoldThresholdAmount: 100,
      fraudHoldHours: 24,
      cardBlockThresholdAmount: 0,
    });

    const user = await createUser();
    const plan = await createPlan({ price: 500 });
    const subscription = await createSubscription({ user, plan, status: SUBSCRIPTION_STATUS.PENDING });

    const payment = await Payment.create({
      targetType: PAYMENT_TARGET_TYPE.SUBSCRIPTION,
      targetId: subscription._id,
      user: user._id,
      userEmail: user.email,
      amount: 500,
      currency: "USD",
      provider: PAYMENT_PROVIDER_NAME.STRIPE,
      status: PAYMENT_STATUS.PENDING,
      rail: PAYMENT_RAIL.PLATFORM,
      providerPaymentId: "pi_hold_sub",
    });

    await reconcilePaymentIntent(payment, "pi_hold_sub", succeededIntent(500));

    expect(payment.isOnHold).toBe(true);

    const updatedSubscription = await Subscription.findById(subscription._id);
    expect(updatedSubscription?.status).toBe("pending");
  });

  it("does not hold a payment at or below the threshold — completes immediately as before", async () => {
    await SystemSettings.create({
      maxOutstandingExposure: 0,
      maxTransactionAmount: 0,
      supportedCountries: [],
      fraudHoldThresholdAmount: 500,
      fraudHoldHours: 24,
      cardBlockThresholdAmount: 0,
    });

    const client = await createUser();
    const provider = await createUser();
    const job = await createActiveJob({ client, provider });

    const payment = await Payment.create({
      targetType: PAYMENT_TARGET_TYPE.JOB,
      targetId: job._id,
      user: client._id,
      userEmail: client.email,
      amount: 500,
      currency: "USD",
      provider: PAYMENT_PROVIDER_NAME.STRIPE,
      status: PAYMENT_STATUS.PENDING,
      rail: PAYMENT_RAIL.MARKETPLACE,
      providerPaymentId: "pi_no_hold_job",
    });

    await reconcilePaymentIntent(payment, "pi_no_hold_job", succeededIntent(500));

    expect(payment.isOnHold).toBe(false);
    const updatedJob = await Job.findById(job._id);
    expect(updatedJob?.amountPaid).toBe(500);
  });
});

describe("releaseExpiredPaymentHolds (helpers/paymentHoldRelease.ts)", () => {
  it("releases a payment whose hold window has passed, completing the deferred target", async () => {
    await SystemSettings.create({
      maxOutstandingExposure: 0,
      maxTransactionAmount: 0,
      supportedCountries: [],
      fraudHoldThresholdAmount: 0,
      fraudHoldHours: 24,
      manualReviewThresholdAmount: 1_000_000,
    });

    const client = await createUser();
    const provider = await createUser();
    const job = await createActiveJob({ client, provider });

    const payment = await Payment.create({
      targetType: PAYMENT_TARGET_TYPE.JOB,
      targetId: job._id,
      user: client._id,
      userEmail: client.email,
      amount: 500,
      currency: "USD",
      provider: PAYMENT_PROVIDER_NAME.STRIPE,
      status: PAYMENT_STATUS.SUCCESS,
      rail: PAYMENT_RAIL.MARKETPLACE,
      providerPaymentId: "pi_release_due",
      isOnHold: true,
      holdReleaseAt: new Date(Date.now() - 1000),
    });

    const { checked, released } = await releaseExpiredPaymentHolds();

    expect(checked).toBe(1);
    expect(released).toBe(1);

    const updatedPayment = await Payment.findById(payment.id);
    expect(updatedPayment?.isOnHold).toBe(false);

    const updatedJob = await Job.findById(job._id);
    expect(updatedJob?.amountPaid).toBe(500);
  });

  it("leaves a payment alone whose hold window hasn't passed yet", async () => {
    const client = await createUser();
    const provider = await createUser();
    const job = await createActiveJob({ client, provider });

    await Payment.create({
      targetType: PAYMENT_TARGET_TYPE.JOB,
      targetId: job._id,
      user: client._id,
      userEmail: client.email,
      amount: 500,
      currency: "USD",
      provider: PAYMENT_PROVIDER_NAME.STRIPE,
      status: PAYMENT_STATUS.SUCCESS,
      rail: PAYMENT_RAIL.MARKETPLACE,
      providerPaymentId: "pi_release_not_due",
      isOnHold: true,
      holdReleaseAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    const { checked, released } = await releaseExpiredPaymentHolds();

    expect(checked).toBe(0);
    expect(released).toBe(0);

    const updatedJob = await Job.findById(job._id);
    expect(updatedJob?.amountPaid).toBe(0);
  });

  it("does not auto-release a due payment above manualReviewThresholdAmount — leaves it for an admin", async () => {
    await SystemSettings.create({
      maxOutstandingExposure: 0,
      maxTransactionAmount: 0,
      supportedCountries: [],
      fraudHoldThresholdAmount: 0,
      fraudHoldHours: 24,
      manualReviewThresholdAmount: 100,
    });

    const client = await createUser();
    const provider = await createUser();
    const job = await createActiveJob({ client, provider });

    const payment = await Payment.create({
      targetType: PAYMENT_TARGET_TYPE.JOB,
      targetId: job._id,
      user: client._id,
      userEmail: client.email,
      amount: 500,
      currency: "USD",
      provider: PAYMENT_PROVIDER_NAME.STRIPE,
      status: PAYMENT_STATUS.SUCCESS,
      rail: PAYMENT_RAIL.MARKETPLACE,
      providerPaymentId: "pi_needs_review",
      isOnHold: true,
      holdReleaseAt: new Date(Date.now() - 1000),
    });

    const { checked, released } = await releaseExpiredPaymentHolds();

    expect(checked).toBe(1);
    expect(released).toBe(0);

    const updatedPayment = await Payment.findById(payment.id);
    expect(updatedPayment?.isOnHold).toBe(true);

    const updatedJob = await Job.findById(job._id);
    expect(updatedJob?.amountPaid).toBe(0);
  });
});

describe("getOutstandingExposure counts held payments (helpers/paymentGuardrails.ts)", () => {
  it("includes a held payment's amount even though it hasn't been credited to its target yet", async () => {
    const client = await createUser();
    const provider = await createUser();
    const job = await createActiveJob({ client, provider });

    await Payment.create({
      targetType: PAYMENT_TARGET_TYPE.JOB,
      targetId: job._id,
      user: client._id,
      userEmail: client.email,
      amount: 777,
      currency: "USD",
      provider: PAYMENT_PROVIDER_NAME.STRIPE,
      status: PAYMENT_STATUS.SUCCESS,
      rail: PAYMENT_RAIL.MARKETPLACE,
      providerPaymentId: "pi_exposure_held",
      isOnHold: true,
      holdReleaseAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    const exposure = await getOutstandingExposure();
    expect(exposure).toBeGreaterThanOrEqual(777);
  });
});

// generateTestHeaderString is pure local HMAC signing (no network) — a
// charge.dispute.created webhook never reaches provider.retrieveIntent
// (see paymentController.ts's stripeWebhook — the dispute branch returns
// before that call), so this is fully safe without a real Stripe key.
const stripeForSigning = new Stripe("sk_test_signing_only");

const signedDisputeWebhook = (paymentIntentId: string | null) => {
  const body = JSON.stringify({
    type: "charge.dispute.created",
    data: { object: { payment_intent: paymentIntentId } },
  });
  const signature = stripeForSigning.webhooks.generateTestHeaderString({
    payload: body,
    secret: process.env.STRIPE_WEBHOOK_SECRET as string,
  });

  return request(app)
    .post("/api/payments/stripe/webhook")
    .set("Content-Type", "application/json")
    .set("stripe-signature", signature)
    .send(body);
};

describe("charge.dispute.created — paymentController.ts's stripeWebhook", () => {
  it("cancels a still-held payment outright — the hold did its job, nothing was ever credited", async () => {
    const client = await createUser();
    const provider = await createUser();
    const job = await createActiveJob({ client, provider });

    await Payment.create({
      targetType: PAYMENT_TARGET_TYPE.JOB,
      targetId: job._id,
      user: client._id,
      userEmail: client.email,
      amount: 500,
      currency: "USD",
      provider: PAYMENT_PROVIDER_NAME.STRIPE,
      status: PAYMENT_STATUS.SUCCESS,
      rail: PAYMENT_RAIL.MARKETPLACE,
      providerPaymentId: "pi_disputed_held",
      isOnHold: true,
      holdReleaseAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    const res = await signedDisputeWebhook("pi_disputed_held");
    expect(res.status).toBe(200);

    await waitFor(async () => (await Payment.findOne({ providerPaymentId: "pi_disputed_held" }))?.disputedAt != null);

    const updated = await Payment.findOne({ providerPaymentId: "pi_disputed_held" });
    expect(updated?.status).toBe("disputed");
    expect(updated?.isOnHold).toBe(false);
    expect(updated?.disputedAt).toBeTruthy();

    const updatedJob = await Job.findById(job._id);
    expect(updatedJob?.amountPaid).toBe(0);
  });

  it("flags a dispute on an already-released payment without touching its status or value", async () => {
    const client = await createUser();
    const provider = await createUser();
    const job = await createActiveJob({ client, provider });
    await Job.updateOne({ _id: job._id }, { amountPaid: 500 });

    await Payment.create({
      targetType: PAYMENT_TARGET_TYPE.JOB,
      targetId: job._id,
      user: client._id,
      userEmail: client.email,
      amount: 500,
      currency: "USD",
      provider: PAYMENT_PROVIDER_NAME.STRIPE,
      status: PAYMENT_STATUS.SUCCESS,
      rail: PAYMENT_RAIL.MARKETPLACE,
      providerPaymentId: "pi_disputed_released",
      isOnHold: false,
    });

    const res = await signedDisputeWebhook("pi_disputed_released");
    expect(res.status).toBe(200);

    await waitFor(
      async () => (await Payment.findOne({ providerPaymentId: "pi_disputed_released" }))?.disputedAt != null,
    );

    const updated = await Payment.findOne({ providerPaymentId: "pi_disputed_released" });
    expect(updated?.status).toBe("success");
    expect(updated?.disputedAt).toBeTruthy();

    const updatedJob = await Job.findById(job._id);
    expect(updatedJob?.amountPaid).toBe(500);
  });

  it("no-ops safely when the dispute's payment_intent doesn't match any Payment", async () => {
    const res = await signedDisputeWebhook("pi_unknown_entirely");
    expect(res.status).toBe(200);
  });

  it("surfaces a flagged dispute via GET /api/payments?hasDispute=true", async () => {
    const client = await createUser();
    const provider = await createUser();
    const job = await createActiveJob({ client, provider });

    const notDisputed = await Payment.create({
      targetType: PAYMENT_TARGET_TYPE.JOB,
      targetId: job._id,
      user: client._id,
      userEmail: client.email,
      amount: 100,
      currency: "USD",
      provider: PAYMENT_PROVIDER_NAME.STRIPE,
      status: PAYMENT_STATUS.SUCCESS,
      rail: PAYMENT_RAIL.MARKETPLACE,
      providerPaymentId: "pi_not_disputed",
    });
    void notDisputed;

    await signedDisputeWebhook("pi_not_disputed_other");
    await Payment.create({
      targetType: PAYMENT_TARGET_TYPE.JOB,
      targetId: job._id,
      user: client._id,
      userEmail: client.email,
      amount: 200,
      currency: "USD",
      provider: PAYMENT_PROVIDER_NAME.STRIPE,
      status: PAYMENT_STATUS.SUCCESS,
      rail: PAYMENT_RAIL.MARKETPLACE,
      providerPaymentId: "pi_will_be_disputed",
    });
    await signedDisputeWebhook("pi_will_be_disputed");
    await waitFor(
      async () => (await Payment.findOne({ providerPaymentId: "pi_will_be_disputed" }))?.disputedAt != null,
    );

    const admin = await createAdmin();
    const res = await request(app)
      .get("/api/payments?hasDispute=true")
      .set("Authorization", `Bearer ${generateToken(admin)}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].providerPaymentId).toBe("pi_will_be_disputed");
  });
});

describe("POST /api/payments/:id/approve-hold", () => {
  it("requires authentication", async () => {
    const res = await request(app).post("/api/payments/507f1f77bcf86cd799439011/approve-hold");
    expect(res.status).toBe(401);
  });

  it("blocks a non-admin", async () => {
    const user = await createUser();
    const res = await request(app)
      .post("/api/payments/507f1f77bcf86cd799439011/approve-hold")
      .set("Authorization", `Bearer ${generateToken(user)}`);
    expect(res.status).toBe(401);
  });

  it("404s for an unknown payment", async () => {
    const admin = await createAdmin();
    const res = await request(app)
      .post("/api/payments/507f1f77bcf86cd799439011/approve-hold")
      .set("Authorization", `Bearer ${generateToken(admin)}`);
    expect(res.status).toBe(404);
  });

  it("400s when the payment isn't on hold", async () => {
    const admin = await createAdmin();
    const client = await createUser();
    const provider = await createUser();
    const job = await createActiveJob({ client, provider });

    const payment = await Payment.create({
      targetType: PAYMENT_TARGET_TYPE.JOB,
      targetId: job._id,
      user: client._id,
      userEmail: client.email,
      amount: 500,
      currency: "USD",
      provider: PAYMENT_PROVIDER_NAME.STRIPE,
      status: PAYMENT_STATUS.SUCCESS,
      rail: PAYMENT_RAIL.MARKETPLACE,
      providerPaymentId: "pi_not_held",
      isOnHold: false,
    });

    const res = await request(app)
      .post(`/api/payments/${payment.id}/approve-hold`)
      .set("Authorization", `Bearer ${generateToken(admin)}`);
    expect(res.status).toBe(400);
  });

  it("releases a held payment right now, regardless of holdReleaseAt — admin discretion overrides the timer", async () => {
    const admin = await createAdmin();
    const client = await createUser();
    const provider = await createUser();
    const job = await createActiveJob({ client, provider });

    const payment = await Payment.create({
      targetType: PAYMENT_TARGET_TYPE.JOB,
      targetId: job._id,
      user: client._id,
      userEmail: client.email,
      amount: 5000,
      currency: "USD",
      provider: PAYMENT_PROVIDER_NAME.STRIPE,
      status: PAYMENT_STATUS.SUCCESS,
      rail: PAYMENT_RAIL.MARKETPLACE,
      providerPaymentId: "pi_review_approve",
      isOnHold: true,
      // Far in the future — approve-hold must not wait for this.
      holdReleaseAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    const res = await request(app)
      .post(`/api/payments/${payment.id}/approve-hold`)
      .set("Authorization", `Bearer ${generateToken(admin)}`);

    expect(res.status).toBe(200);
    expect(res.body.isOnHold).toBe(false);

    const updatedJob = await Job.findById(job._id);
    expect(updatedJob?.amountPaid).toBe(5000);
  });
});

describe("GET /api/payments?pendingManualReview=true", () => {
  it("surfaces a held payment above the live manualReviewThresholdAmount, live against the current setting", async () => {
    await SystemSettings.create({
      maxOutstandingExposure: 0,
      maxTransactionAmount: 0,
      supportedCountries: [],
      fraudHoldThresholdAmount: 0,
      fraudHoldHours: 24,
      manualReviewThresholdAmount: 1000,
    });

    const client = await createUser();
    const provider = await createUser();
    const job = await createActiveJob({ client, provider });

    await Payment.create({
      targetType: PAYMENT_TARGET_TYPE.JOB,
      targetId: job._id,
      user: client._id,
      userEmail: client.email,
      amount: 500,
      currency: "USD",
      provider: PAYMENT_PROVIDER_NAME.STRIPE,
      status: PAYMENT_STATUS.SUCCESS,
      rail: PAYMENT_RAIL.MARKETPLACE,
      providerPaymentId: "pi_below_review",
      isOnHold: true,
      holdReleaseAt: new Date(Date.now() - 1000),
    });
    await Payment.create({
      targetType: PAYMENT_TARGET_TYPE.JOB,
      targetId: job._id,
      user: client._id,
      userEmail: client.email,
      amount: 5000,
      currency: "USD",
      provider: PAYMENT_PROVIDER_NAME.STRIPE,
      status: PAYMENT_STATUS.SUCCESS,
      rail: PAYMENT_RAIL.MARKETPLACE,
      providerPaymentId: "pi_above_review",
      isOnHold: true,
      holdReleaseAt: new Date(Date.now() - 1000),
    });

    const admin = await createAdmin();
    const res = await request(app)
      .get("/api/payments?pendingManualReview=true")
      .set("Authorization", `Bearer ${generateToken(admin)}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].providerPaymentId).toBe("pi_above_review");
  });
});

describe("GET /api/payments?isOnHold=true", () => {
  it("lists every held payment as a group, regardless of amount", async () => {
    const client = await createUser();
    const provider = await createUser();
    const job = await createActiveJob({ client, provider });

    await Payment.create({
      targetType: PAYMENT_TARGET_TYPE.JOB,
      targetId: job._id,
      user: client._id,
      userEmail: client.email,
      amount: 500,
      currency: "USD",
      provider: PAYMENT_PROVIDER_NAME.STRIPE,
      status: PAYMENT_STATUS.SUCCESS,
      rail: PAYMENT_RAIL.MARKETPLACE,
      providerPaymentId: "pi_on_hold",
      isOnHold: true,
      holdReleaseAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    await Payment.create({
      targetType: PAYMENT_TARGET_TYPE.JOB,
      targetId: job._id,
      user: client._id,
      userEmail: client.email,
      amount: 500,
      currency: "USD",
      provider: PAYMENT_PROVIDER_NAME.STRIPE,
      status: PAYMENT_STATUS.SUCCESS,
      rail: PAYMENT_RAIL.MARKETPLACE,
      providerPaymentId: "pi_already_released",
      isOnHold: false,
    });

    const admin = await createAdmin();
    const res = await request(app)
      .get("/api/payments?isOnHold=true")
      .set("Authorization", `Bearer ${generateToken(admin)}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].providerPaymentId).toBe("pi_on_hold");
  });
});

describe("reconcilePaymentIntent never resurrects a disputed payment", () => {
  it("refuses to flip a DISPUTED payment back to success, even if the intent still reads 'succeeded' at Stripe", async () => {
    const client = await createUser();
    const provider = await createUser();
    const job = await createActiveJob({ client, provider });

    const payment = await Payment.create({
      targetType: PAYMENT_TARGET_TYPE.JOB,
      targetId: job._id,
      user: client._id,
      userEmail: client.email,
      amount: 500,
      currency: "USD",
      provider: PAYMENT_PROVIDER_NAME.STRIPE,
      status: PAYMENT_STATUS.DISPUTED,
      rail: PAYMENT_RAIL.MARKETPLACE,
      providerPaymentId: "pi_already_disputed",
      isOnHold: false,
      disputedAt: new Date(),
    });

    const result = await reconcilePaymentIntent(payment, "pi_already_disputed", succeededIntent(500));

    expect(result.status).toBe("failed");
    expect(payment.status).toBe("disputed");
    expect(payment.isOnHold).toBe(false);

    const updatedJob = await Job.findById(job._id);
    expect(updatedJob?.amountPaid).toBe(0);
  });
});

describe("POST /api/payments/intent — resuming an existing DigitalPurchase, never a second charge", () => {
  it("refuses to resume a disputed purchase, without ever calling the provider again", async () => {
    const retrieveIntentSpy = jest.spyOn(stripeProvider, "retrieveIntent");

    const creatorUser = await createUserWithActiveSubscription();
    const profile = await createDigitalCreatorProfile({
      user: creatorUser,
      currentSubscription: creatorUser.currentSubscription,
      isVerified: true,
    });
    const product = await createDigitalProduct({ creator: profile, price: 500 });
    const buyer = await createUser();
    const purchase = await createDigitalPurchase({
      product,
      buyer,
      creator: profile,
      status: DIGITAL_PURCHASE_STATUS.PENDING,
      files: [],
    });

    await Payment.create({
      targetType: PAYMENT_TARGET_TYPE.DIGITAL_PURCHASE,
      targetId: purchase._id,
      user: buyer._id,
      userEmail: buyer.email,
      amount: 500,
      currency: "USD",
      provider: PAYMENT_PROVIDER_NAME.STRIPE,
      status: PAYMENT_STATUS.DISPUTED,
      rail: PAYMENT_RAIL.MARKETPLACE,
      providerPaymentId: "pi_disputed_purchase",
      disputedAt: new Date(),
    });

    const res = await request(app)
      .post("/api/payments/intent")
      .set("Authorization", `Bearer ${generateToken(buyer)}`)
      .send({ targetType: "DigitalPurchase", targetId: product.id });

    expect(res.status).toBe(400);
    expect(retrieveIntentSpy).not.toHaveBeenCalled();

    expect(await Payment.countDocuments({ targetId: purchase._id })).toBe(1);
    const updatedPurchase = await DigitalPurchase.findById(purchase._id);
    expect(updatedPurchase?.status).toBe("pending");
  });

  it("reports the held state truthfully when resuming an on-hold purchase, instead of a false success — and never creates a second Payment", async () => {
    jest.spyOn(stripeProvider, "retrieveIntent").mockResolvedValue({
      status: "succeeded",
      amount: 500,
      currency: "USD",
      feeAmount: 0,
      raw: { client_secret: null },
    });

    const creatorUser = await createUserWithActiveSubscription();
    const profile = await createDigitalCreatorProfile({
      user: creatorUser,
      currentSubscription: creatorUser.currentSubscription,
      isVerified: true,
    });
    const product = await createDigitalProduct({ creator: profile, price: 500 });
    const buyer = await createUser();
    const purchase = await createDigitalPurchase({
      product,
      buyer,
      creator: profile,
      status: DIGITAL_PURCHASE_STATUS.PENDING,
      files: [],
    });

    await Payment.create({
      targetType: PAYMENT_TARGET_TYPE.DIGITAL_PURCHASE,
      targetId: purchase._id,
      user: buyer._id,
      userEmail: buyer.email,
      amount: 500,
      currency: "USD",
      provider: PAYMENT_PROVIDER_NAME.STRIPE,
      status: PAYMENT_STATUS.SUCCESS,
      rail: PAYMENT_RAIL.MARKETPLACE,
      providerPaymentId: "pi_held_purchase",
      isOnHold: true,
      holdReleaseAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    const res = await request(app)
      .post("/api/payments/intent")
      .set("Authorization", `Bearer ${generateToken(buyer)}`)
      .send({ targetType: "DigitalPurchase", targetId: product.id });

    expect(res.status).toBe(200);
    expect(res.body.held).toBe(true);

    expect(await Payment.countDocuments({ targetId: purchase._id })).toBe(1);
    const updatedPurchase = await DigitalPurchase.findById(purchase._id);
    expect(updatedPurchase?.status).toBe("pending");
  });
});
