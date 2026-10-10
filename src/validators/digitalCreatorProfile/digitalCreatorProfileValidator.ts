import * as yup from "yup";
import { selfServiceProfileStatus } from "../common";

// `links` deliberately isn't validated here — filterValidLinks in
// digitalCreatorProfileController.ts silently drops malformed entries
// rather than rejecting the request, which is business logic (a
// sanitizing filter), not a shape check Yup should be enforcing. The
// MAX_PROFILE_LINKS cap (checked post-filter) stays in the controller
// for the same reason. Country format is already enforced once, at the
// Mongoose schema level (digitalCreatorProfileModel.ts's own
// isValidCountryCode validator).
export const createDigitalCreatorProfileSchema = yup
  .object({
    displayName: yup.string().trim().required("Please add a displayName and country"),
    bio: yup.string().trim().notRequired(),
    country: yup.string().trim().required("Please add a displayName and country"),
    city: yup.string().trim().notRequired(),
    links: yup.array().notRequired(),
  })
  .noUnknown(true);

export const updateDigitalCreatorProfileSchema = yup
  .object({
    displayName: yup.string().trim().notRequired(),
    bio: yup.string().trim().notRequired(),
    country: yup.string().trim().notRequired(),
    city: yup.string().trim().notRequired(),
    links: yup.array().notRequired(),
    status: selfServiceProfileStatus(),
  })
  .noUnknown(true);
