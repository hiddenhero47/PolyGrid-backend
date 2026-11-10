import Stripe from "stripe";
import getStripeClient from "../../config/stripe";
import { PaymentProviderAdapter, CreateIntentParams, CreateIntentResult } from "./types";
import { providerCallFailed } from "./providerError";

const toMinorUnits = (amount: number): number => Math.round(amount * 100);

export const stripeProvider: PaymentProviderAdapter = {
  async createIntent({
    amount,
    currency,
    metadata,
    receiptEmail,
  }: CreateIntentParams): Promise<CreateIntentResult> {
    try {
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
          // Forces a 3D Secure challenge on every card charge, rather than
          // leaving it to Stripe's own risk-based "automatic" default — a
          // deliberate fraud-mitigation choice (see docs/payments-plan.md),
          // not something per-request callers opt into. This is an in-page
          // modal Stripe.js resolves via confirmCardPayment/handleNextAction
          // on a `requires_action` status, not a full-page redirect, so it's
          // compatible with allow_redirects: 'never' above.
          payment_method_options: { card: { request_three_d_secure: "any" } },
          metadata,
        },
        // Same Payment doc retried (e.g. a flaky client re-submitting) never
        // creates a second PaymentIntent at Stripe.
        { idempotencyKey: `polygrid_payment_${metadata.paymentId}` },
      );

      return {
        providerPaymentId: intent.id,
        clientSecret: intent.client_secret,
        // Always exactly what was asked for — Stripe never converts.
        chargedAmount: amount,
        chargedCurrency: currency.toUpperCase(),
      };
    } catch (err) {
      if (err instanceof Stripe.errors.StripeError) {
        throw providerCallFailed("Stripe", err.message);
      }
      throw err;
    }
  },

  async retrieveIntent(providerPaymentId: string) {
    try {
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
    } catch (err) {
      if (err instanceof Stripe.errors.StripeError) {
        throw providerCallFailed("Stripe", err.message);
      }
      throw err;
    }
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
