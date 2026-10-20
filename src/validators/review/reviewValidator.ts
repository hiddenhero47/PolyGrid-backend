import * as yup from "yup";
import { REVIEW_SOURCE_TYPE } from "../../models/reviewModel";
import { objectIdString } from "../objectId";

// DB lookups (the job/purchase itself, which party the requester was,
// profile resolution, the completed/success status checks, the
// already-reviewed check) all stay in reviewController.ts — only the
// shape layer moved here.
export const createReviewSchema = yup
  .object({
    sourceType: yup
      .string()
      .oneOf(Object.values(REVIEW_SOURCE_TYPE), "sourceType must be 'Job' or 'DigitalPurchase'")
      .required("sourceType must be 'Job' or 'DigitalPurchase'"),
    sourceId: objectIdString("A valid sourceId is required").required("A valid sourceId is required"),
    rating: yup
      .number()
      .min(1, "rating must be between 1 and 5")
      .max(5, "rating must be between 1 and 5")
      .required("rating must be between 1 and 5"),
    comment: yup.string().trim().notRequired(),
  })
  .noUnknown(true);

export const hideReviewSchema = yup
  .object({ reason: yup.string().trim().notRequired() })
  .noUnknown(true);
