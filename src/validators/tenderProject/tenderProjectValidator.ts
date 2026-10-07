import * as yup from "yup";
import { TENDER_CATEGORY } from "../../models/tenderProjectModel";
import { optionalTrimmedString } from "../common";
import { objectIdString } from "../objectId";

// req.files counts/caps, ownership, state-machine (open/awarded/
// cancelled), eligibility (verified+subscribed contractor/client
// profile), and the sealed-bidding checks all stay in
// tenderProjectController.ts exactly where they were — none of that is
// expressible before the project/bid is even loaded. Only the shape
// layer moved here.

// Country/state format (ISO alpha-2, state-valid-for-country) is already
// enforced once, at the Mongoose schema level (tenderProjectModel.ts's
// own `projectLocationSchema`) — not duplicated here.
const locationSchema = yup.object({
  country: yup.string().trim().required("location.country is required"),
  state: optionalTrimmedString(),
});

export const createTenderProjectSchema = yup
  .object({
    title: yup.string().trim().required("title is required"),
    description: yup.string().trim().required("description is required"),
    category: yup
      .string()
      .oneOf(Object.values(TENDER_CATEGORY), "Please add a valid category")
      .required("Please add a valid category"),
    budgetMin: yup.number().min(0).notRequired(),
    budgetMax: yup.number().min(0).notRequired(),
    currency: optionalTrimmedString(),
    location: locationSchema.required("location is required"),
    // `.min(new Date(), ...)` would freeze "now" at schema-construction
    // time (module load), not at request time — a `.test()` re-evaluates
    // `new Date()` on every validation call instead.
    bidDeadline: yup
      .date()
      .test("is-future", "bidDeadline must be a date in the future", (value) => !value || value > new Date())
      .required("bidDeadline must be a date in the future"),
  })
  .noUnknown(true);

// A partial update — every field optional. `location`/`bidDeadline` need
// `.default(undefined)` the same reason phoneNumber does in
// userValidator.ts: yup casts a genuinely-missing nested object to {}
// otherwise, which would make location.country's own "required" fire
// even when the caller never touched location at all.
export const updateTenderProjectSchema = yup
  .object({
    title: yup.string().trim().notRequired(),
    description: yup.string().trim().notRequired(),
    category: yup.string().oneOf(Object.values(TENDER_CATEGORY), "Please add a valid category").notRequired(),
    budgetMin: yup.number().min(0).notRequired(),
    budgetMax: yup.number().min(0).notRequired(),
    currency: optionalTrimmedString(),
    location: locationSchema.default(undefined).notRequired(),
    bidDeadline: yup
      .date()
      .test("is-future", "bidDeadline must be a date in the future", (value) => !value || value > new Date())
      .default(undefined)
      .notRequired(),
  })
  .noUnknown(true);

export const submitBidSchema = yup
  .object({
    amount: yup.number().moreThan(0, "A positive amount is required").required("A positive amount is required"),
    currency: optionalTrimmedString(),
    proposal: yup.string().trim().required("Please add a proposal"),
    estimatedDurationDays: yup.number().min(1).notRequired(),
  })
  .noUnknown(true);

export const updateMyBidSchema = yup
  .object({
    amount: yup.number().moreThan(0, "A positive amount is required").notRequired(),
    currency: optionalTrimmedString(),
    proposal: yup.string().trim().notRequired(),
    estimatedDurationDays: yup.number().min(1).notRequired(),
  })
  .noUnknown(true);

export const awardBidSchema = yup
  .object({
    bidId: objectIdString("A valid bidId is required").required("A valid bidId is required"),
  })
  .noUnknown(true);
