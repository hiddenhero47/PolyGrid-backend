import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import asyncHandler from "express-async-handler";
import { authenticator } from "otplib";
import qrcode from "qrcode";
import { Request, Response } from "express";
import { OAuth2Client } from "google-auth-library";
import appleSignin from "apple-signin-auth";
import {
  User,
  IUser,
  SYSTEM_ROLE,
  ACCOUNT_TYPE,
  AUTH_PROVIDER,
  AuthProviderName,
  TOKENS,
} from "../models/userModel";
import {
  uploadHandler,
  deleteStoredFile,
  FILE_VISIBILITY,
  IMAGE_ONLY_MIME_TYPES,
  countUploadCandidates,
} from "../helpers/fileStorage";
import { sendTemplatedEmail } from "../helpers/emailSender";
import { AppError } from "../middleware/errorMiddleware";
import { PROFILE_MODEL_REGISTRY, ProfileType } from "../constants/profileTypes";

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

const generateToken = (user: IUser): string => {
  return jwt.sign(
    { id: user._id, sessionId: user.sessionId },
    process.env.JWT_SECRET as string,
    { expiresIn: "1d" },
  );
};

const toPublicUser = (user: IUser) => ({
  id: user.id,
  fullName: user.fullName,
  email: user.email,
  phoneNumber: user.phoneNumber,
  // storagePath is internal only (used to delete the old file on replace) —
  // never sent to a client.
  avatar: user.avatar
    ? { fileName: user.avatar.fileName, mime: user.avatar.mime, size: user.avatar.size, url: user.avatar.url }
    : undefined,
  verified: user.verified,
  systemRole: user.systemRole,
  activeAccountType: user.activeAccountType,
  currentSubscription: user.currentSubscription,
  user2fa: {
    enable: user.user2fa?.enable || false,
  },
  payoutAccount: user.payoutAccount,
});

// Shared by loginUser/googleLogin/appleLogin — whichever path actually
// authenticated the caller (a password, a verified Google/Apple token),
// a second factor still isn't optional once the account has one on
// file. `code` lets the frontend tell "no code sent yet" (prompt for
// one) apart from "the code sent was wrong" (reject it), matching
// house-maduekwe-backend's same distinction. A brand-new OAuth account
// (just created by createOAuthUser) can never have 2FA enabled yet, so
// this is a no-op for that case — safe to call unconditionally on every
// login path, not just the password one.
const enforceTwoFactor = (user: IUser, token: string | undefined, res: Response): void => {
  if (!user.user2fa?.enable) return;

  if (!token) {
    res.status(400);
    const error: AppError = new Error("A 2FA code is required");
    error.code = "2FA_REQUIRED";
    throw error;
  }

  let isValid: boolean;
  try {
    isValid = authenticator.verify({ token, secret: user.user2fa.secret as string });
  } catch {
    isValid = false;
  }

  if (!isValid) {
    res.status(400);
    const error: AppError = new Error("Invalid 2FA code");
    error.code = "2FA_INVALID";
    throw error;
  }
};

// Shared by registerUser/resendVerification. Same idempotent-reuse
// pattern as requestReset's token: a still-valid existing token is
// reused rather than silently invalidating one a user already has open
// in another tab. 24h, not requestReset's 10m — there's no stale-
// credential risk here the way there is with a password reset link, and
// someone verifying from a different device than they registered on
// shouldn't have to race a short window.
const sendVerificationEmail = async (
  user: IUser,
): Promise<{ verifyEmailToken: string; verifyUrl: string }> => {
  const existingToken = user.tokenCache?.get(TOKENS.VERIFY_EMAIL);

  let code: string;
  let expiresAt: Date;

  if (existingToken && existingToken.expiresAt > new Date()) {
    code = existingToken.code;
    expiresAt = existingToken.expiresAt;
  } else {
    code = crypto.randomUUID();
    expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    user.tokenCache.set(TOKENS.VERIFY_EMAIL, { code, expiresAt });
    await user.save();
  }

  const verifyEmailToken = jwt.sign(
    { email: user.email, code },
    process.env.JWT_EMAIL_SECRET as string,
    { expiresIn: "24h" },
  );

  const verifyUrl = `${process.env.FRONTEND_URL}/verify-email/${verifyEmailToken}`;

  await sendTemplatedEmail({
    to: user.email,
    subject: "Verify Your Email",
    template: "verifyEmail",
    variables: { name: user.fullName, verifyUrl, expiresIn: "24 hours" },
  });

  return { verifyEmailToken, verifyUrl };
};

