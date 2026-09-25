import { AnySchema, ValidationError } from "yup";
import asyncHandler from "express-async-handler";
import { Request, Response, NextFunction } from "express";
import { AppError } from "../middleware/errorMiddleware";

// First validation layer for a request body — yup checks shape/type/
// required-ness and casts values (e.g. a numeric string field becomes a
// real number), and strips any key the schema doesn't declare. What yup
// can't express — cross-field business rules, DB lookups, ownership checks
// — still lives in the controller afterward; this only ever replaces that
// second layer, never the whole thing.
//
// `abortEarly: false` collects every failing field at once instead of just
// the first, which is what a frontend form actually needs to show inline
// errors instead of a single generic message.
export const validateBody = (schema: AnySchema) =>
  asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
    try {
      req.body = await schema.validate(req.body, {
        abortEarly: false,
        stripUnknown: true,
      });
      next();
    } catch (error) {
      if (error instanceof ValidationError) {
        const err: AppError = new Error(error.errors.join(", "));
        err.statusCode = 400;
        throw err;
      }
      throw error;
    }
  });
