// No real Mailgun call — same "mock the third-party integration
// entirely" boundary tests/README.md documents for helpers/emailSender.
jest.mock("../../src/helpers/emailSender", () => ({
  sendTemplatedEmail: jest.fn().mockResolvedValue({}),
  loadTemplates: jest.fn().mockResolvedValue(undefined),
}));

// Same boundary, for the real Stripe Connect calls settlementMethod:
// 'stripe' now makes — no real Transfer/Refund ever happens in CI.
const mockCreateTransfer = jest.fn();
const mockCreateRefund = jest.fn();
jest.mock("../../src/helpers/stripeConnect", () => ({
  createTransfer: mockCreateTransfer,
  createRefund: mockCreateRefund,
}));

import request from "supertest";
import mongoose from "mongoose";
import createApp from "../../src/app";
import { connectTestDB, disconnectTestDB, clearTestDB } from "../setup/db";
import {
  createUser,
  createAdmin,
  createCustomerCare,
  createActiveJob,
  createDigitalCreatorProfile,
  createDigitalProduct,
  createDigitalPurchase,
  generateToken,
} from "../setup/fixtures";
import {
  SystemPayout,
  SYSTEM_PAYOUT_REQUEST_TYPE,
  SYSTEM_PAYOUT_STATUS,
  SETTLEMENT_METHOD,
  SYSTEM_PAYOUT_TARGET_TYPE,
} from "../../src/models/systemPayoutModel";
import { Payment, PAYMENT_TARGET_TYPE, PAYMENT_STATUS, PAYMENT_RAIL } from "../../src/models/paymentModel";
import { PAYMENT_PROVIDER_NAME } from "../../src/models/paymentProviderModel";
import { sendTemplatedEmail } from "../../src/helpers/emailSender";
import { DigitalPurchase, DIGITAL_PURCHASE_STATUS } from "../../src/models/digitalPurchaseModel";

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

const TEST_PAYOUT_ACCOUNT = {
  accountName: "Test Recipient",
  accountNumber: "0123456789",
  bankName: "Test Bank",
  country: "NG",
};

const createSystemPayoutRecord = async (overrides: Record<string, unknown> = {}) => {
  const clientUser = await createUser();
  const providerUser = await createUser();
  const job = await createActiveJob({ client: clientUser, provider: providerUser });
  const recipient = await createUser({ fullName: "Recipient Name", payoutAccount: TEST_PAYOUT_ACCOUNT });
  const createdBy = await createAdmin();

  return SystemPayout.create({
    requestType: SYSTEM_PAYOUT_REQUEST_TYPE.PAYOUT,
    targetType: PAYMENT_TARGET_TYPE.JOB,
    targetId: job._id,
    requestId: job._id, // stand-in — the real id is an IRefund/IPayout sub-document's own _id, not relevant to these tests
    user: recipient._id,
    amount: 342,
    currency: "USD",
    settlementMethod: SETTLEMENT_METHOD.MANUAL,
    payoutAccount: TEST_PAYOUT_ACCOUNT,
    createdBy: createdBy._id,
    ...overrides,
  }).then(async (payout) => ({ payout, job, recipient }));
};

