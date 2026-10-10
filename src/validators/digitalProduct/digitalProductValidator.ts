import * as yup from "yup";
import { DIGITAL_PRODUCT_CATEGORY } from "../../models/digitalProductModel";
import { optionalTrimmedString } from "../common";

// Ownership, req.files counts/caps, and the preview-image/deliverable-
// file endpoints (no body fields of their own) all stay in
// digitalProductController.ts — only the create/update body shape moved
// here.
export const createDigitalProductSchema = yup
  .object({
    category: yup
      .string()
      .oneOf(Object.values(DIGITAL_PRODUCT_CATEGORY), "Please add a valid category")
      .required("Please add a valid category"),
    title: yup.string().trim().required("Please add a title and price"),
    description: yup.string().trim().notRequired(),
    price: yup.number().min(0).required("Please add a title and price"),
    currency: optionalTrimmedString(),
  })
  .noUnknown(true);

export const updateDigitalProductSchema = yup
  .object({
    category: yup.string().oneOf(Object.values(DIGITAL_PRODUCT_CATEGORY), "Please add a valid category").notRequired(),
    title: yup.string().trim().notRequired(),
    description: yup.string().trim().notRequired(),
    price: yup.number().min(0).notRequired(),
    currency: optionalTrimmedString(),
    isActive: yup.boolean().notRequired(),
  })
  .noUnknown(true);

// Admin/customer_care only (setDigitalProductVerification) — never part
// of the creator's own createDigitalProductSchema/updateDigitalProductSchema.
export const setDigitalProductVerificationSchema = yup
  .object({
    isVerified: yup.boolean().required("isVerified must be true or false"),
  })
  .noUnknown(true);
