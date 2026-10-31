import * as yup from "yup";

// transferReference is optional — no automated payout rail exists yet,
// so whoever made the transfer by hand may or may not have a reference
// number to attach (see systemPayoutModel.ts's own comment).
export const markSystemPayoutPaidSchema = yup
  .object({
    transferReference: yup.string().trim().notRequired(),
  })
  .noUnknown(true);

// Same "never just a flipped flag, always say why" instinct
// declineRefundRequestSchema/declinePayoutRequestSchema already use.
export const markSystemPayoutFailedSchema = yup
  .object({
    failureReason: yup.string().trim().required("A failure reason is required"),
  })
  .noUnknown(true);
