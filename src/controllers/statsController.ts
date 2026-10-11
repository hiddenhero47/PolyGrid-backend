import asyncHandler from "express-async-handler";
import { Request, Response } from "express";
import { PROFILE_MODEL_REGISTRY, PROFILE_TYPE, ProfileType, isKnownProfileType } from "../constants/profileTypes";
import { PROFILE_STATUS } from "../constants/profileStatus";
import { User, ACCOUNT_STATUS } from "../models/userModel";
import { Subscription, SUBSCRIPTION_STATUS } from "../models/subscriptionModel";
import { Job, JOB_STATUS } from "../models/jobModel";
import { DigitalPurchase, DIGITAL_PURCHASE_STATUS } from "../models/digitalPurchaseModel";
import { StoreOrder } from "../models/storeOrderModel";

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

// @desc    Platform-wide numbers for the admin dashboard home. A starter
//          set, not exhaustive — add more counts here as needed, same
//          "grow this one function" instinct deploymentSetup.ts's task
//          list already uses.
// @route   GET /api/stats/overview
// @access  Private (Admin / Super Admin / Customer Care — read-only)
export const getPlatformOverview = asyncHandler(async (_req: Request, res: Response) => {
  const [
    totalUsers,
    suspendedUsers,
    activeSubscriptions,
    completedJobs,
    completedJobsTotal,
    successfulDigitalPurchases,
    storeOrders,
  ] = await Promise.all([
    User.countDocuments(),
    User.countDocuments({ accountStatus: ACCOUNT_STATUS.SUSPENDED }),
    Subscription.countDocuments({ status: SUBSCRIPTION_STATUS.ACTIVE, expiresAt: { $gt: new Date() } }),
    Job.countDocuments({ status: JOB_STATUS.COMPLETED }),
    Job.aggregate([
      { $match: { status: JOB_STATUS.COMPLETED } },
      { $group: { _id: null, sum: { $sum: "$totalAmount" } } },
    ]),
    DigitalPurchase.countDocuments({ status: DIGITAL_PURCHASE_STATUS.SUCCESS }),
    StoreOrder.countDocuments(),
  ]);

  res.status(200).json({
    totalUsers,
    suspendedUsers,
    activeSubscriptions,
    completedJobs,
    completedJobsGrossAmount: completedJobsTotal[0]?.sum ?? 0,
    successfulDigitalPurchases,
    storeOrders,
    profileCounts: await Promise.all(
      Object.values(PROFILE_TYPE).map(async (profileType) => ({
        profileType,
        total: await PROFILE_MODEL_REGISTRY[profileType].countDocuments(),
        verified: await PROFILE_MODEL_REGISTRY[profileType].countDocuments({ isVerified: true }),
      })),
    ),
  });
});
