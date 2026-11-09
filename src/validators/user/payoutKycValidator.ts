import * as yup from "yup";

// submitPayoutKyc's body shape branches on the caller's own country
// (automated: idType/idNumber as plain fields; document: multipart
// files, no other fields) — same reasoning as
// verificationValidator.ts's own comment on submitVerification: no
// single static shape to run validateBody against, so those checks live
// inline in the controller instead. rejectPayoutKyc is a plain JSON
// body, so it keeps using validateBody.
export const rejectPayoutKycSchema = yup
  .object({
    rejectionReason: yup.string().trim().required("A rejection reason is required"),
  })
  .noUnknown(true);