// @desc    Register a new user
// @route   POST /api/users
// @access  Public
export const registerUser = asyncHandler(async (req: Request, res: Response) => {
  const { fullName, email, password, phoneNumber } = req.body;

  const userExists = await User.findOne({ email });
  if (userExists) {
    res.status(400);
    throw new Error("User already exists");
  }

  const salt = await bcrypt.genSalt(10);
  const hashedPassword = await bcrypt.hash(password, salt);

  const user = await User.create({
    fullName,
    email,
    password: hashedPassword,
    phoneNumber,
    systemRole: SYSTEM_ROLE.USER,
  });

  // Never lets a Mailgun hiccup fail the registration itself — the account
  // is already created and usable (verified or not, nothing gates on it
  // today); resendVerification below is the recovery path if this fails
  // or the email never arrives.
  let verification: { verifyEmailToken: string; verifyUrl: string } | undefined;
  try {
    verification = await sendVerificationEmail(user);
  } catch (err) {
    console.error("Failed to send verification email", err);
  }

  res.status(201).json({
    ...toPublicUser(user),
    token: generateToken(user),
    // Outside production only — same reasoning as requestReset's dev-mode
    // resetUrl/token: lets the verify flow be exercised end-to-end without
    // real Mailgun credentials configured locally. Named distinctly from
    // the auth `token` above so spreading this never overwrites it.
    ...(process.env.NODE_ENV !== "production" && verification ? verification : {}),
  });
});

// @desc    Resend the account verification email
// @route   POST /api/users/resend-verification
// @access  Public
export const resendVerification = asyncHandler(async (req: Request, res: Response) => {
  const { email } = req.body;

  const user = await User.findOne({ email: String(email).toLowerCase().trim() });

  // Same no-enumeration instinct as requestReset: identical response
  // whether the account doesn't exist, is already verified, or the email
  // actually goes out — none of that is anyone else's business to probe.
  const genericResponse = {
    message: "If an account exists with that email and isn't verified yet, a verification link has been sent.",
  };

  if (!user || user.verified) {
    res.status(200).json(genericResponse);
    return;
  }

  const verification = await sendVerificationEmail(user);

  res.status(200).json({
    ...genericResponse,
    ...(process.env.NODE_ENV !== "production" ? verification : {}),
  });
});

// @desc    Verify an account's email using a verification token
// @route   POST /api/users/verify-email
// @access  Public
export const verifyEmail = asyncHandler(async (req: Request, res: Response) => {
  const { token } = req.body;

  let decoded: { email: string; code: string };

  try {
    decoded = jwt.verify(token, process.env.JWT_EMAIL_SECRET as string) as {
      email: string;
      code: string;
    };
  } catch {
    res.status(400);
    throw new Error("Invalid or expired verification token");
  }

  const user = await User.findOne({ email: decoded.email });

  if (!user) {
    res.status(400);
    throw new Error("Invalid or expired verification token");
  }

  if (user.verified) {
    res.status(200).json({ message: "Email already verified" });
    return;
  }

  const verifyToken = user.tokenCache?.get(TOKENS.VERIFY_EMAIL);

  if (!verifyToken || verifyToken.code !== decoded.code) {
    res.status(400);
    throw new Error("Invalid or expired verification token");
  }

  if (verifyToken.expiresAt < new Date()) {
    user.tokenCache.delete(TOKENS.VERIFY_EMAIL);
    await user.save();

    res.status(400);
    throw new Error("Verification token has expired");
  }

  user.verified = true;
  user.tokenCache.delete(TOKENS.VERIFY_EMAIL);
  await user.save();

  res.status(200).json({ message: "Email verified successfully" });
});

