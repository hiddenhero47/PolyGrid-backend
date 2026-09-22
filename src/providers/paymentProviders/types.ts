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
}

export interface CreateIntentResult {
  providerPaymentId: string;
  clientSecret: string | null;
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
