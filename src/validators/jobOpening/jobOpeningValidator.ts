import * as yup from "yup";
import { PAY_TYPE, EMPLOYMENT_TYPE } from "../../models/jobOpeningModel";
import { LABOR_SKILL } from "../../models/laborProfileModel";
import { optionalTrimmedString } from "../common";

// Eligibility (subscribed client profile / verified worker profile),
// req.files counts/caps, ownership, and the opening/application
// state-machine checks all stay in jobOpeningController.ts — none of
// that is expressible before the opening/application is even loaded.
// Only the shape layer moved here.

// Country/state format is already enforced once, at the Mongoose
// schema level (jobOpeningModel.ts's own generalAreaSchema) — not
// duplicated here.
const generalAreaSchema = yup.object({
  country: yup.string().trim().required("generalArea.country is required"),
  state: optionalTrimmedString(),
  city: optionalTrimmedString(),
});

const coordinatesSchema = yup.object({
  lat: yup.number().min(-90).max(90).required(),
  lng: yup.number().min(-180).max(180).required(),
});

// `.min(new Date(), ...)` would freeze "now" at schema-construction
// time (module load), not at request time — a `.test()` re-evaluates
// `new Date()` on every validation call instead. See
// tenderProjectValidator.ts's bidDeadline field for the same fix.
const futureApplicationDeadline = yup
  .date()
  .test("is-future", "applicationDeadline must be a date in the future", (value) => !value || value > new Date());

export const createJobOpeningSchema = yup
  .object({
    title: yup.string().trim().required("Please add a title, description, and generalArea.country"),
    description: yup.string().trim().required("Please add a title, description, and generalArea.country"),
    category: yup.string().oneOf(Object.values(LABOR_SKILL), "Please add a valid category").required("Please add a valid category"),
    workersNeeded: yup.number().min(1).notRequired(),
    payRate: yup.number().moreThan(0, "A positive payRate is required").required("A positive payRate is required"),
    payType: yup.string().oneOf(Object.values(PAY_TYPE), "Please add a valid payType").required("Please add a valid payType"),
    currency: optionalTrimmedString(),
    employmentType: yup
      .string()
      .oneOf(Object.values(EMPLOYMENT_TYPE), "Please add a valid employmentType")
      .required("Please add a valid employmentType"),
    generalArea: generalAreaSchema.required("Please add a title, description, and generalArea.country"),
    coordinates: coordinatesSchema.default(undefined).notRequired(),
    address: optionalTrimmedString(),
    googleMapsUrl: optionalTrimmedString(),
    contactInfo: optionalTrimmedString(),
    applicationDeadline: futureApplicationDeadline.notRequired(),
  })
  .noUnknown(true);

// A partial update — every field optional. `generalArea`/`coordinates`
// need `.default(undefined)` for the same reason phoneNumber does in
// userValidator.ts: yup casts a genuinely-missing nested object to {}
// otherwise, which would make generalArea.country's own "required"
// fire even when the caller never touched generalArea at all.
export const updateJobOpeningSchema = yup
  .object({
    title: yup.string().trim().notRequired(),
    description: yup.string().trim().notRequired(),
    category: yup.string().oneOf(Object.values(LABOR_SKILL), "Please add a valid category").notRequired(),
    workersNeeded: yup.number().min(1).notRequired(),
    payRate: yup.number().moreThan(0, "A positive payRate is required").notRequired(),
    payType: yup.string().oneOf(Object.values(PAY_TYPE), "Please add a valid payType").notRequired(),
    currency: optionalTrimmedString(),
    employmentType: yup.string().oneOf(Object.values(EMPLOYMENT_TYPE), "Please add a valid employmentType").notRequired(),
    generalArea: generalAreaSchema.default(undefined).notRequired(),
    coordinates: coordinatesSchema.default(undefined).notRequired(),
    address: optionalTrimmedString(),
    googleMapsUrl: optionalTrimmedString(),
    contactInfo: optionalTrimmedString(),
    applicationDeadline: futureApplicationDeadline.default(undefined).notRequired(),
  })
  .noUnknown(true);

export const applyToJobOpeningSchema = yup
  .object({
    message: optionalTrimmedString(),
  })
  .noUnknown(true)
  .default({});

export const updateMyApplicationSchema = yup
  .object({
    message: yup.string().trim().notRequired(),
  })
  .noUnknown(true);
