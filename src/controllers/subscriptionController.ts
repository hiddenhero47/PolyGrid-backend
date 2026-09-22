import asyncHandler from "express-async-handler";
import mongoose from "mongoose";
import { Request, Response } from "express";
import { User, IUser } from "../models/userModel";
import { Plan } from "../models/planModel";
import { Subscription } from "../models/subscriptionModel";
import { Payment, PAYMENT_TARGET_TYPE, PAYMENT_STATUS } from "../models/paymentModel";
import { PAYMENT_PROVIDER_NAME } from "../models/paymentProviderModel";

const DAY_MS = 24 * 60 * 60 * 1000;

const paginationParams = (req: Request) => {
  const page = Math.max(Number(req.query.page) || 1, 1);
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  return { page, limit, skip: (page - 1) * limit };
};

// @desc    Grant a user a subscription to a plan (creates a new history
//          record and points the user's currentSubscription at it — this is
//          the interim admin tool until a payment provider's webhook is the
//          one calling this instead of a human). Also creates a Payment
//          record (provider: 'manual') so subscription and job payments
//          share one unified ledger.
// @route   POST /api/subscriptions
// @access  Private (Admin / Super Admin only)
export const grantSubscription = asyncHandler(async (req: Request, res: Response) => {
  const admin = req.user as IUser;
  const { userId, planTier, paymentProviderId, paymentId, autoRenew } = req.body;

  if (!userId || !planTier) {
    res.status(400);
    throw new Error("Please add userId and planTier");
  }

  if (!mongoose.Types.ObjectId.isValid(userId)) {
    res.status(400);
    throw new Error("Invalid user id");
  }

  const user = await User.findById(userId);
  if (!user) {
    res.status(404);
    throw new Error("User not found");
  }

  const plan = await Plan.findOne({ planTier, isActive: true });
  if (!plan) {
    res.status(400);
    throw new Error("No active plan found for that tier");
  }

  const periodStarted = new Date();
  const expiresAt = new Date(periodStarted.getTime() + plan.duration * DAY_MS);

  const subscription = await Subscription.create({
    user: user._id,
    plan: plan._id,
    planTier: plan.planTier,
    privileges: plan.privileges,
    autoRenew: Boolean(autoRenew),
    paymentProviderId,
    paymentId,
    periodStarted,
    expiresAt,
  });

  user.currentSubscription = subscription._id as mongoose.Types.ObjectId;
  await user.save();

  await Payment.create({
    targetType: PAYMENT_TARGET_TYPE.SUBSCRIPTION,
    targetId: subscription._id,
    user: user._id,
    userEmail: user.email,
    amount: plan.price,
    currency: plan.currency,
    provider: PAYMENT_PROVIDER_NAME.MANUAL,
    status: PAYMENT_STATUS.SUCCESS,
    recordedBy: admin._id,
  });

  res.status(201).json(subscription);
});

// @desc    Get the logged-in user's subscription history, newest first
// @route   GET /api/subscriptions/me
// @access  Private
export const getMySubscriptions = asyncHandler(async (req: Request, res: Response) => {
  const { page, limit, skip } = paginationParams(req);
  const userId = (req.user as IUser).id;

  const [data, total] = await Promise.all([
    Subscription.find({ user: userId })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
    Subscription.countDocuments({ user: userId }),
  ]);

  res.status(200).json({
    data,
    pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
  });
});

// @desc    Get any user's subscription history, newest first
// @route   GET /api/subscriptions/users/:userId
// @access  Private (Admin / Super Admin only)
export const getUserSubscriptions = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.params.userId as string;

  if (!mongoose.Types.ObjectId.isValid(userId)) {
    res.status(400);
    throw new Error("Invalid user id");
  }

  const { page, limit, skip } = paginationParams(req);

  const [data, total] = await Promise.all([
    Subscription.find({ user: userId })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
    Subscription.countDocuments({ user: userId }),
  ]);

  res.status(200).json({
    data,
    pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
  });
});

// @desc    Get the logged-in user's current subscription (or null)
// @route   GET /api/subscriptions/current
// @access  Private
export const getCurrentPlan = asyncHandler(async (req: Request, res: Response) => {
  res.status(200).json({ currentPlan: req.currentPlan ?? null });
});
