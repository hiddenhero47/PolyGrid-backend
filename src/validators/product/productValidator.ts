import * as yup from "yup";
import { STOCK_STATUS } from "../../models/productModel";
import { optionalTrimmedString } from "../common";

// `category` isn't validated here — it must be one of the *store's own*
// declared categories (a DB-loaded value, not a static enum), so that
// cross-reference stays in productController.ts. `shippingLocations`
// also stays: resolveShippingLocations there is already a self-contained,
// shared, strict validator (country/state code checks, per-index error
// messages) used by both create and update, not bulky duplicated inline
// checks — there's nothing left to simplify by moving it here. Ownership
// (loadMyStore/loadMyProduct), req.files counts/caps, and the
// image-removal endpoints all stay too.
export const createProductSchema = yup
  .object({
    category: yup.string().trim().notRequired(),
    subCategory: yup.string().trim().notRequired(),
    title: yup.string().trim().required("Please add a title, price, and unit"),
    description: yup.string().trim().notRequired(),
    price: yup.number().min(0).required("Please add a title, price, and unit"),
    currency: optionalTrimmedString(),
    unit: yup.string().trim().required("Please add a title, price, and unit"),
    shippingLocations: yup.mixed().notRequired(),
  })
  .noUnknown(true);

export const updateProductSchema = yup
  .object({
    category: yup.string().trim().notRequired(),
    subCategory: yup.string().trim().notRequired(),
    title: yup.string().trim().notRequired(),
    description: yup.string().trim().notRequired(),
    price: yup.number().min(0).notRequired(),
    currency: optionalTrimmedString(),
    unit: yup.string().trim().notRequired(),
    stockStatus: yup.string().oneOf(Object.values(STOCK_STATUS), "Invalid stockStatus").notRequired(),
    shippingLocations: yup.mixed().notRequired(),
  })
  .noUnknown(true);
