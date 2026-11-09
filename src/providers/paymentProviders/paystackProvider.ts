import crypto from "crypto";
import getPaystackClient from "../../config/paystack";
import { PaymentProviderAdapter, CreateIntentParams, CreateIntentResult } from "./types";

const toMinorUnits = (amount: number): number => Math.round(amount * 100);

// Paystack's own status vocabulary, normalized to the exact literal
// strings reconcilePaymentIntent/resumeDigitalPurchaseIntent already
// compare against (paymentController.ts, paymentReconciliation.ts) —
// "success" is the only one that means the charge actually cleared;
// "failed"/"abandoned"/"reversed" are all equally dead the same way
// Stripe's "canceled" is (no further retry is ever going to succeed);
// anything else (pending, processing, ongoing, queued) is left as-is and
// falls through the existing "still pending" branch untouched.
const mapStatus = (paystackStatus: string): string => {
  if (paystackStatus === "success") return "succeeded";
  if (["failed", "abandoned", "reversed"].includes(paystackStatus)) return "canceled";
  return paystackStatus;
};

export const paystackProvider: PaymentProviderAdapter = {
  async createIntent({ amount, currency, metadata, receiptEmail }: CreateIntentParams): Promise<CreateIntentResult> {
    if (!receiptEmail) {
      throw new Error("Paystack requires a receiptEmail to initialize a transaction");
    }

    const { data } = await getPaystackClient().post("/transaction/initialize", {
      amount: toMinorUnits(amount),
      currency: currency.toUpperCase(),
      email: receiptEmail,
      // Same idempotency reasoning as stripeProvider's idempotencyKey —
      // one Payment document only ever calls this once in the normal
      // flow, so collisions should only ever happen on a genuine retry,
      // which Paystack correctly refuses as a duplicate reference rather
      // than silently returning the original (a real difference from
      // Stripe's idempotencyKey behavior — worth knowing, not a bug).
      reference: `polygrid_payment_${metadata.paymentId}`,
      metadata,
    });

    return {
      providerPaymentId: data.data.reference,
      // Repurposed: Paystack's flow is redirect-based, not a
      // client-secret/JS-SDK-confirm flow like Stripe's — this carries
      // the checkout URL the frontend should send the buyer to instead.
      // See docs/payments-plan.md for why createPaymentIntent's response
      // grew a `provider` field alongside this.
      clientSecret: data.data.authorization_url,
    };
  },

  async retrieveIntent(providerPaymentId: string) {
    const { data } = await getPaystackClient().get(`/transaction/verify/${providerPaymentId}`);
    const transaction = data.data;

    return {
      status: mapStatus(transaction.status),
      amount: transaction.amount / 100,
      currency: (transaction.currency as string).toUpperCase(),
      feeAmount: transaction.fees ? transaction.fees / 100 : 0,
      raw: transaction,
    };
  },

  constructWebhookEvent(rawBody: Buffer, signature: string) {
    if (!process.env.PAYSTACK_SECRET_KEY) {
      throw new Error("PAYSTACK_SECRET_KEY is not set");
    }

    const expected = crypto
      .createHmac("sha512", process.env.PAYSTACK_SECRET_KEY)
      .update(rawBody)
      .digest("hex");

    if (expected !== signature) {
      throw new Error("Invalid Paystack webhook signature");
    }

    const event = JSON.parse(rawBody.toString("utf8"));
    return { type: event.event, data: event.data };
  },
};
