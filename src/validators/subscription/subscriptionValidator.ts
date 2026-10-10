import * as yup from "yup";
import { objectIdString } from "../objectId";

// User/plan existence (DB lookups) stay in subscriptionController.ts —
// only the shape layer moved here.
export const grantSubscriptionSchema = yup
  .object({
    userId: objectIdString("Invalid user id").required("Please add userId and planTier"),
    planTier: yup.string().trim().required("Please add userId and planTier"),
    paymentProviderId: yup.string().trim().notRequired(),
    paymentId: yup.string().trim().notRequired(),
    autoRenew: yup.boolean().notRequired(),
  })
  .noUnknown(true);
