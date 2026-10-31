import asyncHandler from "express-async-handler";
import { Request, Response } from "express";
import { PROFILE_MODEL_REGISTRY, PROFILE_TYPE, ProfileType, isKnownProfileType } from "../constants/profileTypes";
import { PROFILE_STATUS } from "../constants/profileStatus";
import { User, ACCOUNT_STATUS } from "../models/userModel";
import { Subscription, SUBSCRIPTION_STATUS } from "../models/subscriptionModel";
import { Job, JOB_STATUS, JobStatus, PAYMENT_REQUEST_STATUS } from "../models/jobModel";
import { DigitalPurchase, DIGITAL_PURCHASE_STATUS } from "../models/digitalPurchaseModel";
import { DigitalProduct } from "../models/digitalProductModel";
import { StoreOrder } from "../models/storeOrderModel";
import { Payment, PAYMENT_STATUS, PAYMENT_TARGET_TYPE } from "../models/paymentModel";
import { SystemPayout, SYSTEM_PAYOUT_STATUS } from "../models/systemPayoutModel";
import { MessageReport, MESSAGE_REPORT_STATUS } from "../models/messageReportModel";
import { Verification, VERIFICATION_STATUS } from "../models/verificationModel";

const MAX_TOP_PROFILES_LIMIT = 50;
const DEFAULT_TOP_PROFILES_LIMIT = 10;

// @desc    Top-rated profiles of one type — public, marketing/discovery
//          content ("Top Consultants", "Top Contractors"). Reuses
//          PROFILE_MODEL_REGISTRY so this works for any of the six
//          registered profile types with zero per-pillar code, the same
//          payoff the registry already gives adminProfileController's
//          generic ban endpoint. Restricted to the exact same
//          verified+active+currently-subscribed set every pillar's own
//          search endpoint already enforces — never surfaces a profile
//          that wouldn't show up in search anyway.
// @route   GET /api/stats/top-profiles?profileType=&country=&limit=
// @access  Public
export const getTopProfiles = asyncHandler(async (req: Request, res: Response) => {
  const { profileType, country } = req.query as { profileType?: string; country?: string };

  if (!profileType || !isKnownProfileType(profileType)) {
    res.status(400);
    throw new Error("A valid profileType is required");
  }

  const limit = Math.min(Number(req.query.limit) || DEFAULT_TOP_PROFILES_LIMIT, MAX_TOP_PROFILES_LIMIT);

  const Model = PROFILE_MODEL_REGISTRY[profileType as ProfileType];

  const match: Record<string, unknown> = {
    isVerified: true,
    status: PROFILE_STATUS.ACTIVE,
    currentSubscription: { $ne: null },
  };

  if (country) {
    match.country = String(country).toUpperCase();
  }

  const pipeline = [
    { $match: match },
    {
      $lookup: {
        from: "subscriptions",
        localField: "currentSubscription",
        foreignField: "_id",
        as: "subscription",
      },
    },
    { $unwind: "$subscription" },
    {
      $match: {
        "subscription.status": "active",
        "subscription.expiresAt": { $gt: new Date() },
      },
    },
    { $sort: { ratingAverage: -1 as const, ratingCount: -1 as const } },
    { $limit: limit },
  ];

  const data = await Model.aggregate(pipeline);

  res.status(200).json({
    profileType,
    data: data.map((doc) => ({
      id: doc._id,
      ratingAverage: doc.ratingAverage,
      ratingCount: doc.ratingCount,
      // Every registered profile type carries one of these two "what do I
      // call myself" fields — never both — so expose whichever is there
      // rather than hardcoding a field name only some of the six have.
      headline: doc.headline,
      displayName: doc.displayName,
      storeName: doc.storeName,
      slug: doc.slug,
      country: doc.country,
    })),
  });
});

// Every money-handling model validates its own `currency` against
// PLATFORM_CURRENCY (see helpers/currencyReference.ts) — there's no real
// multi-currency to group by here, unlike completedJobsGrossAmount below
// (kept grouped since it predates that hard lock and a stray non-USD
// value would otherwise get silently summed in).
const DAYS_IN_PERIOD = 30;

// Midnight UTC today, and the same 30 days back — the frontend's own
// "ending today (UTC)" spec. endExclusive is tomorrow's midnight, so a
// $lt against it is inclusive of every moment of "today."
const periodWindow = () => {
  const now = new Date();
  const todayUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const start = new Date(todayUTC.getTime() - (DAYS_IN_PERIOD - 1) * 24 * 60 * 60 * 1000);
  const endExclusive = new Date(todayUTC.getTime() + 24 * 60 * 60 * 1000);
  return { start, endExclusive };
};

