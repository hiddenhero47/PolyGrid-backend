// No real Stripe Connect calls in CI — same "mock the third-party
// integration entirely" boundary tests/README.md documents for
// helpers/emailSender/s3Storage, applied here too.
const mockCreateConnectedAccount = jest.fn();
const mockCreateOnboardingLink = jest.fn();

jest.mock("../../src/helpers/stripeConnect", () => {
  const actual = jest.requireActual("../../src/helpers/stripeConnect");
  return {
    ...actual,
    createConnectedAccount: mockCreateConnectedAccount,
    createOnboardingLink: mockCreateOnboardingLink,
  };
});

import request from "supertest";
import Stripe from "stripe";
import createApp from "../../src/app";
import { connectTestDB, disconnectTestDB, clearTestDB } from "../setup/db";
import { createUser, generateToken } from "../setup/fixtures";
import { User } from "../../src/models/userModel";

const app = createApp();

beforeAll(async () => {
  await connectTestDB();
});

afterEach(async () => {
  await clearTestDB();
  jest.clearAllMocks();
});

afterAll(async () => {
  await disconnectTestDB();
});

describe("POST /api/users/me/connect/onboard", () => {
  it("requires authentication", async () => {
    const res = await request(app).post("/api/users/me/connect/onboard");
    expect(res.status).toBe(401);
  });

  it("blocks a user with no country set", async () => {
    const user = await createUser();

    const res = await request(app)
      .post("/api/users/me/connect/onboard")
      .set("Authorization", `Bearer ${generateToken(user)}`);

    expect(res.status).toBe(400);
    expect(mockCreateConnectedAccount).not.toHaveBeenCalled();
  });

  it("creates a connected account on first call, then just returns a fresh link on later calls", async () => {
    const user = await createUser({ country: "NG" });
    mockCreateConnectedAccount.mockResolvedValue("acct_123");
    mockCreateOnboardingLink.mockResolvedValue("https://connect.stripe.com/setup/acct_123/abc");

    const first = await request(app)
      .post("/api/users/me/connect/onboard")
      .set("Authorization", `Bearer ${generateToken(user)}`);

    expect(first.status).toBe(200);
    expect(first.body.onboardingUrl).toBe("https://connect.stripe.com/setup/acct_123/abc");
    expect(mockCreateConnectedAccount).toHaveBeenCalledTimes(1);

    const updated = await User.findById(user.id);
    expect(updated?.stripeConnectedAccountId).toBe("acct_123");

    mockCreateOnboardingLink.mockResolvedValue("https://connect.stripe.com/setup/acct_123/xyz");
    const second = await request(app)
      .post("/api/users/me/connect/onboard")
      .set("Authorization", `Bearer ${generateToken(updated!)}`);

    expect(second.status).toBe(200);
    expect(second.body.onboardingUrl).toBe("https://connect.stripe.com/setup/acct_123/xyz");
    // Not called again — the account already exists.
    expect(mockCreateConnectedAccount).toHaveBeenCalledTimes(1);
    expect(mockCreateOnboardingLink).toHaveBeenCalledTimes(2);
  });
});

// generateTestHeaderString is pure local HMAC signing (no network) — same
// pattern as payment.test.ts's own signedWebhookRequest, just against the
// separate Connect webhook endpoint and secret.
const stripeForSigning = new Stripe("sk_test_signing_only");

const signedConnectWebhookRequest = (payload: object) => {
  const body = JSON.stringify(payload);
  const signature = stripeForSigning.webhooks.generateTestHeaderString({
    payload: body,
    secret: process.env.STRIPE_CONNECT_WEBHOOK_SECRET as string,
  });

  return request(app)
    .post("/api/payments/stripe/connect-webhook")
    .set("Content-Type", "application/json")
    .set("stripe-signature", signature)
    .send(body);
};

describe("POST /api/payments/stripe/connect-webhook", () => {
  it("rejects a request with no signature", async () => {
    const res = await request(app)
      .post("/api/payments/stripe/connect-webhook")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ type: "account.updated" }));

    expect(res.status).toBe(400);
  });

  it("rejects an invalid signature", async () => {
    const res = await request(app)
      .post("/api/payments/stripe/connect-webhook")
      .set("Content-Type", "application/json")
      .set("stripe-signature", "t=1,v1=not-a-real-signature")
      .send(JSON.stringify({ type: "account.updated" }));

    expect(res.status).toBe(400);
  });

  it("acks and no-ops for an event type it doesn't act on", async () => {
    const res = await signedConnectWebhookRequest({
      type: "account.application.authorized",
      data: { object: { id: "acct_irrelevant" } },
    });

    expect(res.status).toBe(200);
  });

  it("sets stripeConnectPayoutsEnabled on the matching user when account.updated fires", async () => {
    const user = await createUser({ country: "NG", stripeConnectedAccountId: "acct_abc" });

    const res = await signedConnectWebhookRequest({
      type: "account.updated",
      data: { object: { id: "acct_abc", payouts_enabled: true } },
    });

    expect(res.status).toBe(200);
    const updated = await User.findById(user.id);
    expect(updated?.stripeConnectPayoutsEnabled).toBe(true);
  });

  it("no-ops safely when the event's account id doesn't match any user", async () => {
    const res = await signedConnectWebhookRequest({
      type: "account.updated",
      data: { object: { id: "acct_unknown", payouts_enabled: true } },
    });

    expect(res.status).toBe(200);
  });
});
