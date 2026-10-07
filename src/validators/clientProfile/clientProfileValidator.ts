import * as yup from "yup";

// Country format is already enforced once, at the Mongoose schema level.
export const createClientProfileSchema = yup
  .object({
    displayName: yup.string().trim().required("Please add a displayName and country"),
    bio: yup.string().trim().notRequired(),
    country: yup.string().trim().required("Please add a displayName and country"),
    city: yup.string().trim().notRequired(),
  })
  .noUnknown(true);

export const updateClientProfileSchema = yup
  .object({
    displayName: yup.string().trim().notRequired(),
    bio: yup.string().trim().notRequired(),
    country: yup.string().trim().notRequired(),
    city: yup.string().trim().notRequired(),
  })
  .noUnknown(true);
