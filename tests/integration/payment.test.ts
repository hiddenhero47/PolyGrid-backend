import request from "supertest";
import mongoose from "mongoose";
import Stripe from "stripe";
import createApp from "../../src/app";
import { connectTestDB, disconnectTestDB, clearTestDB } from "../setup/db";
import { createUser, createAdmin, createActiveJob, createPlan, generateToken } from "../setup/fixtures";
import { Payment, PAYMENT_TARGET_TYPE, PAYMENT_STATUS } from "../../src/models/paymentModel";
import { PAYMENT_PROVIDER_NAME } from "../../src/models/paymentProviderModel";
import { Job } from "../../src/models/jobModel";
import { Subscription } from "../../src/models/subscriptionModel";
import { User } from "../../src/models/userModel";
import { PLAN_TIER } from "../../src/models/planModel";

const app = createApp();

// The webhook handler deliberately acks Stripe with 200 before finishing
// its DB work (Stripe times out and retries slow deliveries — same reason
// HM's processStripeEvent does this). supertest's request resolves the
// instant that response is sent, which can be *before* the background
// payment.save()/Job update actually completes — so asserting on the DB
// immediately after is a genuine race, not a flaky test. Poll instead.
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
});

afterAll(async () => {
  await disconnectTestDB();
});

const createPayment = (overrides: Record<string, unknown>) =>
  Payment.create({
    targetType: PAYMENT_TARGET_TYPE.JOB,
    targetId: new mongoose.Types.ObjectId(),
    amount: 100,
    currency: "USD",
    provider: PAYMENT_PROVIDER_NAME.MANUAL,
    status: PAYMENT_STATUS.SUCCESS,
    ...overrides,
  });

