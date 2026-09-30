import mongoose from "mongoose";
import { Request, Response, NextFunction } from "express";

export interface AppError extends Error {
  statusCode?: number;
  status?: number;
  code?: string;
  data?: unknown;
}

// Express only recognizes an error handler by its 4-argument arity, so
// `_req` must stay declared even though this handler doesn't use it.
export const errorHandler = (
  err: AppError,
  _req: Request,
  res: Response,
  next: NextFunction,
): void => {
  // A handler that already sent a response (e.g. paymentController's
  // stripeWebhook acks Stripe with 200 immediately, then keeps working) and
  // THEN throws can't send a second one — calling res.status/json again
  // would itself throw. Delegating to Express's built-in final handler is
  // exactly what Express's own docs recommend for this case.
  if (res.headersSent) {
    return next(err);
  }

  // A raw Mongoose ValidationError (thrown by `.save()` when a schema
  // `validate` fails — e.g. the country/state/currency reference checks
  // in countryReference.ts/currencyReference.ts, or the portfolio-item
  // limits, or expiresAt-after-periodStarted) has no `statusCode` of its
  // own, so without this it falls through to the generic 500 branch below
  // — a client-input problem reported as a server failure. Applies to
  // every schema validator across the app, not just new ones; a route
  // that wants its own cleaner message still checks before `.save()` and
  // never reaches this path.
  if (err instanceof mongoose.Error.ValidationError) {
    res.status(400).json({
      message: Object.values(err.errors)
        .map((fieldError) => fieldError.message)
        .join(", "),
      code: "VALIDATION_ERROR",
    });
    return;
  }

  const statusCode =
    err.statusCode || err.status || (res.statusCode === 200 ? 500 : res.statusCode);

  res.status(statusCode).json({
    message: err.message,
    code: err.code,
    data: err.data,
    stack: process.env.NODE_ENV === "production" ? null : err.stack,
  });
};

export const notFound = (req: Request, _res: Response, next: NextFunction): void => {
  const error: AppError = new Error(`Not Found - ${req.originalUrl}`);
  error.statusCode = 404;
  next(error);
};