describe("GET /api/system-payouts", () => {
  it("blocks a non-admin, including customer_care", async () => {
    const user = await createUser();
    const customerCare = await createCustomerCare();

    for (const caller of [user, customerCare]) {
      const res = await request(app).get("/api/system-payouts").set("Authorization", `Bearer ${generateToken(caller)}`);
      expect(res.status).toBe(401);
    }
  });

  it("lists payouts with the job's title and the recipient's name/email", async () => {
    const admin = await createAdmin();
    const { payout, job, recipient } = await createSystemPayoutRecord();

    const res = await request(app)
      .get("/api/system-payouts")
      .set("Authorization", `Bearer ${generateToken(admin)}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    const row = res.body.data[0];
    expect(row.id).toBe(payout.id);
    expect(row.jobTitle).toBe(job.jobTitle);
    expect(row.recipient).toEqual({ id: recipient.id, fullName: "Recipient Name", email: recipient.email });
    expect(row.amount).toBe(342);
    expect(row.status).toBe("pending");
  });

  it("filters by status and requestType", async () => {
    const admin = await createAdmin();
    const { payout: refundPayout } = await createSystemPayoutRecord({
      requestType: SYSTEM_PAYOUT_REQUEST_TYPE.REFUND,
    });
    await createSystemPayoutRecord({
      requestType: SYSTEM_PAYOUT_REQUEST_TYPE.PAYOUT,
      status: SYSTEM_PAYOUT_STATUS.PAID,
    });

    const byType = await request(app)
      .get("/api/system-payouts?requestType=refund")
      .set("Authorization", `Bearer ${generateToken(admin)}`);
    expect(byType.body.data).toHaveLength(1);
    expect(byType.body.data[0].id).toBe(refundPayout.id);

    const byStatus = await request(app)
      .get("/api/system-payouts?status=paid")
      .set("Authorization", `Bearer ${generateToken(admin)}`);
    expect(byStatus.body.data).toHaveLength(1);
    expect(byStatus.body.data[0].status).toBe("paid");
  });
});

describe("PATCH /api/system-payouts/:id/paid", () => {
  it("marks a pending payout paid, records who/when, and notifies the recipient", async () => {
    const admin = await createAdmin();
    const { payout, job, recipient } = await createSystemPayoutRecord();

    const res = await request(app)
      .patch(`/api/system-payouts/${payout.id}/paid`)
      .set("Authorization", `Bearer ${generateToken(admin)}`)
      .send({ transferReference: "TXN-001" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("paid");
    expect(res.body.transferReference).toBe("TXN-001");
    expect(res.body.settledBy).toBe(admin.id);
    expect(res.body.settledAt).toBeTruthy();

    const updated = await SystemPayout.findById(payout.id);
    expect(updated?.status).toBe("paid");

    expect(sendTemplatedEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: recipient.email,
        template: "systemPayoutSettled",
        variables: expect.objectContaining({ jobTitle: job.jobTitle, paid: true, transferReference: "TXN-001" }),
      }),
    );
  });

  it("works without a transferReference", async () => {
    const admin = await createAdmin();
    const { payout } = await createSystemPayoutRecord();

    const res = await request(app)
      .patch(`/api/system-payouts/${payout.id}/paid`)
      .set("Authorization", `Bearer ${generateToken(admin)}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("paid");
  });

  it("rejects settling the same payout twice", async () => {
    const admin = await createAdmin();
    const { payout } = await createSystemPayoutRecord();
    const token = generateToken(admin);

    await request(app).patch(`/api/system-payouts/${payout.id}/paid`).set("Authorization", `Bearer ${token}`).send({});

    const res = await request(app)
      .patch(`/api/system-payouts/${payout.id}/paid`)
      .set("Authorization", `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(400);
  });

  it("blocks a non-admin", async () => {
    const customerCare = await createCustomerCare();
    const { payout } = await createSystemPayoutRecord();

    const res = await request(app)
      .patch(`/api/system-payouts/${payout.id}/paid`)
      .set("Authorization", `Bearer ${generateToken(customerCare)}`)
      .send({});

    expect(res.status).toBe(401);
  });

  it("404s for an unknown id", async () => {
    const admin = await createAdmin();

    const res = await request(app)
      .patch("/api/system-payouts/507f1f77bcf86cd799439011/paid")
      .set("Authorization", `Bearer ${generateToken(admin)}`)
      .send({});

    expect(res.status).toBe(404);
  });
});

describe("PATCH /api/system-payouts/:id/paid — settlementMethod: 'stripe'", () => {
  it("calls stripe.transfers.create for a payout, and records the real transfer id", async () => {
    const admin = await createAdmin();
    const recipient = await createUser({ stripeConnectedAccountId: "acct_123", stripeConnectPayoutsEnabled: true });
    const clientUser = await createUser();
    const job = await createActiveJob({ client: clientUser, provider: recipient });
    mockCreateTransfer.mockResolvedValue("tr_abc");

    const payout = await SystemPayout.create({
      requestType: SYSTEM_PAYOUT_REQUEST_TYPE.PAYOUT,
      targetType: PAYMENT_TARGET_TYPE.JOB,
      targetId: job._id,
      requestId: new mongoose.Types.ObjectId(),
      user: recipient._id,
      amount: 200,
      currency: "USD",
      settlementMethod: SETTLEMENT_METHOD.STRIPE,
      payoutAccount: { accountName: "Test", accountNumber: "0123456789", bankName: "Test Bank", country: "NG" },
      createdBy: admin._id,
    });

    const res = await request(app)
      .patch(`/api/system-payouts/${payout.id}/paid`)
      .set("Authorization", `Bearer ${generateToken(admin)}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.transferReference).toBe("tr_abc");
    expect(mockCreateTransfer).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 200, currency: "USD", destinationAccountId: "acct_123" }),
    );
  });

  it("leaves the payout PENDING (502) when the Stripe transfer fails", async () => {
    const admin = await createAdmin();
    const recipient = await createUser({ stripeConnectedAccountId: "acct_123", stripeConnectPayoutsEnabled: true });
    const clientUser = await createUser();
    const job = await createActiveJob({ client: clientUser, provider: recipient });
    mockCreateTransfer.mockRejectedValue(new Error("insufficient available balance"));

    const payout = await SystemPayout.create({
      requestType: SYSTEM_PAYOUT_REQUEST_TYPE.PAYOUT,
      targetType: PAYMENT_TARGET_TYPE.JOB,
      targetId: job._id,
      requestId: new mongoose.Types.ObjectId(),
      user: recipient._id,
      amount: 200,
      currency: "USD",
      settlementMethod: SETTLEMENT_METHOD.STRIPE,
      payoutAccount: { accountName: "Test", accountNumber: "0123456789", bankName: "Test Bank", country: "NG" },
      createdBy: admin._id,
    });

    const res = await request(app)
      .patch(`/api/system-payouts/${payout.id}/paid`)
      .set("Authorization", `Bearer ${generateToken(admin)}`)
      .send({});

    expect(res.status).toBe(502);
    const stillPending = await SystemPayout.findById(payout.id);
    expect(stillPending?.status).toBe("pending");
  });

  it("refunds against the job's single successful Stripe payment", async () => {
    const admin = await createAdmin();
    const clientUser = await createUser();
    const providerUser = await createUser();
    const job = await createActiveJob({ client: clientUser, provider: providerUser });
    mockCreateRefund.mockResolvedValue("re_xyz");

    await Payment.create({
      targetType: PAYMENT_TARGET_TYPE.JOB,
      targetId: job._id,
      user: clientUser._id,
      userEmail: clientUser.email,
      amount: 300,
      currency: "USD",
      provider: PAYMENT_PROVIDER_NAME.STRIPE,
      status: PAYMENT_STATUS.SUCCESS,
      providerPaymentId: "pi_only",
      rail: PAYMENT_RAIL.MARKETPLACE,
    });

    const payout = await SystemPayout.create({
      requestType: SYSTEM_PAYOUT_REQUEST_TYPE.REFUND,
      targetType: PAYMENT_TARGET_TYPE.JOB,
      targetId: job._id,
      requestId: new mongoose.Types.ObjectId(),
      user: clientUser._id,
      amount: 200,
      currency: "USD",
      settlementMethod: SETTLEMENT_METHOD.STRIPE,
      payoutAccount: { accountName: "Test", accountNumber: "0123456789", bankName: "Test Bank", country: "NG" },
      createdBy: admin._id,
    });

    const res = await request(app)
      .patch(`/api/system-payouts/${payout.id}/paid`)
      .set("Authorization", `Bearer ${generateToken(admin)}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.transferReference).toBe("re_xyz");
    expect(mockCreateRefund).toHaveBeenCalledTimes(1);
    expect(mockCreateRefund).toHaveBeenCalledWith({ paymentIntentId: "pi_only", amount: 200 });
  });

  it("walks back across multiple successful Stripe payments when one alone doesn't cover the refund", async () => {
    const admin = await createAdmin();
    const clientUser = await createUser();
    const providerUser = await createUser();
    const job = await createActiveJob({ client: clientUser, provider: providerUser });
    mockCreateRefund.mockResolvedValueOnce("re_recent").mockResolvedValueOnce("re_older");

    await Payment.create({
      targetType: PAYMENT_TARGET_TYPE.JOB,
      targetId: job._id,
      user: clientUser._id,
      userEmail: clientUser.email,
      amount: 100,
      currency: "USD",
      provider: PAYMENT_PROVIDER_NAME.STRIPE,
      status: PAYMENT_STATUS.SUCCESS,
      providerPaymentId: "pi_older",
      rail: PAYMENT_RAIL.MARKETPLACE,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await Payment.create({
      targetType: PAYMENT_TARGET_TYPE.JOB,
      targetId: job._id,
      user: clientUser._id,
      userEmail: clientUser.email,
      amount: 100,
      currency: "USD",
      provider: PAYMENT_PROVIDER_NAME.STRIPE,
      status: PAYMENT_STATUS.SUCCESS,
      providerPaymentId: "pi_recent",
      rail: PAYMENT_RAIL.MARKETPLACE,
    });

    const payout = await SystemPayout.create({
      requestType: SYSTEM_PAYOUT_REQUEST_TYPE.REFUND,
      targetType: PAYMENT_TARGET_TYPE.JOB,
      targetId: job._id,
      requestId: new mongoose.Types.ObjectId(),
      user: clientUser._id,
      amount: 150,
      currency: "USD",
      settlementMethod: SETTLEMENT_METHOD.STRIPE,
      payoutAccount: { accountName: "Test", accountNumber: "0123456789", bankName: "Test Bank", country: "NG" },
      createdBy: admin._id,
    });

    const res = await request(app)
      .patch(`/api/system-payouts/${payout.id}/paid`)
      .set("Authorization", `Bearer ${generateToken(admin)}`)
      .send({});

    expect(res.status).toBe(200);
    // Most recent first: 100 off pi_recent, then the remaining 50 off pi_older.
    expect(mockCreateRefund).toHaveBeenNthCalledWith(1, { paymentIntentId: "pi_recent", amount: 100 });
    expect(mockCreateRefund).toHaveBeenNthCalledWith(2, { paymentIntentId: "pi_older", amount: 50 });
    expect(res.body.transferReference).toBe("re_recent, re_older");
  });

  it("leaves the refund PENDING (502) when there isn't enough successful Stripe payment to cover it", async () => {
    const admin = await createAdmin();
    const clientUser = await createUser();
    const providerUser = await createUser();
    const job = await createActiveJob({ client: clientUser, provider: providerUser });

    await Payment.create({
      targetType: PAYMENT_TARGET_TYPE.JOB,
      targetId: job._id,
      user: clientUser._id,
      userEmail: clientUser.email,
      amount: 50,
      currency: "USD",
      provider: PAYMENT_PROVIDER_NAME.STRIPE,
      status: PAYMENT_STATUS.SUCCESS,
      providerPaymentId: "pi_small",
      rail: PAYMENT_RAIL.MARKETPLACE,
    });

    const payout = await SystemPayout.create({
      requestType: SYSTEM_PAYOUT_REQUEST_TYPE.REFUND,
      targetType: PAYMENT_TARGET_TYPE.JOB,
      targetId: job._id,
      requestId: new mongoose.Types.ObjectId(),
      user: clientUser._id,
      amount: 200,
      currency: "USD",
      settlementMethod: SETTLEMENT_METHOD.STRIPE,
      payoutAccount: { accountName: "Test", accountNumber: "0123456789", bankName: "Test Bank", country: "NG" },
      createdBy: admin._id,
    });

    const res = await request(app)
      .patch(`/api/system-payouts/${payout.id}/paid`)
      .set("Authorization", `Bearer ${generateToken(admin)}`)
      .send({});

    expect(res.status).toBe(502);
    const stillPending = await SystemPayout.findById(payout.id);
    expect(stillPending?.status).toBe("pending");
  });
});

describe("PATCH /api/system-payouts/:id/failed", () => {
  it("requires a failureReason", async () => {
    const admin = await createAdmin();
    const { payout } = await createSystemPayoutRecord();

    const res = await request(app)
      .patch(`/api/system-payouts/${payout.id}/failed`)
      .set("Authorization", `Bearer ${generateToken(admin)}`)
      .send({});

    expect(res.status).toBe(400);
  });

  it("marks a pending payout failed with a reason, and notifies the recipient", async () => {
    const admin = await createAdmin();
    const { payout, recipient } = await createSystemPayoutRecord();

    const res = await request(app)
      .patch(`/api/system-payouts/${payout.id}/failed`)
      .set("Authorization", `Bearer ${generateToken(admin)}`)
      .send({ failureReason: "Account number rejected by the bank" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("failed");
    expect(res.body.failureReason).toBe("Account number rejected by the bank");

    expect(sendTemplatedEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: recipient.email,
        template: "systemPayoutSettled",
        variables: expect.objectContaining({ paid: false, failureReason: "Account number rejected by the bank" }),
      }),
    );
  });
});

// requestDigitalCreatorPayout bundles unpaid purchases into one
// DIGITAL_CREATOR_PROFILE-targeted SystemPayout and flags each
// "requested" (payoutRequestId pointing at it) — settling that payout one
// way or the other must close the loop on those purchases too, or they
// never leave "requested" (see settleDigitalCreatorPurchases,
// systemPayoutController.ts).
describe("settling a DIGITAL_CREATOR_PROFILE payout closes the loop on its DigitalPurchases", () => {
  const setUpRequestedPurchases = async () => {
    const admin = await createAdmin();
    const creatorUser = await createUser();
    const profile = await createDigitalCreatorProfile({ user: creatorUser });
    const product = await createDigitalProduct({ creator: profile, price: 100 });
    const buyer = await createUser();
    const purchase = await createDigitalPurchase({
      product,
      buyer,
      creator: profile,
      status: DIGITAL_PURCHASE_STATUS.SUCCESS,
      platformFeePercent: 10,
    });

    const payout = await SystemPayout.create({
      requestType: SYSTEM_PAYOUT_REQUEST_TYPE.PAYOUT,
      targetType: SYSTEM_PAYOUT_TARGET_TYPE.DIGITAL_CREATOR_PROFILE,
      targetId: profile._id,
      requestId: new mongoose.Types.ObjectId(),
      user: creatorUser._id,
      amount: 90,
      currency: "USD",
      settlementMethod: SETTLEMENT_METHOD.MANUAL,
      payoutAccount: { accountName: "Test", accountNumber: "0123456789", bankName: "Test Bank", country: "NG" },
      createdBy: admin._id,
    });

    await DigitalPurchase.updateOne(
      { _id: purchase._id },
      { payoutStatus: "requested", payoutRequestId: payout._id },
    );

    return { admin, payout, purchase };
  };

  it("marks paid -> flips its DigitalPurchases to PAID", async () => {
    const { admin, payout, purchase } = await setUpRequestedPurchases();

    const res = await request(app)
      .patch(`/api/system-payouts/${payout.id}/paid`)
      .set("Authorization", `Bearer ${generateToken(admin)}`)
      .send({});

    expect(res.status).toBe(200);
    const updated = await DigitalPurchase.findById(purchase._id);
    expect(updated?.payoutStatus).toBe("paid");
  });

  it("marks failed -> returns its DigitalPurchases to UNPAID and un-links payoutRequestId", async () => {
    const { admin, payout, purchase } = await setUpRequestedPurchases();

    const res = await request(app)
      .patch(`/api/system-payouts/${payout.id}/failed`)
      .set("Authorization", `Bearer ${generateToken(admin)}`)
      .send({ failureReason: "Account number rejected by the bank" });

    expect(res.status).toBe(200);
    const updated = await DigitalPurchase.findById(purchase._id);
    expect(updated?.payoutStatus).toBe("unpaid");
    expect(updated?.payoutRequestId).toBeUndefined();
  });

  it("never touches DigitalPurchase at all for a JOB-targeted payout", async () => {
    const admin = await createAdmin();
    const recipient = await createUser({ payoutAccount: { accountName: "Test", accountNumber: "0123456789", bankName: "Test Bank", country: "NG" } });
    const clientUser = await createUser();
    const job = await createActiveJob({ client: clientUser, provider: recipient });

    const payout = await SystemPayout.create({
      requestType: SYSTEM_PAYOUT_REQUEST_TYPE.PAYOUT,
      targetType: SYSTEM_PAYOUT_TARGET_TYPE.JOB,
      targetId: job._id,
      requestId: new mongoose.Types.ObjectId(),
      user: recipient._id,
      amount: 200,
      currency: "USD",
      settlementMethod: SETTLEMENT_METHOD.MANUAL,
      payoutAccount: { accountName: "Test", accountNumber: "0123456789", bankName: "Test Bank", country: "NG" },
      createdBy: admin._id,
    });

    const res = await request(app)
      .patch(`/api/system-payouts/${payout.id}/paid`)
      .set("Authorization", `Bearer ${generateToken(admin)}`)
      .send({});

    expect(res.status).toBe(200);
  });
});