// @desc    Authenticate a user
// @route   POST /api/users/login
// @access  Public
export const loginUser = asyncHandler(async (req: Request, res: Response) => {
  const { email, password, token } = req.body;

  const user = await User.findOne({ email });

  if (!user || !(await bcrypt.compare(password, user.password))) {
    res.status(400);
    throw new Error("Invalid user credentials");
  }

  enforceTwoFactor(user, token, res);

  res.json({
    ...toPublicUser(user),
    token: generateToken(user),
  });
});

// Only used by googleLogin/appleLogin. An OAuth-only account still needs
// *some* value in the required `password` field — this hash is never
// derived from anything the user typed and is never used to log in with a
// password, it just satisfies the schema.
const createOAuthUser = async ({
  fullName,
  email,
  provider,
  providerId,
  picture,
}: {
  fullName?: string;
  email: string;
  provider: AuthProviderName;
  providerId: string;
  picture?: string;
}) => {
  // Left for Mongoose to infer (matches User.create()'s actual hydrated-
  // document return type) rather than annotating `: Promise<IUser>` here —
  // an explicit plain-interface annotation doesn't line up with what
  // User.findOne() returns, so callers can't cleanly reassign between them.
  const dummyPassword = await bcrypt.hash(providerId + (process.env.JWT_SECRET as string), 10);

  let avatar: IUser["avatar"];

  if (picture) {
    const { results } = await uploadHandler({
      req: { body: { url: picture } } as unknown as Request,
      visibility: FILE_VISIBILITY.PUBLIC,
      allowedMimeTypes: ["image/jpeg", "image/png", "image/webp"],
    });

    if (results.length > 0) {
      const saved = results[0];
      avatar = {
        fileName: saved.fileName,
        storagePath: saved.storagePath,
        mime: saved.mime,
        size: saved.size,
        url: saved.url,
      };
    }
  }

  return User.create({
    fullName: fullName || "User",
    email,
    avatar,
    password: dummyPassword,
    authProviders: [{ provider, providerId }],
    systemRole: SYSTEM_ROLE.USER,
    // Google verifies the email itself before ever handing it to us; Apple
    // does too, but house-maduekwe-backend only trusts Google's here, so
    // this keeps that same (slightly more conservative) behavior.
    verified: provider === AUTH_PROVIDER.GOOGLE,
  });
};

// @desc    Sign in (or sign up) with a Google ID token
// @route   POST /api/users/social/google
// @access  Public
export const googleLogin = asyncHandler(async (req: Request, res: Response) => {
  const { idToken, token } = req.body;

  const ticket = await googleClient.verifyIdToken({
    idToken,
    audience: process.env.GOOGLE_CLIENT_ID,
  });

  const payload = ticket.getPayload();

  if (!payload) {
    res.status(400);
    throw new Error("Invalid Google token");
  }

  const { sub, email, name, picture } = payload;

  let user = email ? await User.findOne({ email }) : null;

  if (!user && !email) {
    user = await User.findOne({
      "authProviders.provider": AUTH_PROVIDER.GOOGLE,
      "authProviders.providerId": sub,
    });
  }

  if (!user) {
    if (!email) {
      res.status(400);
      throw new Error("Google did not share an email for this account");
    }

    user = await createOAuthUser({
      fullName: name,
      email,
      provider: AUTH_PROVIDER.GOOGLE,
      providerId: sub,
      picture,
    });
  } else {
    const duplicateProvider = await User.findOne({
      "authProviders.provider": AUTH_PROVIDER.GOOGLE,
      "authProviders.providerId": sub,
    });

    if (duplicateProvider && duplicateProvider._id.toString() !== user._id.toString()) {
      res.status(409);
      throw new Error("This Google account is already linked to another user");
    }

    const alreadyLinked = user.authProviders.some((p) => p.provider === AUTH_PROVIDER.GOOGLE);

    if (!alreadyLinked) {
      user.authProviders.push({ provider: AUTH_PROVIDER.GOOGLE, providerId: sub });

      if (!user.avatar && picture) {
        const { results } = await uploadHandler({
          req: { body: { url: picture } } as unknown as Request,
          visibility: FILE_VISIBILITY.PUBLIC,
          allowedMimeTypes: ["image/jpeg", "image/png", "image/webp"],
        });

        if (results.length > 0) {
          const saved = results[0];
          user.avatar = {
            fileName: saved.fileName,
            storagePath: saved.storagePath,
            mime: saved.mime,
            size: saved.size,
            url: saved.url,
          };
        }
      }

      await user.save();
    }
  }

  enforceTwoFactor(user, token, res);

  res.json({
    ...toPublicUser(user),
    token: generateToken(user),
  });
});

