import request from "supertest";
import mongoose from "mongoose";
import createApp from "../../src/app";
import { connectTestDB, disconnectTestDB, clearTestDB } from "../setup/db";
import {
  createUser,
  createAdmin,
  createCustomerCare,
  createUserWithActiveSubscription,
  createConsultancyProfile,
  createActiveJob,
  createDigitalCreatorProfile,
  createDigitalProduct,
  generateToken,
} from "../setup/fixtures";
import { PROFILE_TYPE } from "../../src/constants/profileTypes";
import { Job, JOB_STATUS, PAYMENT_REQUEST_STATUS } from "../../src/models/jobModel";
import { Payment, PAYMENT_STATUS, PAYMENT_TARGET_TYPE, PaymentStatus } from "../../src/models/paymentModel";
import { PAYMENT_PROVIDER_NAME } from "../../src/models/paymentProviderModel";
import { SystemPayout, SYSTEM_PAYOUT_REQUEST_TYPE, SYSTEM_PAYOUT_STATUS } from "../../src/models/systemPayoutModel";
import { MessageReport } from "../../src/models/messageReportModel";
import { Verification, VERIFICATION_STATUS } from "../../src/models/verificationModel";

const app = createApp();

beforeAll(async () => {
  await connectTestDB();
});

afterEach(async () => {
  await clearTestDB();
});

afterAll(async () => {
  await disconnectTestDB();
});

