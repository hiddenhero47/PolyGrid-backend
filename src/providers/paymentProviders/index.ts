import { PaymentProviderAdapter } from "./types";
import { stripeProvider } from "./stripeProvider";
import { paystackProvider } from "./paystackProvider";
import { PAYMENT_PROVIDER_NAME, PaymentProviderName } from "../../models/paymentProviderModel";

const registry: Partial<Record<PaymentProviderName, PaymentProviderAdapter>> = {
  [PAYMENT_PROVIDER_NAME.STRIPE]: stripeProvider,
  [PAYMENT_PROVIDER_NAME.PAYSTACK]: paystackProvider,
};

export const getPaymentProvider = (name: PaymentProviderName): PaymentProviderAdapter => {
  const provider = registry[name];

  if (!provider) {
    throw new Error(`No payment provider adapter registered for '${name}'`);
  }

  return provider;
};
