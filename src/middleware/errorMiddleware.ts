import { Request, Response, NextFunction } from "express";

export interface AppError extends Error {
  statusCode?: number;
  status?: number;
  code?: string;
  data?: unknown;
}

// Express only recognizes an error handler by its 4-argument arity, so
// `_req`/`_next` must stay declared even though this handler doesn't use them.
export const errorHandler = (
  err: AppError,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void => {
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