describe("GET /api/stats/top-profiles", () => {
  it("requires a valid profileType", async () => {
    const res = await request(app).get("/api/stats/top-profiles");
    expect(res.status).toBe(400);
  });

  it("ranks eligible profiles by rating, highest first", async () => {
    const low = await createUserWithActiveSubscription();
    await createConsultancyProfile({
      user: low,
      currentSubscription: low.currentSubscription,
      isVerified: true,
      ratingAverage: 3.5,
      ratingCount: 10,
    });

    const high = await createUserWithActiveSubscription();
    await createConsultancyProfile({
      user: high,
      currentSubscription: high.currentSubscription,
      isVerified: true,
      ratingAverage: 4.9,
      ratingCount: 50,
    });

    const unverified = await createUserWithActiveSubscription();
    await createConsultancyProfile({
      user: unverified,
      currentSubscription: unverified.currentSubscription,
      isVerified: false,
      ratingAverage: 5,
      ratingCount: 100,
    });

    const res = await request(app).get(`/api/stats/top-profiles?profileType=${PROFILE_TYPE.CONSULTANCY}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2); // the unverified one is excluded
    expect(res.body.data[0].ratingAverage).toBe(4.9);
    expect(res.body.data[1].ratingAverage).toBe(3.5);
  });

  it("respects the limit query param, capped at the max", async () => {
    for (let i = 0; i < 3; i++) {
      const user = await createUserWithActiveSubscription();
      await createConsultancyProfile({ user, currentSubscription: user.currentSubscription, isVerified: true });
    }

    const res = await request(app).get(`/api/stats/top-profiles?profileType=${PROFILE_TYPE.CONSULTANCY}&limit=2`);
    expect(res.body.data).toHaveLength(2);
  });
});

describe("GET /api/stats/overview", () => {
  it("blocks a regular user", async () => {
    const user = await createUser();
    const res = await request(app).get("/api/stats/overview").set("Authorization", `Bearer ${generateToken(user)}`);
    expect(res.status).toBe(401);
  });

  it("lets customer_care view it, and lets admin view it, with the expected shape", async () => {
    await createUser();
    await createUser({ accountStatus: "suspended" });

    for (const role of [await createAdmin(), await createCustomerCare()]) {
      const res = await request(app).get("/api/stats/overview").set("Authorization", `Bearer ${generateToken(role)}`);

      expect(res.status).toBe(200);
      expect(res.body.suspendedUsers).toBeGreaterThanOrEqual(1);
      expect(res.body.profileCounts).toHaveLength(Object.values(PROFILE_TYPE).length);
    }
  });

  it("returns completedJobsGrossAmount grouped by currency (array shape, not a single cross-currency sum)", async () => {
    // Job.currency is hard-locked to PLATFORM_CURRENCY (USD) — see
    // currencyReference.ts — so only one group is actually reachable in
    // practice today. The grouping logic itself stays (a $group by
    // currency, not one blind $sum) so this is still correct if that
    // lock is ever deliberately lifted for a second currency later.
    const client = await createUser();
    const provider = await createUser();
    await createActiveJob({
      client,
      provider,
      status: JOB_STATUS.COMPLETED,
      totalAmount: 1000,
    });
    await createActiveJob({
      client,
      provider,
      status: JOB_STATUS.COMPLETED,
      totalAmount: 500,
    });

    const admin = await createAdmin();
    const res = await request(app)
      .get("/api/stats/overview")
      .set("Authorization", `Bearer ${generateToken(admin)}`);

    expect(res.status).toBe(200);
    expect(res.body.completedJobsGrossAmount).toEqual([{ currency: "USD", total: 1500 }]);
  });

  it("computes money: heldInEscrow, platformFeesCollected, totalRefunded, totalPaidOut, owedNow, paymentsTotal", async () => {
    const client = await createUser();
    const provider = await createUser();
    const job = await createActiveJob({ client, provider, totalAmount: 1000 });
    // Paid 1000, 300 disbursed, 20 fee collected, 100 refunded, 150 paid
    // out — escrow = max(1000 - 300 - 20 - 100, 0) = 580.
    await Job.updateOne(
      { _id: job._id },
      { amountPaid: 1000, amountDisbursed: 300, platformFeeCollected: 20, totalRefunded: 100, amountPaidOut: 150 },
    );

    const recipient = await createUser({
      payoutAccount: { accountName: "Test", accountNumber: "0123456789", bankName: "Test Bank", country: "NG" },
    });
    await SystemPayout.create({
      requestType: SYSTEM_PAYOUT_REQUEST_TYPE.PAYOUT,
      targetType: PAYMENT_TARGET_TYPE.JOB,
      targetId: job._id,
      requestId: new mongoose.Types.ObjectId(),
      user: recipient._id,
      amount: 75,
      currency: "USD",
      payoutAccount: { accountName: "Test", accountNumber: "0123456789", bankName: "Test Bank", country: "NG" },
      createdBy: recipient._id,
      status: SYSTEM_PAYOUT_STATUS.PENDING,
    });
    // Not pending — must not count toward owedNow.
    await SystemPayout.create({
      requestType: SYSTEM_PAYOUT_REQUEST_TYPE.REFUND,
      targetType: PAYMENT_TARGET_TYPE.JOB,
      targetId: job._id,
      requestId: new mongoose.Types.ObjectId(),
      user: recipient._id,
      amount: 999,
      currency: "USD",
      payoutAccount: { accountName: "Test", accountNumber: "0123456789", bankName: "Test Bank", country: "NG" },
      createdBy: recipient._id,
      status: SYSTEM_PAYOUT_STATUS.PAID,
    });

    const makePayment = (targetType: string, amount: number, status: PaymentStatus = PAYMENT_STATUS.SUCCESS) =>
      Payment.create({
        targetType,
        targetId: new mongoose.Types.ObjectId(),
        user: client._id,
        userEmail: client.email,
        amount,
        currency: "USD",
        provider: PAYMENT_PROVIDER_NAME.STRIPE,
        status,
      });
    await makePayment(PAYMENT_TARGET_TYPE.JOB, 1000);
    await makePayment(PAYMENT_TARGET_TYPE.SUBSCRIPTION, 50);
    await makePayment(PAYMENT_TARGET_TYPE.DIGITAL_PURCHASE, 15);
    // Not successful — must not count.
    await makePayment(PAYMENT_TARGET_TYPE.JOB, 500, PAYMENT_STATUS.PENDING);

    const admin = await createAdmin();
    const res = await request(app).get("/api/stats/overview").set("Authorization", `Bearer ${generateToken(admin)}`);

    expect(res.status).toBe(200);
    expect(res.body.money).toEqual({
      heldInEscrow: 580,
      platformFeesCollected: 20,
      totalRefunded: 100,
      totalPaidOut: 150,
      owedNow: 75,
      paymentsTotal: { Job: 1000, Subscription: 50, DigitalPurchase: 15 },
    });
  });

  it("counts jobsByStatus across every status value", async () => {
    const client = await createUser();
    const provider = await createUser();
    await createActiveJob({ client, provider });
    const completed = await createActiveJob({ client, provider });
    await Job.updateOne({ _id: completed._id }, { status: JOB_STATUS.COMPLETED });
    const disputed = await createActiveJob({ client, provider });
    await Job.updateOne({ _id: disputed._id }, { status: JOB_STATUS.DISPUTED });

    const admin = await createAdmin();
    const res = await request(app).get("/api/stats/overview").set("Authorization", `Bearer ${generateToken(admin)}`);

    expect(res.status).toBe(200);
    expect(res.body.jobsByStatus).toEqual({
      pending_confirmation: 0,
      active: 1,
      disputed: 1,
      completed: 1,
      cancelled: 0,
      closed: 0,
    });
  });

  it("counts every queue the console's menu badges need, in one call", async () => {
    const client = await createUser();
    const provider = await createUser();

    // openDisputes
    const disputedJob = await createActiveJob({ client, provider });
    await Job.updateOne({ _id: disputedJob._id }, { isDispute: true });

    // pendingRefundRequests / pendingPayoutRequests
    const refundJob = await createActiveJob({ client, provider });
    await Job.updateOne(
      { _id: refundJob._id },
      { refunds: [{ amount: 50, reason: "test", status: PAYMENT_REQUEST_STATUS.PENDING, requestedBy: client._id, requestedAt: new Date() }] },
    );
    const payoutJob = await createActiveJob({ client, provider });
    await Job.updateOne(
      { _id: payoutJob._id },
      { payouts: [{ amount: 50, status: PAYMENT_REQUEST_STATUS.PENDING, requestedBy: provider._id, requestedAt: new Date() }] },
    );

    // systemPayoutsToPay
    await SystemPayout.create({
      requestType: SYSTEM_PAYOUT_REQUEST_TYPE.PAYOUT,
      targetType: PAYMENT_TARGET_TYPE.JOB,
      targetId: payoutJob._id,
      requestId: new mongoose.Types.ObjectId(),
      user: provider._id,
      amount: 50,
      currency: "USD",
      payoutAccount: { accountName: "Test", accountNumber: "0123456789", bankName: "Test Bank", country: "NG" },
      createdBy: client._id,
      status: SYSTEM_PAYOUT_STATUS.PENDING,
    });

    // pendingVerifications
    await Verification.create({
      profileType: PROFILE_TYPE.CONSULTANCY,
      profileId: new mongoose.Types.ObjectId(),
      user: client._id,
      location: { country: "NG" },
      templateId: new mongoose.Types.ObjectId(),
      status: VERIFICATION_STATUS.PENDING,
    });

    // pendingDigitalProducts
    const creatorProfile = await createDigitalCreatorProfile({ user: await createUser() });
    await createDigitalProduct({ creator: creatorProfile, isVerified: false });

    // openMessageReports
    await MessageReport.create({
      messageId: new mongoose.Types.ObjectId(),
      conversationId: new mongoose.Types.ObjectId(),
      reportedBy: client._id,
      reason: "flagged",
    });

    // bannedProfiles
    await createConsultancyProfile({ user: await createUser(), status: "banned" });

    const admin = await createAdmin();
    const res = await request(app).get("/api/stats/overview").set("Authorization", `Bearer ${generateToken(admin)}`);

    expect(res.status).toBe(200);
    expect(res.body.queues).toEqual({
      pendingVerifications: 1,
      pendingDigitalProducts: 1,
      openDisputes: 1,
      pendingRefundRequests: 1,
      pendingPayoutRequests: 1,
      systemPayoutsToPay: 1,
      openMessageReports: 1,
      bannedProfiles: 1,
    });
  });

  it("returns a zero-filled 30-day series ending today (UTC), plus totals for the period", async () => {
    const client = await createUser();
    const provider = await createUser();
    await createActiveJob({ client, provider });

    await Payment.create({
      targetType: PAYMENT_TARGET_TYPE.JOB,
      targetId: new mongoose.Types.ObjectId(),
      user: client._id,
      userEmail: client.email,
      amount: 42,
      currency: "USD",
      provider: PAYMENT_PROVIDER_NAME.STRIPE,
      status: PAYMENT_STATUS.SUCCESS,
    });

    const admin = await createAdmin();
    const res = await request(app).get("/api/stats/overview").set("Authorization", `Bearer ${generateToken(admin)}`);

    expect(res.status).toBe(200);
    expect(res.body.last30Days.series).toHaveLength(30);

    const today = new Date().toISOString().slice(0, 10);
    expect(res.body.last30Days.series[29].date).toBe(today);
    // Chronological order, 1 day apart, ending today.
    expect(res.body.last30Days.series[0].date < res.body.last30Days.series[29].date).toBe(true);

    const todayRow = res.body.last30Days.series[29];
    // client + provider created today, plus createAdmin()'s own admin
    // user — newUsers isn't asserted to an exact count for that reason,
    // just that today's activity actually landed in today's bucket.
    expect(todayRow.newUsers).toBeGreaterThanOrEqual(2);
    expect(todayRow.newJobs).toBeGreaterThanOrEqual(1);
    expect(todayRow.paymentsAmount).toBeGreaterThanOrEqual(42);

    expect(res.body.last30Days.totals.newJobs).toBeGreaterThanOrEqual(1);
    expect(res.body.last30Days.totals.paymentsAmount).toBeGreaterThanOrEqual(42);
  });
});
