import asyncHandler from "express-async-handler";
import { Request, Response } from "express";
import { getSystemSettings } from "../helpers/systemSettings";
import { IUser } from "../models/userModel";

// @desc    Read the live scaling/risk-control settings (outstanding-
//          exposure cap, global max-transaction amount, supported
//          countries) — see helpers/paymentGuardrails.ts for where these
//          are actually enforced.
// @route   GET /api/system-settings
// @access  Private (REVIEW_ROLES)
export const getSettings = asyncHandler(async (_req: Request, res: Response) => {
  const settings = await getSystemSettings();
  res.status(200).json(settings);
});

// @desc    Update the live scaling/risk-control settings. Deliberately
//          Super Admin-only — these are the knobs that decide how much
//          money the system is willing to move, raised manually as
//          confidence grows (see docs/payments-plan.md).
// @route   PATCH /api/system-settings
// @access  Private (Super Admin only)
export const updateSettings = asyncHandler(async (req: Request, res: Response) => {
  const admin = req.user as IUser;
  const {
    maxOutstandingExposure,
    maxTransactionAmount,
    supportedCountries,
    fraudHoldThresholdAmount,
    fraudHoldHours,
    manualReviewThresholdAmount,
  } = req.body;

  const settings = await getSystemSettings();

  if (maxOutstandingExposure !== undefined) settings.maxOutstandingExposure = maxOutstandingExposure;
  if (maxTransactionAmount !== undefined) settings.maxTransactionAmount = maxTransactionAmount;
  if (supportedCountries !== undefined) settings.supportedCountries = supportedCountries;
  if (fraudHoldThresholdAmount !== undefined) settings.fraudHoldThresholdAmount = fraudHoldThresholdAmount;
  if (fraudHoldHours !== undefined) settings.fraudHoldHours = fraudHoldHours;
  if (manualReviewThresholdAmount !== undefined) settings.manualReviewThresholdAmount = manualReviewThresholdAmount;
  settings.updatedBy = admin._id as typeof settings.updatedBy;

  await settings.save();

  res.status(200).json(settings);
});
