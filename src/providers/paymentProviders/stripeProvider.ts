import Stripe from "stripe";
import getStripeClient from "../../config/stripe";
import { PaymentProviderAdapter, CreateIntentParams, CreateIntentResult } from "./types";

const toMinorUnits = (amount: number): number => Math.round(amount * 100);

export const stripeProvider: PaymentProviderAdapter = {
  async createIntent({
    amount,
    currency,
    metadata,
    receiptEmail,
  }: CreateIntentParams): Promise<CreateIntentResult> {
    const intent = await getStripeClient().paymentIntents.create(
      {
        amount: toMinorUnits(amount),
        currency: currency.toLowerCase(),
        receipt_email: receiptEmail,
        // allow_redirects: 'never' restricts this to payment methods (card,
        // essentially) that can confirm without leaving the page — some
        // automatic payment method types redirect the customer off-site and
        // back, which needs a return_url to resume checkout on. There's no
        // frontend built yet to own that return leg, so redirect-based
        // methods are out of scope for now; revisit together with whatever
        // confirms these client-side once one exists.
        automatic_payment_methods: { enabled: true, allow_redirects: "never" },
        metadata,
      },
      // Same Payment doc retried (e.g. a flaky client re-submitting) never
      // creates a second PaymentIntent at Stripe.
      { idempotencyKey: `polygrid_payment_${metadata.paymentId}` },
    );

    return { providerPaymentId: intent.id, clientSecret: intent.client_secret };
  },

  async retrieveIntent(providerPaymentId: string) {
    const intent = await getStripeClient().paymentIntents.retrieve(providerPaymentId, {
      expand: ["latest_charge.balance_transaction"],
    });

    const charge = intent.latest_charge as Stripe.Charge | null;
    const balanceTransaction = charge?.balance_transaction as Stripe.BalanceTransaction | null;

    return {
      status: intent.status,
      amount: intent.amount / 100,
      currency: intent.currency.toUpperCase(),
      feeAmount: balanceTransaction ? balanceTransaction.fee / 100 : 0,
      raw: intent,
    };
  },

  constructWebhookEvent(rawBody: Buffer, signature: string) {
    const event = getStripeClient().webhooks.constructEvent(
      rawBody,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET as string,
    );

    return { type: event.type, data: event.data.object };
  },
};
