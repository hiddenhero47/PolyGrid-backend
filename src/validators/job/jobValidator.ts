import * as yup from "yup";
import { JOB_TYPE } from "../../models/jobModel";
import { objectIdString } from "../objectId";
import { optionalTrimmedString } from "../common";

// Only the shape/required-ness layer lives here — everything else in
// jobController.ts's ~44 `res.status(400)` checks is a state-machine or
// DB-dependent business rule (job status, ownership, who's a party,
// amounts already paid/refunded/disbursed) that can't run before the Job
// is even loaded, so it stays in the controller exactly where it was.
// This file only covers the handful that really were just "is this field
// present and the right shape."

const stageSchema = yup.object({
  details: yup.array(yup.string()).default([]),
  payment: yup.number().required(),
});

export const createJobSchema = yup
  .object({
    counterpartyUserId: objectIdString("Invalid counterparty user id").required(
      "counterpartyUserId is required",
    ),
    myRole: yup
      .string()
      .oneOf(["client", "provider"], "myRole must be 'client' or 'provider'")
      .required("myRole is required"),
    jobTitle: yup.string().trim().required("jobTitle is required"),
    jobDescription: yup.string().trim().required("jobDescription is required"),
    totalAmount: yup.number().min(0).required("totalAmount is required"),
    // An explicit "" is treated as "not provided" so Job's own schema
    // default ("USD") applies, same as the controller used to do by hand.
    currency: optionalTrimmedString(),
    jobType: yup.string().oneOf(Object.values(JOB_TYPE)).default(JOB_TYPE.OTHER),
    stages: yup.array(stageSchema).notRequired(),
  })
  .noUnknown(true);

// A partial update — every field optional, same PATCH semantics the
// controller already had (an omitted field is left untouched).
export const updateJobSchema = yup
  .object({
    jobTitle: yup.string().trim().notRequired(),
    jobDescription: yup.string().trim().notRequired(),
    jobType: yup.string().oneOf(Object.values(JOB_TYPE)).notRequired(),
    totalAmount: yup.number().min(0).notRequired(),
    stages: yup.array(stageSchema).notRequired(),
  })
  .noUnknown(true);

export const proposeStagesSchema = yup
  .object({
    stages: yup.array(stageSchema).notRequired(),
  })
  .noUnknown(true);

export const raiseDisputeSchema = yup
  .object({
    reason: yup.string().trim().required("A dispute reason is required"),
  })
  .noUnknown(true);

export const resolveDisputeSchema = yup
  .object({
    note: yup.string().trim().required("A resolution note is required"),
  })
  .noUnknown(true);

export const recordPaymentSchema = yup
  .object({
    amount: yup.number().moreThan(0, "A positive amount is required").required("amount is required"),
  })
  .noUnknown(true);

// No `amount` field — requestRefund always computes exactly what's still
// refundable itself (see jobController.ts's refundableAmount), never a
// caller-supplied number.
export const requestRefundSchema = yup
  .object({
    reason: yup.string().trim().required("A refund reason is required"),
  })
  .noUnknown(true);

export const declineRefundRequestSchema = yup
  .object({
    declineReason: yup.string().trim().required("A decline reason is required"),
  })
  .noUnknown(true);

// No `amount` field — requestPayout always computes exactly what's
// currently available itself (see jobController.ts's
// payoutAvailableAmount), never a caller-supplied number. `note` is
// optional, and the whole body itself is optional — `.default({})`
// means validateBody always hands the controller a real object either
// way, never undefined.
export const requestPayoutSchema = yup
  .object({
    note: yup.string().trim().notRequired(),
  })
  .noUnknown(true)
  .default({});

export const declinePayoutRequestSchema = yup
  .object({
    declineReason: yup.string().trim().required("A decline reason is required"),
  })
  .noUnknown(true);
