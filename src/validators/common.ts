import * as yup from "yup";
import { PROFILE_STATUS } from "../constants/profileStatus";

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

// Every pillar profile's own "update mine" schema uses this for its
// `status` field — self-service only ever reaches 'active'/'inactive'
// ("take a break" and back), never 'banned'. 'banned' only exists
// through the generic admin endpoint
// (adminProfileController.setProfileStatus), which validates against
// the full PROFILE_STATUS enum instead — see
// validators/admin/adminProfileValidator.ts.
export const selfServiceProfileStatus = () =>
  yup
    .string()
    .oneOf(
      [PROFILE_STATUS.ACTIVE, PROFILE_STATUS.INACTIVE],
      "status must be 'active' or 'inactive'",
    )
    .notRequired();
