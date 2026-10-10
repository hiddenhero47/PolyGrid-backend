import * as yup from "yup";
import { PLAN_TIER } from "../../models/planModel";
import { optionalTrimmedString } from "../common";

// The "a plan for this tier already exists" check needs a DB lookup and
// stays in planController.ts — only the shape layer moved here.
export const createPlanSchema = yup
  .object({
    planTier: yup
      .string()
      .oneOf(Object.values(PLAN_TIER), "Invalid plan tier")
      .required("Please add planTier, name, duration and price"),
    name: yup.string().trim().required("Please add planTier, name, duration and price"),
    privileges: yup.array().of(yup.string()).notRequired(),
    duration: yup.number().moreThan(0, "Please add planTier, name, duration and price").required("Please add planTier, name, duration and price"),
    maxUsers: yup.number().min(0).notRequired(),
    price: yup.number().min(0).required("Please add planTier, name, duration and price"),
    currency: optionalTrimmedString(),
  })
  .noUnknown(true);

export const updatePlanSchema = yup
  .object({
    name: yup.string().trim().notRequired(),
    privileges: yup.array().of(yup.string()).notRequired(),
    duration: yup.number().moreThan(0).notRequired(),
    maxUsers: yup.number().min(0).notRequired(),
    price: yup.number().min(0).notRequired(),
    currency: optionalTrimmedString(),
    isActive: yup.boolean().notRequired(),
  })
  .noUnknown(true);
