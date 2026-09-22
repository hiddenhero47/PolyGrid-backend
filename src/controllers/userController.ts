import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import asyncHandler from "express-async-handler";
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
import { uploadHandler, deleteStoredFile, FILE_VISIBILITY } from "../helpers/fileStorage";

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
});

// @desc    Register a new user
// @route   POST /api/users
// @access  Public
export const registerUser = asyncHandler(async (req: Request, res: Response) => {
  const { fullName, email, password, phoneNumber } = req.body;

  if (!fullName || !email || !password) {
    res.status(400);
    throw new Error("Please add all fields");
  }

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

  res.status(201).json({
    ...toPublicUser(user),
    token: generateToken(user),
  });
});

// @desc    Authenticate a user
// @route   POST /api/users/login
// @access  Public
export const loginUser = asyncHandler(async (req: Request, res: Response) => {
  const { email, password } = req.body;

  const user = await User.findOne({ email });

  if (!user || !(await bcrypt.compare(password, user.password))) {
    res.status(400);
    throw new Error("Invalid user credentials");
  }

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
  const { idToken } = req.body;

  if (!idToken) {
    res.status(400);
    throw new Error("idToken is required");
  }

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
  const { identityToken } = req.body;

  if (!identityToken) {
    res.status(400);
    throw new Error("identityToken is required");
  }

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

  if (phoneNumber && !phoneNumber.number && !phoneNumber.country) {
    res.status(400);
    throw new Error("Both phone number and country code are required");
  }

  if (fullName) user.fullName = fullName;
  if (phoneNumber) user.phoneNumber = phoneNumber;

  // An avatar is one optional field on a form that's mostly about other
  // things — a bad/missing image must never fail the whole profile update.
  // uploadHandler already never throws; it just reports what it couldn't
  // save in errorLogs, which we surface as a soft warning instead of an
  // error response.
  const hasIncomingFile =
    (req.files as Express.Multer.File[] | undefined)?.length || req.body?.base64 || req.body?.url;
  let avatarWarnings: string[] = [];

  if (hasIncomingFile) {
    const { results, errorLogs } = await uploadHandler({
      req,
      visibility: FILE_VISIBILITY.PUBLIC, // avatars are always public
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

  if (activeAccountType && !Object.values(ACCOUNT_TYPE).includes(activeAccountType)) {
    res.status(400);
    throw new Error("Invalid account type");
  }

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

  if (!email) {
    res.status(400);
    throw new Error("Email is required");
  }

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

  // TODO: wire up transactional email once an email provider is chosen —
  // for now the reset link/token is returned in non-production responses so
  // the flow can be exercised end-to-end without one.
  const resetUrl = `${process.env.FRONTEND_URL}/reset-password/${token}`;

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

  if (!token || !password) {
    res.status(400);
    throw new Error("Token and password are required");
  }

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

  if (!fullName || !email || !password) {
    res.status(400);
    throw new Error("Please add all fields");
  }

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

// @desc    List users (filterable, paginated)
// @route   GET /api/users
// @access  Private (Super Admin only)
export const getUsers = asyncHandler(async (req: Request, res: Response) => {
  const page = Math.max(Number(req.query.page) || 1, 1);
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  const skip = (page - 1) * limit;

  const { systemRole, userId } = req.query as {
    systemRole?: string;
    userId?: string;
  };

  const filter: mongoose.FilterQuery<IUser> = {};
  const validRoles: string[] = Object.values(SYSTEM_ROLE);

  if (systemRole && validRoles.includes(systemRole)) {
    filter.systemRole = systemRole as IUser["systemRole"];
  }

  if (userId && mongoose.Types.ObjectId.isValid(userId)) {
    filter._id = userId;
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

  if (!mongoose.Types.ObjectId.isValid(id)) {
    res.status(400);
    throw new Error("Invalid user id");
  }

  if (!Object.values(SYSTEM_ROLE).includes(systemRole)) {
    res.status(400);
    throw new Error("Invalid role");
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

  if (systemRole === SYSTEM_ROLE.ADMIN || systemRole === SYSTEM_ROLE.SUPER_ADMIN) {
    user._adminCreation = true;
  }

  await user.save();

  res.status(200).json({
    message: "User role updated successfully",
    user: { id: user._id, email: user.email, systemRole: user.systemRole },
  });
});