describe("GET /api/payments/me", () => {
  it("requires authentication", async () => {
    const res = await request(app).get("/api/payments/me");
    expect(res.status).toBe(401);
  });

  it("returns only the caller's own payments", async () => {
    const me = await createUser();
    const other = await createUser();
    await createPayment({ user: me._id, userEmail: me.email });
    await createPayment({ user: other._id, userEmail: other.email });

    const res = await request(app)
      .get("/api/payments/me")
      .set("Authorization", `Bearer ${generateToken(me)}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].user).toBe(me.id);
  });

  it("filters by status", async () => {
    const me = await createUser();
    await createPayment({ user: me._id, userEmail: me.email, status: PAYMENT_STATUS.SUCCESS });
    await createPayment({ user: me._id, userEmail: me.email, status: PAYMENT_STATUS.FAILED });

    const res = await request(app)
      .get("/api/payments/me?status=failed")
      .set("Authorization", `Bearer ${generateToken(me)}`);

    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].status).toBe("failed");
  });
});

describe("GET /api/payments", () => {
  it("blocks a non-admin", async () => {
    const user = await createUser();

    const res = await request(app)
      .get("/api/payments")
      .set("Authorization", `Bearer ${generateToken(user)}`);

    expect(res.status).toBe(401);
  });

  it("lets an admin see and filter every payment", async () => {
    const admin = await createAdmin();
    const userA = await createUser();
    const userB = await createUser();
    await createPayment({ user: userA._id, userEmail: userA.email });
    await createPayment({ user: userB._id, userEmail: userB.email });

    const all = await request(app)
      .get("/api/payments")
      .set("Authorization", `Bearer ${generateToken(admin)}`);
    expect(all.body.data).toHaveLength(2);

    const filtered = await request(app)
      .get(`/api/payments?user=${userA.id}`)
      .set("Authorization", `Bearer ${generateToken(admin)}`);
    expect(filtered.body.data).toHaveLength(1);
    expect(filtered.body.data[0].user).toBe(userA.id);
  });
});

describe("Payment uniqueness", () => {
  it("allows multiple manual payments with no providerPaymentId", async () => {
    const user = await createUser();

    await createPayment({ user: user._id, userEmail: user.email });
    await createPayment({ user: user._id, userEmail: user.email });

    expect(await Payment.countDocuments({ user: user._id })).toBe(2);
  });

  it("rejects two payments recorded against the same real providerPaymentId", async () => {
    const user = await createUser();

    await createPayment({
      user: user._id,
      userEmail: user.email,
      provider: PAYMENT_PROVIDER_NAME.STRIPE,
      providerPaymentId: "pi_test_123",
    });

    await expect(
      createPayment({
        user: user._id,
        userEmail: user.email,
        provider: PAYMENT_PROVIDER_NAME.STRIPE,
        providerPaymentId: "pi_test_123",
      }),
    ).rejects.toThrow();
  });
});

describe("POST /api/payments/intent — validation (no Stripe network calls)", () => {
  it("requires authentication", async () => {
    const res = await request(app).post("/api/payments/intent").send({});
    expect(res.status).toBe(401);
  });

  it("rejects an unknown targetType", async () => {
    const user = await createUser();

    const res = await request(app)
      .post("/api/payments/intent")
      .set("Authorization", `Bearer ${generateToken(user)}`)
      .send({ targetType: "Store" });

    expect(res.status).toBe(400);
  });

  describe("targetType: Job", () => {
    it("requires a valid targetId and a positive amount", async () => {
      const user = await createUser();

      const res = await request(app)
        .post("/api/payments/intent")
        .set("Authorization", `Bearer ${generateToken(user)}`)
        .send({ targetType: "Job", targetId: "not-an-id", amount: 100 });

      expect(res.status).toBe(400);
    });

    it("404s for an unknown job", async () => {
      const user = await createUser();

      const res = await request(app)
        .post("/api/payments/intent")
        .set("Authorization", `Bearer ${generateToken(user)}`)
        .send({
          targetType: "Job",
          targetId: new mongoose.Types.ObjectId().toString(),
          amount: 100,
        });

      expect(res.status).toBe(404);
    });

    it("blocks anyone other than the job's client", async () => {
      const clientUser = await createUser();
      const providerUser = await createUser();
      const stranger = await createUser();
      const job = await createActiveJob({ client: clientUser, provider: providerUser });

      const res = await request(app)
        .post("/api/payments/intent")
        .set("Authorization", `Bearer ${generateToken(stranger)}`)
        .send({ targetType: "Job", targetId: job.id, amount: 100 });

      expect(res.status).toBe(403);
    });

    it("rejects funding a job that isn't active", async () => {
      const clientUser = await createUser();
      const providerUser = await createUser();
      const job = await createActiveJob({
        client: clientUser,
        provider: providerUser,
        status: "completed",
      });

      const res = await request(app)
        .post("/api/payments/intent")
        .set("Authorization", `Bearer ${generateToken(clientUser)}`)
        .send({ targetType: "Job", targetId: job.id, amount: 100 });

      expect(res.status).toBe(400);
    });
  });

  describe("targetType: Subscription", () => {
    it("requires a planTier", async () => {
      const user = await createUser();

      const res = await request(app)
        .post("/api/payments/intent")
        .set("Authorization", `Bearer ${generateToken(user)}`)
        .send({ targetType: "Subscription" });

      expect(res.status).toBe(400);
    });

    it("rejects an unknown or inactive plan tier", async () => {
      const user = await createUser();
      await createPlan({ planTier: PLAN_TIER.PRO, isActive: false });

      const res = await request(app)
        .post("/api/payments/intent")
        .set("Authorization", `Bearer ${generateToken(user)}`)
        .send({ targetType: "Subscription", planTier: PLAN_TIER.PRO });

      expect(res.status).toBe(400);
    });
  });
});

// generateTestHeaderString is pure local HMAC signing (no network) — this
// signing key just needs to be a non-empty string, and matches whatever
// STRIPE_WEBHOOK_SECRET the app itself verifies against.
const stripeForSigning = new Stripe("sk_test_signing_only");

const signedWebhookRequest = (payload: object) => {
  const body = JSON.stringify(payload);
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

describe("POST /api/payments/stripe/webhook — signature handling (no Stripe network calls)", () => {
  it("rejects a request with no signature header", async () => {
    const res = await request(app)
      .post("/api/payments/stripe/webhook")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ type: "payment_intent.succeeded" }));

    expect(res.status).toBe(400);
  });

  it("rejects a garbled signature", async () => {
    const res = await request(app)
      .post("/api/payments/stripe/webhook")
      .set("Content-Type", "application/json")
      .set("stripe-signature", "t=1,v1=not-a-real-signature")
      .send(JSON.stringify({ type: "payment_intent.succeeded" }));

    expect(res.status).toBe(400);
  });

  it("acks and no-ops for an event type it doesn't act on", async () => {
    const res = await signedWebhookRequest({
      type: "payment_intent.created",
      data: { object: { id: "pi_irrelevant" } },
    });

    expect(res.status).toBe(200);
  });

  it("acks and no-ops when the event's paymentId doesn't match any Payment", async () => {
    const res = await signedWebhookRequest({
      type: "payment_intent.succeeded",
      data: {
        object: { id: "pi_unknown", metadata: { paymentId: new mongoose.Types.ObjectId().toString() } },
      },
    });

    expect(res.status).toBe(200);
  });
});

const hasRealStripeKey =
  !!process.env.STRIPE_SECRET_KEY && process.env.STRIPE_SECRET_KEY !== "sk_test_placeholder";
const maybeIt = hasRealStripeKey ? it : it.skip;

describe("Live Stripe round trip (skipped unless a real STRIPE_SECRET_KEY is set)", () => {
  maybeIt("funds a job's escrow end-to-end", async () => {
    const clientUser = await createUser();
    const providerUser = await createUser();
    const job = await createActiveJob({ client: clientUser, provider: providerUser });

    const intentRes = await request(app)
      .post("/api/payments/intent")
      .set("Authorization", `Bearer ${generateToken(clientUser)}`)
      .send({ targetType: "Job", targetId: job.id, amount: 250 });

    expect(intentRes.status).toBe(201);
    expect(intentRes.body.clientSecret).toEqual(expect.any(String));

    const payment = await Payment.findById(intentRes.body.paymentId);
    expect(payment?.status).toBe("pending");

    // Confirm the intent server-side with a Stripe test card that succeeds
    // with no further action — no browser/redirect needed.
    const liveStripe = new Stripe(process.env.STRIPE_SECRET_KEY as string);
    const confirmed = await liveStripe.paymentIntents.confirm(payment!.providerPaymentId as string, {
      payment_method: "pm_card_visa",
    });
    expect(confirmed.status).toBe("succeeded");

    // The webhook itself wasn't delivered by Stripe (no tunnel in a test
    // run) — this fabricates the notification, but re-verification inside
    // our own handler (provider.retrieveIntent) re-fetches this same real,
    // genuinely-succeeded intent from Stripe, so that part of the flow is
    // fully real.
    const webhookRes = await signedWebhookRequest({
      type: "payment_intent.succeeded",
      data: { object: { id: confirmed.id, metadata: { paymentId: payment!.id } } },
    });
    expect(webhookRes.status).toBe(200);

    await waitFor(async () => (await Payment.findById(payment!.id))?.status === "success");

    const updatedPayment = await Payment.findById(payment!.id);
    expect(updatedPayment?.status).toBe("success");

    const updatedJob = await Job.findById(job.id);
    expect(updatedJob?.amountPaid).toBe(250);
  });

  maybeIt("purchases a subscription end-to-end", async () => {
    const user = await createUser();
    const plan = await createPlan({ planTier: PLAN_TIER.PRO, price: 20 });

    const intentRes = await request(app)
      .post("/api/payments/intent")
      .set("Authorization", `Bearer ${generateToken(user)}`)
      .send({ targetType: "Subscription", planTier: plan.planTier });

    expect(intentRes.status).toBe(201);
    const subscriptionId = intentRes.body.subscriptionId;

    let subscription = await Subscription.findById(subscriptionId);
    expect(subscription?.status).toBe("pending");

    const payment = await Payment.findById(intentRes.body.paymentId);

    const liveStripe = new Stripe(process.env.STRIPE_SECRET_KEY as string);
    const confirmed = await liveStripe.paymentIntents.confirm(payment!.providerPaymentId as string, {
      payment_method: "pm_card_visa",
    });
    expect(confirmed.status).toBe("succeeded");

    const webhookRes = await signedWebhookRequest({
      type: "payment_intent.succeeded",
      data: { object: { id: confirmed.id, metadata: { paymentId: payment!.id } } },
    });
    expect(webhookRes.status).toBe(200);

    // Wait for the *last* thing the background work does (repointing
    // currentSubscription), not just the Subscription's own status flip —
    // that happens first in the same chain, so polling only on it would
    // still race against the User update that follows it.
    await waitFor(
      async () => (await User.findById(user.id))?.currentSubscription?.toString() === subscriptionId,
    );

    subscription = await Subscription.findById(subscriptionId);
    expect(subscription?.status).toBe("active");

    const updatedUser = await User.findById(user.id);
    expect(updatedUser?.currentSubscription?.toString()).toBe(subscriptionId);
  });
});