const byDayPipeline = (match: Record<string, unknown>, sumField?: string) => [
  { $match: match },
  {
    $group: {
      _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: "UTC" } },
      value: sumField ? { $sum: `$${sumField}` } : { $sum: 1 },
    },
  },
];

// @desc    Platform-wide numbers for the admin dashboard home. A starter
//          set, not exhaustive — add more counts here as needed, same
//          "grow this one function" instinct deploymentSetup.ts's task
//          list already uses.
// @route   GET /api/stats/overview
// @access  Private (Admin / Super Admin / Customer Care — read-only)
export const getPlatformOverview = asyncHandler(async (_req: Request, res: Response) => {
  const { start, endExclusive } = periodWindow();

  const [
    totalUsers,
    suspendedUsers,
    activeSubscriptions,
    completedJobs,
    completedJobsTotal,
    successfulDigitalPurchases,
    storeOrders,
    // money
    jobMoneyTotals,
    owedNowTotal,
    paymentsTotalsByType,
    // jobsByStatus
    jobsByStatusRaw,
    // queues
    pendingVerifications,
    pendingDigitalProducts,
    openDisputes,
    pendingRefundRequests,
    pendingPayoutRequests,
    systemPayoutsToPay,
    openMessageReports,
    bannedProfilesByType,
    // last30Days
    usersByDay,
    jobsByDay,
    paymentsByDay,
    periodCompletedJobs,
  ] = await Promise.all([
    User.countDocuments(),
    User.countDocuments({ accountStatus: ACCOUNT_STATUS.SUSPENDED }),
    Subscription.countDocuments({ status: SUBSCRIPTION_STATUS.ACTIVE, expiresAt: { $gt: new Date() } }),
    Job.countDocuments({ status: JOB_STATUS.COMPLETED }),
    // Grouped by currency — a single summed total across jobs in NGN, USD,
    // etc. would be a meaningless number, not just an imprecise one.
    Job.aggregate([
      { $match: { status: JOB_STATUS.COMPLETED } },
      { $group: { _id: "$currency", sum: { $sum: "$totalAmount" } } },
      { $sort: { _id: 1 as const } },
    ]),
    DigitalPurchase.countDocuments({ status: DIGITAL_PURCHASE_STATUS.SUCCESS }),
    StoreOrder.countDocuments(),
    // heldInEscrow/platformFeesCollected/totalRefunded/totalPaidOut — one
    // pass over every job. heldInEscrow is exactly jobController's own
    // refundableAmount(job), summed: funds paid in, not yet disbursed,
    // fee-collected, or refunded, floored at 0 per job before summing
    // (a job can't have *negative* escrow just because another job is
    // still mid-payout).
    Job.aggregate([
      {
        $group: {
          _id: null,
          platformFeesCollected: { $sum: "$platformFeeCollected" },
          totalRefunded: { $sum: "$totalRefunded" },
          totalPaidOut: { $sum: "$amountPaidOut" },
          heldInEscrow: {
            $sum: {
              $max: [
                {
                  $subtract: [
                    "$amountPaid",
                    { $add: ["$amountDisbursed", "$platformFeeCollected", "$totalRefunded"] },
                  ],
                },
                0,
              ],
            },
          },
        },
      },
    ]),
    SystemPayout.aggregate([
      { $match: { status: SYSTEM_PAYOUT_STATUS.PENDING } },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]),
    Payment.aggregate([
      { $match: { status: PAYMENT_STATUS.SUCCESS } },
      { $group: { _id: "$targetType", total: { $sum: "$amount" } } },
    ]),
    Job.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]),
    Verification.countDocuments({ status: VERIFICATION_STATUS.PENDING }),
    DigitalProduct.countDocuments({ isVerified: false }),
    Job.countDocuments({ isDispute: true }),
    // Counts JOBS with at least one pending item, not the item count —
    // same definition GET /api/jobs/refund-requests|payout-requests
    // already use for their own `total`, so this badge always matches
    // what opening that queue actually shows.
    Job.countDocuments({ "refunds.status": PAYMENT_REQUEST_STATUS.PENDING }),
    Job.countDocuments({ "payouts.status": PAYMENT_REQUEST_STATUS.PENDING }),
    SystemPayout.countDocuments({ status: SYSTEM_PAYOUT_STATUS.PENDING }),
    MessageReport.countDocuments({ status: MESSAGE_REPORT_STATUS.PENDING }),
    Promise.all(
      Object.values(PROFILE_TYPE).map((profileType) =>
        PROFILE_MODEL_REGISTRY[profileType].countDocuments({ status: PROFILE_STATUS.BANNED }),
      ),
    ),
    User.aggregate(byDayPipeline({ createdAt: { $gte: start, $lt: endExclusive } })),
    Job.aggregate(byDayPipeline({ createdAt: { $gte: start, $lt: endExclusive } })),
    Payment.aggregate(
      byDayPipeline({ status: PAYMENT_STATUS.SUCCESS, createdAt: { $gte: start, $lt: endExclusive } }, "amount"),
    ),
    // updatedAt, not createdAt — nothing else in this codebase ever
    // re-saves a job once it's COMPLETED (every mutating stage/dispute
    // route requires ACTIVE first), so this is exactly "when it became
    // completed," not an approximation of it.
    Job.countDocuments({ status: JOB_STATUS.COMPLETED, updatedAt: { $gte: start, $lt: endExclusive } }),
  ]);

  const jobMoney = jobMoneyTotals[0] ?? {
    platformFeesCollected: 0,
    totalRefunded: 0,
    totalPaidOut: 0,
    heldInEscrow: 0,
  };

  const paymentsTotal = {
    [PAYMENT_TARGET_TYPE.JOB]: 0,
    [PAYMENT_TARGET_TYPE.SUBSCRIPTION]: 0,
    [PAYMENT_TARGET_TYPE.DIGITAL_PURCHASE]: 0,
  };
  for (const row of paymentsTotalsByType) {
    if (row._id in paymentsTotal) paymentsTotal[row._id as keyof typeof paymentsTotal] = row.total;
  }

  const jobsByStatus = Object.fromEntries(Object.values(JOB_STATUS).map((status) => [status, 0])) as Record<
    JobStatus,
    number
  >;
  for (const row of jobsByStatusRaw) {
    if (row._id in jobsByStatus) jobsByStatus[row._id as JobStatus] = row.count;
  }

  const bannedProfiles = bannedProfilesByType.reduce((sum, count) => sum + count, 0);

  const usersByDayMap = new Map(usersByDay.map((row) => [row._id, row.value]));
  const jobsByDayMap = new Map(jobsByDay.map((row) => [row._id, row.value]));
  const paymentsByDayMap = new Map(paymentsByDay.map((row) => [row._id, row.value]));

  const last30Days: { date: string; newUsers: number; newJobs: number; paymentsAmount: number }[] = [];
  let newUsersTotal = 0;
  let newJobsTotal = 0;
  let paymentsAmountTotal = 0;

  for (let i = 0; i < DAYS_IN_PERIOD; i++) {
    const date = new Date(start.getTime() + i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const newUsers = usersByDayMap.get(date) ?? 0;
    const newJobs = jobsByDayMap.get(date) ?? 0;
    const paymentsAmount = paymentsByDayMap.get(date) ?? 0;

    last30Days.push({ date, newUsers, newJobs, paymentsAmount });
    newUsersTotal += newUsers;
    newJobsTotal += newJobs;
    paymentsAmountTotal += paymentsAmount;
  }

  res.status(200).json({
    totalUsers,
    suspendedUsers,
    activeSubscriptions,
    completedJobs,
    completedJobsGrossAmount: completedJobsTotal.map((row) => ({
      currency: row._id,
      total: row.sum,
    })),
    successfulDigitalPurchases,
    storeOrders,
    profileCounts: await Promise.all(
      Object.values(PROFILE_TYPE).map(async (profileType) => ({
        profileType,
        total: await PROFILE_MODEL_REGISTRY[profileType].countDocuments(),
        verified: await PROFILE_MODEL_REGISTRY[profileType].countDocuments({ isVerified: true }),
      })),
    ),
    money: {
      heldInEscrow: jobMoney.heldInEscrow,
      platformFeesCollected: jobMoney.platformFeesCollected,
      totalRefunded: jobMoney.totalRefunded,
      totalPaidOut: jobMoney.totalPaidOut,
      owedNow: owedNowTotal[0]?.total ?? 0,
      paymentsTotal,
    },
    jobsByStatus,
    queues: {
      pendingVerifications,
      pendingDigitalProducts,
      openDisputes,
      pendingRefundRequests,
      pendingPayoutRequests,
      systemPayoutsToPay,
      openMessageReports,
      bannedProfiles,
    },
    last30Days: {
      series: last30Days,
      totals: {
        newUsers: newUsersTotal,
        newJobs: newJobsTotal,
        paymentsAmount: paymentsAmountTotal,
        completedJobs: periodCompletedJobs,
      },
    },
  });
});
