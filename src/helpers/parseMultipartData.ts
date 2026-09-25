import { Request } from "express";
import { AppError } from "../middleware/errorMiddleware";

// Multipart/form-data has no way to carry a nested object or array as an
// ordinary field — multer doesn't reconstruct bracket-notation nesting the
// way body-parser does for urlencoded bodies. Mirrors house-maduekwe-
// backend's shopItemHelper.parseMultipartData (see shopItemController's
// create/update item routes): the client bundles every non-file field into
// one JSON-stringified `data` field, sent alongside the real file
// attachments, and this unpacks it back into a normal object. A malformed
// `data` field is a 400, not a crash.
export const parseMultipartData = <T = Record<string, unknown>>(req: Request): T => {
  if (!req.body?.data) return {} as T;

  try {
    return JSON.parse(req.body.data) as T;
  } catch {
    const error: AppError = new Error("Invalid JSON format in 'data' field.");
    error.statusCode = 400;
    throw error;
  }
};
