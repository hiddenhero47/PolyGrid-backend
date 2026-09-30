import jwt from "jsonwebtoken";
import asyncHandler from "express-async-handler";
import { Request, Response, NextFunction } from "express";
import { User, IUser, SystemRole } from "../models/userModel";
import { Subscription, ISubscription } from "../models/subscriptionModel";
import { AppError } from "./errorMiddleware";

interface TokenPayload {
  id: string;
  sessionId: string;
}

// Exported so the Socket.IO auth handshake (src/socket/index.ts) verifies
// a connecting client's token exactly the same way every HTTP request
// does — one place decides what a valid token/session is, not two.
export const getAuthenticatedUser = async (token: string): Promise<IUser> => {
  const decoded = jwt.verify(token, process.env.JWT_SECRET as string) as TokenPayload;

  const user = await User.findById(decoded.id);

  if (!user) {
    throw new Error("USER_NOT_FOUND");
  }

  // Session validation — lets password changes/logout-all invalidate every
  // previously issued token by rotating sessionId.
  if (decoded.sessionId !== user.sessionId) {
    throw new Error("SESSION_INVALID");
  }

  return user;
};

const handleAuthError = (error: unknown, res: Response): never => {
  console.error(error);

  res.status(401);

  const err = error as Error;

  if (err.name === "TokenExpiredError") {
    throw new Error("Session expired. Please login again.");
  }

  if (err.message === "SESSION_INVALID") {
    throw new Error("Session expired. Please login again.");
  }

  if (err.message === "USER_NOT_FOUND") {
    throw new Error("User not authorized");
  }

  throw new Error("Not authorized");
};

const extractBearerToken = (req: Request): string | undefined => {
  const header = req.headers.authorization;

  if (header && header.startsWith("Bearer")) {
    return header.split(" ")[1];
  }

  return undefined;
};

export const protect = asyncHandler(
  async (req: Request, res: Response, next: NextFunction) => {
    const token = extractBearerToken(req);

    if (!token) {
      res.status(401);
      throw new Error("Not authorized, no token!");
    }

    try {
      req.user = await getAuthenticatedUser(token);
      next();
    } catch (error) {
      handleAuthError(error, res);
    }
  },
);

export const secureRole = (roles: SystemRole | SystemRole[]) =>
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const token = extractBearerToken(req);

    if (!token) {
      res.status(401);
      throw new Error("Not authorized, no token!");
    }

    try {
      const user = await getAuthenticatedUser(token);
      const allowedRoles = Array.isArray(roles) ? roles : [roles];

      if (!allowedRoles.includes(user.systemRole)) {
        res.status(401);
        throw new Error("Not authorized");
      }

      req.user = user;
      next();
    } catch (error) {
      handleAuthError(error, res);
    }
  });

const loadCurrentPlan = async (user: IUser): Promise<ISubscription | null> => {
  if (!user.currentSubscription) return null;

  return Subscription.findById(user.currentSubscription);
};

// Populates req.currentPlan with the caller's current Subscription record
// (or null if they've never subscribed) without blocking the request either
// way. Must run after `protect`. Use this on routes that want to know about
// the caller's plan without gating access on it (e.g. showing an "upgrade"
// prompt instead of a hard 402).
export const attachCurrentPlan = asyncHandler(
  async (req: Request, _res: Response, next: NextFunction) => {
    req.currentPlan = await loadCurrentPlan(req.user as IUser);
    next();
  },
);

// Gate for routes belonging to a business pillar (Engineering, Tenders,
// Store, SiteForce) — the PolyGrid membership model is one global
// subscription on the base User, not per-pillar. Must run after `protect`.
// Populates req.currentPlan itself if `attachCurrentPlan` hasn't already run.
export const requireActiveSubscription = asyncHandler(
  async (req: Request, _res: Response, next: NextFunction) => {
    if (req.currentPlan === undefined) {
      req.currentPlan = await loadCurrentPlan(req.user as IUser);
    }

    if (!req.currentPlan || !req.currentPlan.isActive()) {
      const error: AppError = new Error(
        "An active PolyGrid subscription is required for this action",
      );
      error.statusCode = 402;
      throw error;
    }

    next();
  },
);