// @desc    Sign in (or sign up) with an Apple identity token
// @route   POST /api/users/social/apple
// @access  Public
// Apple only shares an email on the *first* authorization for a given app —
// later logins may omit it entirely, which is exactly why lookups here fall
// back to authProviders.providerId (Apple's `sub`) instead of email alone.
export const appleLogin = asyncHandler(async (req: Request, res: Response) => {
  const { identityToken, token } = req.body;

  const appleUser = await appleSignin.verifyIdToken(identityToken, {
    audience: process.env.APPLE_CLIENT_ID,
    ignoreExpiration: false,
  });

  const { sub, email } = appleUser;

  let user = email ? await User.findOne({ email }) : null;

  if (!user && !email) {
    user = await User.findOne({
      "authProviders.provider": AUTH_PROVIDER.APPLE,
      "authProviders.providerId": sub,
    });
  }

  if (!user) {
    if (!email) {
      res.status(400);
      throw new Error("No account found for this Apple id, and Apple did not share an email");
    }

    user = await createOAuthUser({
      fullName: "Apple User",
      email,
      provider: AUTH_PROVIDER.APPLE,
      providerId: sub,
    });
  } else {
    const duplicateProvider = await User.findOne({
      "authProviders.provider": AUTH_PROVIDER.APPLE,
      "authProviders.providerId": sub,
    });

    if (duplicateProvider && duplicateProvider._id.toString() !== user._id.toString()) {
      res.status(409);
      throw new Error("This Apple account is already linked to another user");
    }

    const alreadyLinked = user.authProviders.some((p) => p.provider === AUTH_PROVIDER.APPLE);

    if (!alreadyLinked) {
      user.authProviders.push({ provider: AUTH_PROVIDER.APPLE, providerId: sub });
      await user.save();
    }
  }

  enforceTwoFactor(user, token, res);

  res.json({
    ...toPublicUser(user),
    token: generateToken(user),
  });
});

// @desc    Get the logged-in user's data
// @route   GET /api/users/me
// @access  Private
export const getMe = asyncHandler(async (req: Request, res: Response) => {
  res.status(200).json(toPublicUser(req.user as IUser));
});

// @desc    Which pillar profiles (if any) I have, in one call — a lighter
//          replacement for a client polling every /<pillar>/me route in
//          parallel and treating a 404 as "not created": this checks every
//          PROFILE_MODEL_REGISTRY entry at once and reports null for the
//          ones that don't exist.
// @route   GET /api/users/me/profiles
// @access  Private
export const getMyProfiles = asyncHandler(async (req: Request, res: Response) => {
  const requester = req.user as IUser;

  const entries = await Promise.all(
    (Object.entries(PROFILE_MODEL_REGISTRY) as [ProfileType, (typeof PROFILE_MODEL_REGISTRY)[ProfileType]][]).map(
      async ([profileType, Model]) => {
        const profile = await Model.findOne({ userId: requester._id }).select("isVerified status slug");

        if (!profile) return [profileType, null] as const;

        return [
          profileType,
          {
            id: profile.id,
            isVerified: profile.isVerified,
            status: profile.status,
            slug: profile.slug,
          },
        ] as const;
      },
    ),
  );

  res.status(200).json(Object.fromEntries(entries));
});

