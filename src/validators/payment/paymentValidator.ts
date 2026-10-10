import * as yup from "yup";
import { PAYMENT_TARGET_TYPE } from "../../models/paymentModel";
import { objectIdString } from "../objectId";

// DB lookups (job/plan/product existence, ownership, status-machine
// checks, duplicate-purchase checks) all stay in paymentController.ts —
// only the per-targetType body shape moved here. `targetType` drives
// which of targetId/amount/planTier are actually required, mirroring
// the three handleXPaymentIntent branches in the controller exactly.
export const createPaymentIntentSchema = yup
  .object({
    targetType: yup
      .string()
      .oneOf(Object.values(PAYMENT_TARGET_TYPE), "targetType must be 'Job', 'Subscription', or 'DigitalPurchase'")
      .required("targetType must be 'Job', 'Subscription', or 'DigitalPurchase'"),
    targetId: yup.string().when("targetType", {
      is: (value: string) => value === PAYMENT_TARGET_TYPE.JOB || value === PAYMENT_TARGET_TYPE.DIGITAL_PURCHASE,
      then: () => objectIdString("Please add a valid targetId").required("Please add a valid targetId"),
      otherwise: (schema) => schema.notRequired(),
    }),
    amount: yup.number().when("targetType", {
      is: PAYMENT_TARGET_TYPE.JOB,
      then: (schema) => schema.moreThan(0, "Please add a valid targetId and a positive amount").required("Please add a valid targetId and a positive amount"),
      otherwise: (schema) => schema.notRequired(),
    }),
    planTier: yup.string().when("targetType", {
      is: PAYMENT_TARGET_TYPE.SUBSCRIPTION,
      then: (schema) => schema.required("Please add a planTier"),
      otherwise: (schema) => schema.notRequired(),
    }),
    autoRenew: yup.boolean().notRequired(),
  })
  .noUnknown(true);
