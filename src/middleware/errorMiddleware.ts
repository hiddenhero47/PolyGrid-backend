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
