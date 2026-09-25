import mongoose, { Document, Model, Schema } from "mongoose";

// Catalog data, same shape as Plan — payment provider fee structure lives
// here so it isn't hardcoded, and new providers (beyond stripe/manual) can
// be added without a schema change. Not consulted for anything yet (no
// live gateway integration exists), but a Payment's own providerFeeAmount
// records the gateway's *actual* reported fee once one does, the same way
// Subscription snapshots a Plan's fields rather than re-reading it live.
export const PAYMENT_PROVIDER_NAME = {
  STRIPE: "stripe",
  // The interim "an admin recorded this happened" path — see
  // subscriptionController.grantSubscription and jobController.recordPayment.
  MANUAL: "manual",
} as const;
export type PaymentProviderName =
  (typeof PAYMENT_PROVIDER_NAME)[keyof typeof PAYMENT_PROVIDER_NAME];

export interface IPaymentProvider extends Document {
  provider: PaymentProviderName;
  percentageFee: number;
  flatFee: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const paymentProviderSchema = new Schema<IPaymentProvider>(
  {
    provider: {
      type: String,
      required: true,
      unique: true,
      enum: Object.values(PAYMENT_PROVIDER_NAME),
    },
    percentageFee: { type: Number, default: 0, min: 0 },
    flatFee: { type: Number, default: 0, min: 0 },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

export const PaymentProvider: Model<IPaymentProvider> = mongoose.model<IPaymentProvider>(
  "PaymentProvider",
  paymentProviderSchema,
);