// @desc    Update the logged-in user's profile
// @route   PUT /api/users/profile
// @access  Private
export const updateUserProfile = asyncHandler(async (req: Request, res: Response) => {
  const user = await User.findById((req.user as IUser).id);

  if (!user) {
    res.status(404);
    throw new Error("User not found");
  }

  const { fullName, phoneNumber, password, oldPassword } = req.body;

  if (password) {
    if (!oldPassword) {
      res.status(400);
      throw new Error("Old password is required to update password");
    }

    const isMatch = await bcrypt.compare(oldPassword, user.password);
    if (!isMatch) {
      res.status(400);
      throw new Error("Old password is incorrect");
    }

    const salt = await bcrypt.genSalt(10);
    user.password = await bcrypt.hash(password, salt);

    // Invalidate every previously issued token.
    user.sessionId = crypto.randomUUID();
  }

  if (fullName) user.fullName = fullName;
  if (phoneNumber) user.phoneNumber = phoneNumber;

  // An avatar is one optional field on a form that's mostly about other
  // things — a bad/missing image must never fail the whole profile update.
  // uploadHandler already never throws; it just reports what it couldn't
  // save in errorLogs, which we surface as a soft warning instead of an
  // error response. Same reasoning for more than one source at once
  // (a file, base64, *and* url all attached) — rather than let
  // uploadHandler save every one of them and only keep the first
  // (silently orphaning the rest on disk, same bug
  // jobController.uploadContract had), this skips the upload
  // entirely and surfaces it as a warning instead.
  const candidateCount = countUploadCandidates(req);
  let avatarWarnings: string[] = [];

  if (candidateCount > 1) {
    avatarWarnings = ["Attach exactly one avatar image — no image was saved"];
  } else if (candidateCount === 1) {
    const { results, errorLogs } = await uploadHandler({
      req,
      visibility: FILE_VISIBILITY.PUBLIC, // avatars are always public
      allowedMimeTypes: IMAGE_ONLY_MIME_TYPES,
    });

    if (results.length > 0) {
      if (user.avatar?.storagePath) {
        await deleteStoredFile(user.avatar.storagePath);
      }

      const saved = results[0];
      user.avatar = {
        fileName: saved.fileName,
        storagePath: saved.storagePath,
        mime: saved.mime,
        size: saved.size,
        url: saved.url,
      };
    }

    avatarWarnings = errorLogs;
  }

  await user.save();

  res.json({
    message: "Profile updated successfully",
    user: toPublicUser(user),
    ...(avatarWarnings.length > 0 ? { avatarWarnings } : {}),
  });
});

// @desc    Switch (or explicitly set) the caller's active persona
// @route   PATCH /api/users/account-type
// @access  Private
export const toggleAccountType = asyncHandler(async (req: Request, res: Response) => {
  const user = await User.findById((req.user as IUser).id);

  if (!user) {
    res.status(404);
    throw new Error("User not found");
  }

  const { activeAccountType } = req.body;

  user.activeAccountType = activeAccountType
    ? activeAccountType
    : user.activeAccountType === ACCOUNT_TYPE.NORMAL
      ? ACCOUNT_TYPE.BUSINESS
      : ACCOUNT_TYPE.NORMAL;

  await user.save();

  res.json({
    message: "Active account type updated",
    activeAccountType: user.activeAccountType,
  });
});

// @desc    Set/replace where my verified refunds/payouts actually get
//          sent. Gated behind verifyIdentityMiddleware (current password,
//          or a 2FA code once that's ever enabled) — see jobController's
//          approveRefundRequest/approvePayoutRequest, which snapshot
//          whatever's on file here onto a SystemPayout record at approval
//          time, not a live reference, so a later change here never
//          silently redirects an already-approved payout.
// @route   PUT /api/users/payout-account
// @access  Private
export const updatePayoutAccount = asyncHandler(async (req: Request, res: Response) => {
  const user = await User.findById((req.user as IUser).id);

  if (!user) {
    res.status(404);
    throw new Error("User not found");
  }

  const { accountName, accountNumber, bankName, bankCode, country } = req.body;

  user.payoutAccount = { accountName, accountNumber, bankName, bankCode, country };
  await user.save();

  res.status(200).json({ payoutAccount: user.payoutAccount });
});

