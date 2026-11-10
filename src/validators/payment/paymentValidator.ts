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
    // Only actually required above SystemSettings.manualReviewThresholdAmount
    // — see helpers/paymentGuardrails.ts's assertPaymentAllowed, which
    // decides that at request time, not here.
    currentPassword: yup.string().notRequired(),
    otpToken: yup.string().notRequired(),
    // Only meaningful for a Paystack-routed intent (paymentController.ts
    // builds the real callback_url by appending this to process.env.
    // FRONTEND_URL, same pattern userController.ts already uses for
    // verify-email/reset-password/Connect return links) — Stripe's own
    // adapter ignores it entirely, since Stripe.js owns the return flow
    // instead.
    //
    // Deliberately a PATH, never a full URL: a caller-supplied
    // callback_url would be a straight-up open redirect (Paystack sends
    // the buyer's browser there right after a real payment — exactly
    // where a phishing redirect would do the most damage), and
    // yup.string().url() also rejects bare "localhost" URLs outright, so
    // every dev-mode intent would 400. Building the origin server-side
    // from FRONTEND_URL and only accepting the path from the caller
    // closes both problems at once. Must start with exactly one "/" —
    // "//evil.com/x" (protocol-relative) and anything containing "://"
    // are refused, so this can never resolve to a different host no
    // matter what FRONTEND_URL is.
    callbackPath: yup
      .string()
      .test(
        "safe-relative-path",
        "callbackPath must be a relative path starting with '/' (e.g. /dashboard/payments/return/job/123), not a full URL",
        (value) => !value || (value.startsWith("/") && !value.startsWith("//") && !value.includes("://")),
      )
      .notRequired(),
  })
  .noUnknown(true);
