// No real Mailgun call — same "mock the third-party integration
// entirely" boundary tests/README.md documents for helpers/emailSender.
jest.mock("../../src/helpers/emailSender", () => ({
  sendTemplatedEmail: jest.fn().mockResolvedValue({}),
  loadTemplates: jest.fn().mockResolvedValue(undefined),
}));

import request from "supertest";
import createApp from "../../src/app";
import { connectTestDB, disconnectTestDB, clearTestDB } from "../setup/db";
import { createUser, createAdmin, createCustomerCare, createActiveJob, generateToken } from "../setup/fixtures";
import {
  SystemPayout,
  SYSTEM_PAYOUT_REQUEST_TYPE,
  SYSTEM_PAYOUT_STATUS,
} from "../../src/models/systemPayoutModel";
import { PAYMENT_TARGET_TYPE } from "../../src/models/paymentModel";
import { sendTemplatedEmail } from "../../src/helpers/emailSender";

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