// @desc    Start (or restart) 2FA enrollment — generates a fresh TOTP
//          secret and a scannable QR code, but doesn't enable anything
//          yet; that only happens once verifyTwoFactor confirms the
//          caller actually has it loaded into an authenticator app.
//          Gated behind verifyIdentityMiddleware: if 2FA is already
//          enabled, restarting setup (which would overwrite the current
//          secret) requires a valid code from the *existing*
//          authenticator, not just a bearer token — otherwise a stolen
//          session could silently swap in an attacker's own secret.
// @route   POST /api/users/2fa/setup
// @access  Private
export const setupTwoFactor = asyncHandler(async (req: Request, res: Response) => {
  const user = await User.findById((req.user as IUser).id);

  if (!user) {
    res.status(404);
    throw new Error("User not found");
  }

  const tempSecret = authenticator.generateSecret();
  const otpauth = authenticator.keyuri(user.email, process.env.APP_NAME as string, tempSecret);
  const qrCodeDataURL = await qrcode.toDataURL(otpauth);

  user.user2fa = { enable: false, tempSecret };
  await user.save();

  res.status(200).json({ tempSecret, otpauth, qrCodeDataURL });
});

// @desc    Confirm 2FA enrollment — a 6-digit code from whatever
//          authenticator app just scanned setupTwoFactor's QR code,
//          checked against the *temporary* secret that set. Success is
//          what actually flips user2fa.enable on and promotes
//          tempSecret to the permanent secret; nothing before this point
//          ever enabled 2FA, no matter how setup went.
// @route   POST /api/users/2fa/verify
// @access  Private
export const verifyTwoFactor = asyncHandler(async (req: Request, res: Response) => {
  const user = await User.findById((req.user as IUser).id);

  if (!user) {
    res.status(404);
    throw new Error("User not found");
  }

  const { token } = req.body;

  if (!user.user2fa?.tempSecret) {
    res.status(400);
    throw new Error("Start 2FA setup first");
  }

  const isValid = authenticator.verify({ token, secret: user.user2fa.tempSecret });

  if (!isValid) {
    res.status(400);
    throw new Error("Invalid authentication code");
  }

  user.user2fa = { enable: true, secret: user.user2fa.tempSecret };
  await user.save();

  res.status(200).json({ user2fa: { enable: true } });
});

// @desc    Turn 2FA on (re-enable, using the secret a previous setup
//          already confirmed — no fresh enrollment needed) or off.
//          Gated behind verifyIdentityMiddleware either way: turning it
//          off needs a valid code from the authenticator being removed,
//          not just a bearer token; turning it back on needs the
//          current password, same as any other sensitive change while
//          2FA is off.
// @route   PUT /api/users/2fa/toggle
// @access  Private
export const toggleTwoFactor = asyncHandler(async (req: Request, res: Response) => {
  const user = await User.findById((req.user as IUser).id);

  if (!user) {
    res.status(404);
    throw new Error("User not found");
  }

  const { enable } = req.body;

  if (enable) {
    if (user.user2fa?.enable) {
      res.status(400);
      throw new Error("2FA is already enabled");
    }

    if (!user.user2fa?.secret) {
      res.status(400);
      throw new Error("Please complete 2FA setup first");
    }

    // A full reassignment, not `user.user2fa.enable = true` — `user2fa`
    // is a loosely-typed `Object` field (see userModel.ts's IUser2fa
    // comment), and Mongoose only detects a *whole-field* reassignment on
    // one of those as a change, not a mutation of one of its properties
    // in place; the latter would silently never get saved.
    user.user2fa = { ...user.user2fa, enable: true };
  } else {
    if (!user.user2fa?.enable) {
      res.status(400);
      throw new Error("2FA is already disabled");
    }

    user.user2fa = { ...user.user2fa, enable: false };
  }

  await user.save();

  res.status(200).json({ user2fa: { enable: user.user2fa.enable } });
});

// @desc    Invalidate every session for the logged-in user
// @route   PATCH /api/users/invalidate
// @access  Private
export const logoutAll = asyncHandler(async (req: Request, res: Response) => {
  const user = await User.findById((req.user as IUser).id);

  if (!user) {
    res.status(404);
    throw new Error("User not found");
  }

  user.sessionId = crypto.randomUUID();
  await user.save();

  res.json({ message: "Logged out from all devices" });
});

