import * as yup from "yup";

// A blank optional field ("" from a form left empty) is treated as "not
// provided" — without this, an explicit empty string would survive
// validation and get saved instead of letting a schema-level Mongoose
// default (e.g. currency's "USD") apply. Shared by every validator that
// needs this exact shape, promoted out of what used to be a copy in
// verificationTemplateValidator.ts/templateFormSchema.ts.
export const optionalTrimmedString = () =>
  yup
    .string()
    .trim()
    .transform((value) => (value === "" ? undefined : value))
    .notRequired();
