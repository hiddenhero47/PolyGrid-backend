import { PaymentProviderAdapter } from "./types";
import { stripeProvider } from "./stripeProvider";
import { PAYMENT_PROVIDER_NAME, PaymentProviderName } from "../../models/paymentProviderModel";

const registry: Partial<Record<PaymentProviderName, PaymentProviderAdapter>> = {
  [PAYMENT_PROVIDER_NAME.STRIPE]: stripeProvider,
};

export const getPaymentProvider = (name: PaymentProviderName): PaymentProviderAdapter => {
  const provider = registry[name];

  if (!provider) {
    throw new Error(`No payment provider adapter registered for '${name}'`);
  }

  return provider;
};