// @desc    Request a password reset
// @route   POST /api/users/request-reset
// @access  Public
export const requestReset = asyncHandler(async (req: Request, res: Response) => {
  const { email } = req.body;

  const user = await User.findOne({ email: String(email).toLowerCase().trim() });

  const genericResponse = {
    message:
      "If an account exists with that email, a password reset link has been sent.",
  };

  // Never reveal whether the account exists.
  if (!user) {
    res.status(200).json(genericResponse);
    return;
  }

  const existingToken = user.tokenCache?.get(TOKENS.RESET);

  let code: string;
  let expiresAt: Date;

  if (existingToken && existingToken.expiresAt > new Date()) {
    code = existingToken.code;
    expiresAt = existingToken.expiresAt;
  } else {
    code = crypto.randomUUID();
    expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    user.tokenCache.set(TOKENS.RESET, { code, expiresAt });
    await user.save();
  }

  const token = jwt.sign(
    { email: user.email, code },
    process.env.JWT_EMAIL_SECRET as string,
    { expiresIn: "10m" },
  );

  const resetUrl = `${process.env.FRONTEND_URL}/reset-password/${token}`;

  await sendTemplatedEmail({
    to: user.email,
    subject: "Reset Your Password",
    template: "forgotPassword",
    variables: { name: user.fullName, resetUrl, expiresIn: "10 minutes" },
  });

  // Still included outside production — lets the flow be exercised
  // end-to-end without real Mailgun credentials configured locally.
  res.status(200).json(
    process.env.NODE_ENV === "production"
      ? genericResponse
      : { ...genericResponse, resetUrl, token },
  );
});

// @desc    Reset a password using a reset token
// @route   POST /api/users/reset-password
// @access  Public
export const resetPassword = asyncHandler(async (req: Request, res: Response) => {
  const { token, password } = req.body;

  let decoded: { email: string; code: string };

  try {
    decoded = jwt.verify(token, process.env.JWT_EMAIL_SECRET as string) as {
      email: string;
      code: string;
    };
  } catch {
    res.status(400);
    throw new Error("Invalid or expired reset token");
  }

  const user = await User.findOne({ email: decoded.email });

  if (!user) {
    res.status(400);
    throw new Error("Invalid or expired reset token");
  }

  const resetToken = user.tokenCache?.get(TOKENS.RESET);

  if (!resetToken || resetToken.code !== decoded.code) {
    res.status(400);
    throw new Error("Invalid or expired reset token");
  }

  if (resetToken.expiresAt < new Date()) {
    user.tokenCache.delete(TOKENS.RESET);
    await user.save();

    res.status(400);
    throw new Error("Reset token has expired");
  }

  const salt = await bcrypt.genSalt(10);
  user.password = await bcrypt.hash(password, salt);
  user.sessionId = crypto.randomUUID();
  user.tokenCache.delete(TOKENS.RESET);

  await user.save();

  res.status(200).json({ message: "Password reset successfully" });
});

// @desc    Register a new admin
// @route   POST /api/users/admin-create
// @access  Private (Super Admin only)
export const registerAdmin = asyncHandler(async (req: Request, res: Response) => {
  const { fullName, email, password } = req.body;

  const userExists = await User.findOne({ email });
  if (userExists) {
    res.status(400);
    throw new Error("User already exists");
  }

  const salt = await bcrypt.genSalt(10);
  const hashedPassword = await bcrypt.hash(password, salt);

  const admin = new User({
    fullName,
    email,
    password: hashedPassword,
    verified: true,
    systemRole: SYSTEM_ROLE.ADMIN,
  });

  admin._adminCreation = true; // internal flag, never persisted

  await admin.save();

  res.status(201).json(toPublicUser(admin));
});

