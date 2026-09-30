import mongoose, { Document, Model, Schema, Types } from "mongoose";
import { isValidCurrencyCode } from "../helpers/currencyReference";
import { isValidCountryCode, isValidStateCode } from "../helpers/countryReference";

// "Checkout" for physical goods — see docs/store-plan.md. Deliberately NOT
// a fulfillment/shipping pipeline: PolyGrid isn't handling delivery for
// physical building materials itself (a future PolyGrid Logistics needs
// real infrastructure this doesn't have yet), so there's no status
// workflow here to track "shipped"/"delivered"/etc.
//
// Placing an order does three things: (1) snapshots what was actually
// requested — item prices, the resolved shipping price, at the values
// they were requested at (same "snapshot, don't reference a mutable live
// value" instinct as Subscription snapshotting Plan); (2) spins up a real
// `Job` (jobType: 'store') — the shop owner as its creator (so they can
// adjust the calculated price pre-confirmation, same as any job's
// creator-only edit, tracked via Job.amountHistory), the buyer as the
// party who confirms to accept it. That Job is where escrow/payment
// visibility and (optionally) an attached invoice — Job.contractFile,
// zero new code needed — actually live; (3) connects buyer and store
// owner as Contacts (same connectUsers side effect Job creation already
// triggers through its own HTTP endpoint — replicated manually here since
// this Job is created directly, not through that endpoint).
export interface IStoreOrderItem {
  product: Types.ObjectId;
  titleSnapshot: string;
  quantity: number;
  unitPriceSnapshot: number;
}

export interface IShippingDestination {
  country: string;
  state?: string;
}

export interface IStoreOrder extends Document {
  store: Types.ObjectId;
  buyer: Types.ObjectId;
  // The Job this order created — escrow, confirmation, price negotiation,
  // and invoice attachment all happen there, not on this record.
  job: Types.ObjectId;
  items: IStoreOrderItem[];
  shippingDestination: IShippingDestination;
  // Kept as three numbers rather than just the total, so a buyer or owner
  // looking at an order later can see the products/shipping split, not
  // just one combined figure — Job.totalAmount is the sum of these at the
  // moment the order was placed, but only this record keeps the breakdown.
  itemsTotalSnapshot: number;
  shippingTotalSnapshot: number;
  totalSnapshot: number;
  currency: string;
  // Free-form — a delivery address, a preferred contact window, whatever
  // the buyer wants the seller to see first. Not structured because
  // PolyGrid never acts on it programmatically; the seller reads it.
  note?: string;
  createdAt: Date;
}

const storeOrderItemSchema = new Schema<IStoreOrderItem>(
  {
    product: { type: Schema.Types.ObjectId, ref: "Product", required: true },
    titleSnapshot: { type: String, required: true },
    quantity: { type: Number, required: true, min: 1 },
    unitPriceSnapshot: { type: Number, required: true, min: 0 },
  },
  { _id: false },
);

const shippingDestinationSchema = new Schema<IShippingDestination>(
  {
    country: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      validate: {
        validator: isValidCountryCode,
        message: (props: { value: string }) => `${props.value} is not a recognized ISO country code`,
      },
    },
    state: {
      type: String,
      trim: true,
      uppercase: true,
      validate: {
        validator: function (this: IShippingDestination, value: string | undefined) {
          if (!value) return true;
          return isValidStateCode(this.country, value);
        },
        message: "Not a recognized state/province for this country",
      },
    },
  },
  { _id: false },
);

const storeOrderSchema = new Schema<IStoreOrder>(
  {
    store: { type: Schema.Types.ObjectId, ref: "StoreProfile", required: true, index: true },
    buyer: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    job: { type: Schema.Types.ObjectId, ref: "Job", required: true, unique: true },
    items: {
      type: [storeOrderItemSchema],
      validate: {
        validator: (items: IStoreOrderItem[]) => items.length > 0,
        message: "An order needs at least one item",
      },
    },
    shippingDestination: { type: shippingDestinationSchema, required: true },
    itemsTotalSnapshot: { type: Number, required: true, min: 0 },
    shippingTotalSnapshot: { type: Number, required: true, min: 0 },
    totalSnapshot: { type: Number, required: true, min: 0 },
    currency: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      validate: {
        validator: isValidCurrencyCode,
        message: (props: { value: string }) => `${props.value} is not a recognized ISO 4217 currency code`,
      },
    },
    note: { type: String, trim: true, maxlength: 2000 },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

export const StoreOrder: Model<IStoreOrder> = mongoose.model<IStoreOrder>("StoreOrder", storeOrderSchema);
