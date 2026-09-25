import * as yup from "yup";
import { TEMPLATE_FIELD_TYPE, TEMPLATE_DOCUMENT_FORMAT } from "../models/verificationTemplateModel";

const optionalTrimmed = () =>
  yup
    .string()
    .trim()
    .transform((value) => (value === "" ? undefined : value))
    .notRequired();

const templateFieldSchema = yup
  .object({
    key: yup.string().trim().required(),
    label: yup.string().trim().required(),
    type: yup
      .string()
      .oneOf(Object.values(TEMPLATE_FIELD_TYPE))
      .required(),
    required: yup.boolean().default(false),
    options: yup.array(yup.string().required()).notRequired(),
    pattern: optionalTrimmed(),
    minLength: yup.number().notRequired(),
    maxLength: yup.number().notRequired(),
    min: yup.number().notRequired(),
    max: yup.number().notRequired(),
    helpText: optionalTrimmed(),
  })
  .noUnknown(true);

const templateDocumentSchema = yup
  .object({
    type: yup.string().trim().required(),
    label: yup.string().trim().required(),
    required: yup.boolean().default(true),
    acceptedFormats: yup
      .array(yup.string().oneOf(Object.values(TEMPLATE_DOCUMENT_FORMAT)).required())
      .min(1, "At least one accepted format is required")
      .required(),
  })
  .noUnknown(true);

// profileType is checked against the real PROFILE_MODEL_REGISTRY in the
// controller (yup only knows it's a non-empty string here).
export const createTemplateSchema = yup
  .object({
    profileType: yup.string().trim().required("profileType is required"),
    country: yup
      .string()
      .trim()
      .uppercase()
      .length(2, "country must be an ISO 3166-1 alpha-2 code")
      .required("country is required"),
    state: optionalTrimmed(),
    name: yup.string().trim().required("name is required"),
    fields: yup.array(templateFieldSchema).min(1, "At least one field is required").required(),
    documents: yup.array(templateDocumentSchema).default([]),
  })
  .noUnknown(true);