// @desc    List users (filterable, paginated) — the read side is
//          Admin/Super Admin (any mutation on a user, role/account-status
//          changes, stays Super-Admin-only, same as before); an admin
//          needs this to find a userId before e.g. POST /api/subscriptions.
// @route   GET /api/users?systemRole=&userId=&q=
// @access  Private (Admin / Super Admin)
export const getUsers = asyncHandler(async (req: Request, res: Response) => {
  const page = Math.max(Number(req.query.page) || 1, 1);
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  const skip = (page - 1) * limit;

  const { systemRole, userId, q } = req.query as {
    systemRole?: string;
    userId?: string;
    q?: string;
  };

  const filter: mongoose.FilterQuery<IUser> = {};
  const validRoles: string[] = Object.values(SYSTEM_ROLE);

  if (systemRole && validRoles.includes(systemRole)) {
    filter.systemRole = systemRole as IUser["systemRole"];
  }

  if (userId && mongoose.Types.ObjectId.isValid(userId)) {
    filter._id = userId;
  }

  if (q && q.trim()) {
    // Regex, not text search — this product has no $text index on User,
    // and a prefix/substring match on a handful of hundred admin-facing
    // rows doesn't need one. Escaped so a stray regex metacharacter in
    // someone's search box (or email) can't throw or behave unexpectedly.
    const escaped = q.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(escaped, "i");
    filter.$or = [{ email: pattern }, { fullName: pattern }];
  }

  const [users, total] = await Promise.all([
    User.find(filter)
      .select("-password -tokenCache -user2fa")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    User.countDocuments(filter),
  ]);

  res.status(200).json({
    data: users,
    pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
  });
});

// @desc    Change a user's system role
// @route   PATCH /api/users/:id/role
// @access  Private (Super Admin only)
export const changeUserRole = asyncHandler(async (req: Request, res: Response) => {
  const id = req.params.id as string;
  const { systemRole } = req.body;
  const requester = req.user as IUser;

  // id is a route param, not a body field — validateBody can't see it,
  // so this one stays a plain inline check.
  if (!mongoose.Types.ObjectId.isValid(id)) {
    res.status(400);
    throw new Error("Invalid user id");
  }

  const user = await User.findById(id);

  if (!user) {
    res.status(404);
    throw new Error("User not found");
  }

  if (user._id.toString() === requester._id.toString()) {
    res.status(400);
    throw new Error("You cannot change your own role");
  }

  if (user.systemRole === SYSTEM_ROLE.SUPER_ADMIN) {
    res.status(400);
    throw new Error("Cannot modify the Super Admin role");
  }

  user.systemRole = systemRole;

  if (
    systemRole === SYSTEM_ROLE.ADMIN ||
    systemRole === SYSTEM_ROLE.SUPER_ADMIN ||
    systemRole === SYSTEM_ROLE.CUSTOMER_CARE
  ) {
    user._adminCreation = true;
  }

  await user.save();

  res.status(200).json({
    message: "User role updated successfully",
    user: { id: user._id, email: user.email, systemRole: user.systemRole },
  });
});

// @desc    Suspend or reinstate a user's account — a platform-wide kill
//          switch, independent of any one business profile's own status
//          (constants/profileStatus.ts, which only hides that profile).
//          Enforced in authMiddleware.getAuthenticatedUser, so it takes
//          effect on the very next request. Same self/Super-Admin guards
//          as changeUserRole above.
// @route   PATCH /api/users/:id/account-status
// @access  Private (Super Admin only)
export const setAccountStatus = asyncHandler(async (req: Request, res: Response) => {
  const id = req.params.id as string;
  const { accountStatus } = req.body;
  const requester = req.user as IUser;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    res.status(400);
    throw new Error("Invalid user id");
  }

  const user = await User.findById(id);

  if (!user) {
    res.status(404);
    throw new Error("User not found");
  }

  if (user._id.toString() === requester._id.toString()) {
    res.status(400);
    throw new Error("You cannot suspend your own account");
  }

  if (user.systemRole === SYSTEM_ROLE.SUPER_ADMIN) {
    res.status(400);
    throw new Error("Cannot suspend the Super Admin");
  }

  user.accountStatus = accountStatus;
  await user.save();

  res.status(200).json({
    message: "Account status updated successfully",
    user: { id: user._id, email: user.email, accountStatus: user.accountStatus },
  });
});
