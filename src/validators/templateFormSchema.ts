import * as yup from "yup";
import { ITemplateField, TEMPLATE_FIELD_TYPE } from "../models/verificationTemplateModel";

// Builds a Yup object schema from a VerificationTemplate's field
// definitions, at request time — these are the same definitions the
// frontend fetches (GET /api/verification-templates/lookup) to render the
// form and build its own Yup schema from, so both sides validate the exact
// same shape without hand-duplicating it in two places.
export const buildFormSchema = (fields: ITemplateField[]): yup.ObjectSchema<Record<string, unknown>> => {
  const shape: Record<string, yup.AnySchema> = {};

  for (const field of fields) {
    shape[field.key] = buildFieldSchema(field);
  }

  return yup.object(shape).noUnknown(true) as yup.ObjectSchema<Record<string, unknown>>;
};

// A blank optional field ("" from a form the user didn't fill in) is treated
// as "not provided," same reasoning as pickDefinedFields — only applied to
// non-required fields since yup's own .required() already rejects "".
const applyRequired = (schema: yup.AnySchema, field: ITemplateField): yup.AnySchema =>
  field.required
    ? schema.required(`${field.label} is required`)
    : schema.transform((value) => (value === "" ? undefined : value)).notRequired();

const buildFieldSchema = (field: ITemplateField): yup.AnySchema => {
  switch (field.type) {
    case TEMPLATE_FIELD_TYPE.NUMBER: {
      let schema = yup.number().typeError(`${field.label} must be a number`);
      if (field.min !== undefined) schema = schema.min(field.min);
      if (field.max !== undefined) schema = schema.max(field.max);
      return applyRequired(schema, field);
    }
    case TEMPLATE_FIELD_TYPE.BOOLEAN:
      return applyRequired(yup.boolean().typeError(`${field.label} must be true or false`), field);
    case TEMPLATE_FIELD_TYPE.DATE: {
      let schema = yup.date().typeError(`${field.label} must be a valid date`);
      if (field.min !== undefined) schema = schema.min(new Date(field.min));
      if (field.max !== undefined) schema = schema.max(new Date(field.max));
      return applyRequired(schema, field);
    }
    case TEMPLATE_FIELD_TYPE.SELECT:
      return applyRequired(
        yup
          .string()
          .trim()
          .oneOf(field.options ?? [], `${field.label} is not a valid option`),
        field,
      );
    case TEMPLATE_FIELD_TYPE.EMAIL:
      return applyRequired(yup.string().trim().email(`${field.label} must be a valid email`), field);
    case TEMPLATE_FIELD_TYPE.STRING:
    case TEMPLATE_FIELD_TYPE.PHONE:
    default: {
      let schema = yup.string().trim();
      if (field.minLength !== undefined) schema = schema.min(field.minLength);
      if (field.maxLength !== undefined) schema = schema.max(field.maxLength);
      if (field.pattern) {
        schema = schema.matches(new RegExp(field.pattern), `${field.label} format looks wrong`);
      }
      return applyRequired(schema, field);
    }
  }
};
