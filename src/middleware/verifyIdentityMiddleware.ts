import bcrypt from "bcryptjs";
import { authenticator } from "otplib";
import asyncHandler from "express-async-handler";
import { Request, Response, NextFunction } from "express";
import { IUser } from "../models/userModel";
import { AppError } from "./errorMiddleware";

// Per-action re-proof-of-identity for a sensitive account change (e.g.
// updating a payout account) — not a route-wide auth check like
// `protect`/`secureRole`. Must run after `protect` (needs req.user), and
// *before* `validateBody`, which would otherwise strip `currentPassword`/
// `otpToken` off the body as fields unknown to that route's real schema —
// this reads the raw body on purpose.
//
// Takes the 2FA branch once userController.ts's setupTwoFactor +
// verifyTwoFactor have actually put a confirmed secret on
// `user.user2fa.secret` and flipped `enable` — until then (the default,
// for every account that's never gone through that flow) this always
// takes the password branch instead.
//
// Extracted from the middleware below so helpers/paymentGuardrails.ts can
// run the exact same "prove it's really you" check for a large payment
// (see docs/payments-plan.md's manual-review threshold) without
// duplicating it — a stolen-card fraudster essentially never also has
// the legitimate buyer's password or 2FA device, so this is a lever
// that's orthogonal to the payment method entirely.
export const verifyCurrentPasswordOr2FA = async (
  user: IUser,
  { currentPassword, otpToken }: { currentPassword?: string; otpToken?: string },
): Promise<void> => {
  if (user.user2fa?.enable) {
    if (!otpToken) {
      const error: AppError = new Error("A 2FA code is required to confirm this change");
      error.statusCode = 400;
      throw error;
    }

    let isValid: boolean;
    try {
      isValid = authenticator.verify({ token: otpToken, secret: user.user2fa.secret as string });
    } catch {
      isValid = false;
    }

    if (!isValid) {
      const error: AppError = new Error("Invalid 2FA code");
      error.statusCode = 403;
      throw error;
    }

    return;
  }

  if (!currentPassword) {
    const error: AppError = new Error("Your current password is required to confirm this change");
    error.statusCode = 400;
    throw error;
  }

  const isMatch = await bcrypt.compare(currentPassword, user.password);

  if (!isMatch) {
    const error: AppError = new Error("Current password is incorrect");
    error.statusCode = 403;
    throw error;
  }
};

export const verifyIdentity = asyncHandler(
  async (req: Request, _res: Response, next: NextFunction) => {
    await verifyCurrentPasswordOr2FA(req.user as IUser, {
      currentPassword: req.body?.currentPassword,
      otpToken: req.body?.otpToken,
    });
    next();
  },
);
