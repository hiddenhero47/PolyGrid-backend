import * as yup from "yup";

// submitVerification takes multipart/form-data (identity fields + a
// template-driven set of dynamic form fields + files) — there's no static
// shape to run validateBody against, so its checks live inline in the
// controller instead (identity fields manually, the dynamic form via
// templateFormSchema.buildFormSchema once the template is resolved).
// rejectVerification is a plain JSON body, so it keeps using validateBody.
export const rejectVerificationSchema = yup
  .object({
    reason: yup.string().trim().required("A rejection reason is required"),
  })
  .noUnknown(true);
