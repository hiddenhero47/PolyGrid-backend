// A deliberately small interface — exactly the three operations
// paymentController.ts actually calls. 'manual' payments never go through
// this at all (they're just a direct Payment.create()); this exists so a
// second real gateway later is a new file implementing the same shape, not
// a rewrite of the controller — mirrors house-maduekwe-backend's
// dispatch-by-provider pattern for shipping/webhooks.
export interface CreateIntentParams {
  amount: number;
  currency: string;
  metadata: Record<string, string>;
  receiptEmail?: string;
  // Where to send the buyer's browser back after a redirect-based
  // checkout (Paystack) — stripeProvider.ts ignores this entirely,
  // Stripe.js owns the return flow for a client-secret-based checkout
  // instead. Caller-supplied (the frontend controls its own routes),
  // never guessed server-side.
  callbackUrl?: string;
  // SystemSettings.usdToNgnRate, resolved by the caller
  // (resolveProviderForCountry) and passed in rather than fetched here —
  // provider adapters never touch the database directly, only their own
  // gateway, so they stay trivially unit-testable with no DB connection.
  // stripeProvider.ts ignores this entirely; paystackProvider.ts converts
  // a USD charge to NGN with it when > 0 (this integration has no USD
  // support — see its own comment).
  usdToNgnRate?: number;
}

export interface CreateIntentResult {
  providerPaymentId: string;
  clientSecret: string | null;
  // What the adapter actually told the gateway to charge — usually just
  // an echo of CreateIntentParams.amount/currency (Stripe always), but
  // paystackProvider.ts may convert USD to NGN at send-time when
  // SystemSettings.usdToNgnRate is configured (this Paystack integration
  // has no USD support — see its own comment). paymentController.ts
  // snapshots these onto Payment.providerChargedAmount/
  // providerChargedCurrency so reconcilePaymentIntent compares a
  // provider's real response against what was really sent, not always
  // the canonical USD amount/currency.
  chargedAmount: number;
  chargedCurrency: string;
}

export interface PaymentProviderAdapter {
  createIntent(params: CreateIntentParams): Promise<CreateIntentResult>;
  // Re-fetches the intent from the gateway by id — callers should never
  // trust a webhook payload's own claims about amount/currency/status
  // without this, same reasoning as HM's processStripeEvent.
  retrieveIntent(providerPaymentId: string): Promise<{
    status: string;
    amount: number;
    currency: string;
    feeAmount: number;
    raw: unknown;
  }>;
  constructWebhookEvent(rawBody: Buffer, signature: string): { type: string; data: unknown };
}
