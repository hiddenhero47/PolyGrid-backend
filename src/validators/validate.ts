import { AnySchema, ValidationError } from "yup";
import asyncHandler from "express-async-handler";
import { Request, Response, NextFunction } from "express";
import { AppError } from "../middleware/errorMiddleware";

// First validation layer for a request body — yup checks shape/type/
// required-ness and casts values (e.g. a numeric string field becomes a
// real number), and strips any key the schema doesn't declare. What yup
// can't express — cross-field business rules, DB lookups, ownership checks,
// req.files counts/caps — still lives in the controller afterward; this
// only ever replaces that second layer, never the whole thing.
//
// `abortEarly: false` collects every failing field at once instead of just
// the first, which is what a frontend form actually needs to show inline
// errors instead of a single generic message.
//
// Multipart/form-data has no way to carry a nested object as an ordinary
// field (see helpers/parseMultipartData.ts) — the client bundles every
// non-file field into one JSON-stringified `data` field instead, attached
// alongside the real file parts. This middleware detects that exact shape
// (a string `data` field — the same signal parseMultipartData itself
// checks for) and validates *that* parsed object instead of req.body
// directly, so a multipart route's schema reads identically to a JSON
// route's. A controller downstream never needs to know or care which
// transport the request used, and never calls parseMultipartData again
// once its route has a schema here.
//
// `base64`/`url` (helpers/fileStorage.ts's uploadHandler reading an
// upload from a data URI or a remote URL instead of a real file
// attachment) are siblings of `data` at the top level of req.body, never
// inside the JSON `data` blob itself — parseMultipartData never read them
// either, it only ever touched `.data`. They're deliberately re-attached
// below rather than run through the schema: they're not part of the
// shape being validated, just a second way of supplying a file, so
// stripping them the way an actually-unknown field gets stripped would
// silently break uploading via URL/base64 on every multipart route.
//
// Gotcha worth knowing before writing a schema with an *optional* nested
// yup.object({...}) field (a location, a phone number, anything shaped
// like {a, b}): yup's own casting quietly turns a genuinely *missing* key
// into {} instead of leaving it undefined, which silently breaks a
// .test() that expects to see undefined when the caller never sent the
// field at all. Add .default(undefined) to that nested schema to keep it
// actually undefined when absent - see validators/user/userValidator.ts's
// phoneNumber field for the pattern.
//
// Second gotcha, same stripUnknown option: a bare `yup.object()` field
// with no declared shape (used to deliberately pass a nested value
// through untouched, trusting some other layer — e.g. Mongoose — to
// validate it) still counts as shape `{}` for stripUnknown's purposes,
// so every key inside it gets silently stripped as "unknown". Use
// `yup.mixed()` instead for a field that should pass through as-is —
// see validators/consultancyProfile/consultancyProfileValidator.ts's
// `mentorship` field for the pattern.
export const validateBody = (schema: AnySchema) =>
  asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
    const isMultipart = typeof req.body?.data === "string";
    let input: unknown = req.body;

    if (isMultipart) {
      try {
        input = JSON.parse(req.body.data);
      } catch {
        const err: AppError = new Error("Invalid JSON format in 'data' field.");
        err.statusCode = 400;
        throw err;
      }
    }

    try {
      const validated = await schema.validate(input, {
        abortEarly: false,
        stripUnknown: true,
      });

      req.body = isMultipart
        ? { ...validated, base64: req.body.base64, url: req.body.url }
        : validated;
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
