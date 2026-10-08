import * as yup from "yup";
import { selfServiceProfileStatus } from "../common";

// `categories`/`links` deliberately aren't validated here — the
// controller's own filterValidCategories/filterValidLinks filters
// silently drop invalid entries rather than rejecting the request
// (business logic, not a shape check); the "at least one category"
// rule is checked on the post-filter result, and the MAX_PROFILE_LINKS
// cap likewise, so both stay in the controller. Country format is
// already enforced once, at the Mongoose schema level.
export const createStoreProfileSchema = yup
  .object({
    storeName: yup.string().trim().required("Please add a store name and country"),
    description: yup.string().trim().notRequired(),
    categories: yup.array().notRequired(),
    country: yup.string().trim().required("Please add a store name and country"),
    city: yup.string().trim().notRequired(),
    links: yup.array().notRequired(),
  })
  .noUnknown(true);

export const updateStoreProfileSchema = yup
  .object({
    storeName: yup.string().trim().notRequired(),
    description: yup.string().trim().notRequired(),
    categories: yup.array().notRequired(),
    country: yup.string().trim().notRequired(),
    city: yup.string().trim().notRequired(),
    links: yup.array().notRequired(),
    status: selfServiceProfileStatus(),
  })
  .noUnknown(true);
