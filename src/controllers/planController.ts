import asyncHandler from "express-async-handler";
import mongoose from "mongoose";
import { Request, Response } from "express";
import { Plan, PLAN_TIER } from "../models/planModel";

// @desc    List available plans (active only, unless includeInactive=true)
// @route   GET /api/plans
// @access  Public
export const listPlans = asyncHandler(async (req: Request, res: Response) => {
  const includeInactive = req.query.includeInactive === "true";

  const plans = await Plan.find(includeInactive ? {} : { isActive: true }).sort({
    price: 1,
  });

  res.status(200).json(plans);
});

// @desc    Get a single plan by id
// @route   GET /api/plans/:id
// @access  Public
export const getPlan = asyncHandler(async (req: Request, res: Response) => {
  const id = req.params.id as string;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    res.status(400);
    throw new Error("Invalid plan id");
  }

  const plan = await Plan.findById(id);

  if (!plan) {
    res.status(404);
    throw new Error("Plan not found");
  }

  res.status(200).json(plan);
});

// @desc    Create a plan
// @route   POST /api/plans
// @access  Private (Super Admin only)
export const createPlan = asyncHandler(async (req: Request, res: Response) => {
  const { planTier, name, privileges, duration, maxUsers, price, currency } = req.body;

  if (!planTier || !name || !duration || price === undefined) {
    res.status(400);
    throw new Error("Please add planTier, name, duration and price");
  }

  if (!Object.values(PLAN_TIER).includes(planTier)) {
    res.status(400);
    throw new Error("Invalid plan tier");
  }

  const existing = await Plan.findOne({ planTier });
  if (existing) {
    res.status(400);
    throw new Error("A plan for this tier already exists");
  }

  const plan = await Plan.create({
    planTier,
    name,
    privileges,
    duration,
    maxUsers: maxUsers ?? null,
    price,
    currency,
  });

  res.status(201).json(plan);
});

// @desc    Update a plan (privileges, price, duration, isActive, ...)
// @route   PUT /api/plans/:id
// @access  Private (Super Admin only)
// Plans are never deleted — historical Subscriptions reference them by id
// and rely on their own snapshotted planTier/privileges, but the reference
// itself would dangle. Deprecate a plan with `isActive: false` instead.
export const updatePlan = asyncHandler(async (req: Request, res: Response) => {
  const id = req.params.id as string;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    res.status(400);
    throw new Error("Invalid plan id");
  }

  const plan = await Plan.findById(id);

  if (!plan) {
    res.status(404);
    throw new Error("Plan not found");
  }

  const { name, privileges, duration, maxUsers, price, currency, isActive } = req.body;

  if (name !== undefined) plan.name = name;
  if (privileges !== undefined) plan.privileges = privileges;
  if (duration !== undefined) plan.duration = duration;
  if (maxUsers !== undefined) plan.maxUsers = maxUsers;
  if (price !== undefined) plan.price = price;
  if (currency !== undefined) plan.currency = currency;
  if (isActive !== undefined) plan.isActive = isActive;

  await plan.save();

  res.status(200).json(plan);
});
