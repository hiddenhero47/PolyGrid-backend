import jwt from "jsonwebtoken";
import asyncHandler from "express-async-handler";
import { Request, Response, NextFunction } from "express";
import { User, IUser, SystemRole } from "../models/userModel";
import { AppError } from "./errorMiddleware";

interface TokenPayload {
  id: string;
  sessionId: string;
}

const getAuthenticatedUser = async (token: string): Promise<IUser> => {
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

// Gate for routes belonging to a business pillar (Engineering, Tenders,
// Store, SiteForce) — the PolyGrid membership model is one global
// subscription on the base User, not per-pillar. Must run after `protect`.
export const requireActiveSubscription = (
  req: Request,
  _res: Response,
  next: NextFunction,
): void => {
  const user = req.user as IUser;

  if (!user.hasActiveSubscription()) {
    const error: AppError = new Error(
      "An active PolyGrid subscription is required for this action",
    );
    error.statusCode = 402;
    throw error;
  }

  next();
};
