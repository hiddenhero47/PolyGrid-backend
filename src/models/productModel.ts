import mongoose, { Document, Model, Schema, Types } from "mongoose";
import { MATERIAL_CATEGORY, MaterialCategory } from "./storeProfileModel";
import { isValidCurrencyCode } from "../helpers/currencyReference";
import { isValidCountryCode, isValidStateCode } from "../helpers/countryReference";
import { IMediaFile, mediaFileSchema } from "./mediaFile";

// A store's product listing — see docs/store-plan.md. Deliberately no
// `currentSubscription`/`isVerified` field here at all: whether a product
// is visible is decided entirely by its *store*'s status, checked live
// wherever a product is actually reached (storeProfileController's store
// page, or productController.getProduct's direct-link path) — never
// stored on the product itself. No real inventory/stock-count tracking
// either — `stockStatus` is just an availability signal a seller sets by
// hand, not something the system decrements on an order (PolyGrid doesn't
// manage fulfillment for physical goods at all right now, see
// storeOrderModel.ts).
export const STOCK_STATUS = {
  IN_STOCK: "in_stock",
  OUT_OF_STOCK: "out_of_stock",
  MADE_TO_ORDER: "made_to_order",
} as const;
export type StockStatus = (typeof STOCK_STATUS)[keyof typeof STOCK_STATUS];

// Same reasoning as ConsultancyProfile's portfolio media cap — unbounded
// images per product would mean unbounded disk usage with no real ceiling.
export const MAX_PRODUCT_IMAGES = 6;
export const MAX_SHIPPING_LOCATIONS = 20;

// Shipping is a property of the *product* (weight, bulk, how it's actually
// moved), not the store — a shop can sell both 50kg cement bags and small
// hand tools, and those have nothing in common logistically just because
// they share a seller. `state: undefined` means "ships anywhere in this
// whole country at this price" — the exact same nationwide-default-with-
// state-override pattern VerificationTemplate already uses (see
// countryReference.isValidStateCode), not a new idea invented for this.
// A destination with no matching entry here — neither a state-specific
// one nor a nationwide fallback — simply can't be shipped to: checkout
// rejects it outright rather than guessing a price (see
// storeOrderController.ts).
export interface IShippingOption {
  country: string;
  state?: string;
  price: number;
}

export interface IProduct extends Document {
  storeId: Types.ObjectId;
  // Must be one of the owning StoreProfile's own `categories` — checked in
  // productController.ts at create/update time, not here (a schema
  // validator has no clean way to read a sibling document). Sub-category
  // is deliberately free text, not its own enum: it's a finer, seller-
  // chosen detail ("Portland cement" vs "cement_concrete"), not something
  // search/cascade-delete logic needs to reason about structurally the
  // way the top-level category does.
  category: MaterialCategory;
  subCategory?: string;
  title: string;
  description?: string;
  images: IMediaFile[];
  price: number;
  currency: string;
  // Free text ("bag", "ton", "piece", "roll", "meter", ...) — building
  // materials are sold in enough different units that a fixed enum would
  // either be incomplete or need constant upkeep; category is the field
  // that actually needs to be a strict, cascade-delete-driving taxonomy,
  // not this one.
  unit: string;
  stockStatus: StockStatus;
  // Required and non-empty — a product with no shipping locations at all
  // can't be ordered by anyone, which is exactly the "forgot to fill this
  // in" failure mode requiring it at all guards against.
  shippingLocations: IShippingOption[];
  createdAt: Date;
  updatedAt: Date;
}

const shippingOptionSchema = new Schema<IShippingOption>(
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
        // `this` is the shipping-option subdocument — a plain function so
        // Mongoose binds it, same technique used for Verification's own
        // location. A country with no states in the reference data has
        // nothing to check a state against (see countryReference.ts).
        validator: function (this: IShippingOption, value: string | undefined) {
          if (!value) return true;
          return isValidStateCode(this.country, value);
        },
        message: "Not a recognized state/province for this country",
      },
    },
    price: { type: Number, required: true, min: 0 },
  },
  { _id: false },
);

// State-specific match first, falling back to the country's nationwide
// entry (`state: undefined`) — same resolution order
// verificationTemplateLookup.findActiveTemplate already uses for the
// identical "country, optionally narrowed by state" shape. Returns null
// when neither exists — "can't ship there," not a guessed price.
export const resolveShippingPrice = (
  product: IProduct,
  destination: { country: string; state?: string },
): number | null => {
  const country = destination.country.toUpperCase();
  const state = destination.state?.toUpperCase();

  if (state) {
    const stateMatch = product.shippingLocations.find(
      (option) => option.country === country && option.state === state,
    );
    if (stateMatch) return stateMatch.price;
  }

  const nationwideMatch = product.shippingLocations.find(
    (option) => option.country === country && !option.state,
  );
  return nationwideMatch ? nationwideMatch.price : null;
};

const productSchema = new Schema<IProduct>(
  {
    storeId: { type: Schema.Types.ObjectId, ref: "StoreProfile", required: true, index: true },
    category: { type: String, enum: Object.values(MATERIAL_CATEGORY), required: true },
    subCategory: { type: String, trim: true },
    title: { type: String, required: [true, "Please add a title"], trim: true },
    description: { type: String },
    images: {
      type: [mediaFileSchema],
      default: [],
      validate: {
        validator: (images: IMediaFile[]) => images.length <= MAX_PRODUCT_IMAGES,
        message: `A product can have at most ${MAX_PRODUCT_IMAGES} images`,
      },
    },
    price: { type: Number, required: true, min: 0 },
    currency: {
      type: String,
      required: true,
      default: "USD",
      uppercase: true,
      trim: true,
      validate: {
        validator: isValidCurrencyCode,
        message: (props: { value: string }) => `${props.value} is not a recognized ISO 4217 currency code`,
      },
    },
    unit: { type: String, required: [true, "Please add a unit (e.g. bag, ton, piece)"], trim: true },
    stockStatus: {
      type: String,
      enum: Object.values(STOCK_STATUS),
      default: STOCK_STATUS.IN_STOCK,
    },
    shippingLocations: {
      type: [shippingOptionSchema],
      validate: {
        validator: (options: IShippingOption[]) =>
          options.length > 0 && options.length <= MAX_SHIPPING_LOCATIONS,
        message: `A product needs at least one shipping location, and at most ${MAX_SHIPPING_LOCATIONS}`,
      },
    },
  },
  { timestamps: true },
);

// "A store's products, newest first" and "a store's products in one
// category" (storeProfileController.getStore's two query shapes) are the
// only patterns products are ever listed by — discovery always goes
// through a store, never a flat cross-store product search (see
// docs/store-plan.md for why).
productSchema.index({ storeId: 1, createdAt: -1 });
productSchema.index({ storeId: 1, category: 1 });

export const Product: Model<IProduct> = mongoose.model<IProduct>("Product", productSchema);
