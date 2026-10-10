import * as yup from "yup";
import { objectIdString } from "../objectId";
import { optionalTrimmedString } from "../common";

// Store/product existence, ownership, the subscription-live-check,
// per-item cross-currency rule, and shipping-destination resolution all
// stay in storeOrderController.ts — none of that is expressible before
// the store/products are even loaded. Only the shape layer moved here.
const shippingDestinationSchema = yup.object({
  country: yup.string().trim().required("A shipping destination (at least a country) is required"),
  state: optionalTrimmedString(),
});

const orderItemSchema = yup.object({
  productId: objectIdString("Each item needs a valid productId").required("Each item needs a valid productId"),
  quantity: yup
    .number()
    .integer("Each item needs a quantity of at least 1")
    .min(1, "Each item needs a quantity of at least 1")
    .required("Each item needs a quantity of at least 1"),
});

export const createOrderSchema = yup
  .object({
    storeId: objectIdString("A valid storeId is required").required("A valid storeId is required"),
    items: yup
      .array()
      .of(orderItemSchema)
      .min(1, "An order needs at least one item")
      .required("An order needs at least one item"),
    shippingDestination: shippingDestinationSchema.required(
      "A shipping destination (at least a country) is required",
    ),
    note: yup.string().trim().notRequired(),
  })
  .noUnknown(true);
