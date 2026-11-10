import crypto from "crypto";
import axios from "axios";
import getPaystackClient from "../../config/paystack";
import { PaymentProviderAdapter, CreateIntentParams, CreateIntentResult } from "./types";
import { providerCallFailed } from "./providerError";

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
  async createIntent({
    amount,
    currency,
    metadata,
    receiptEmail,
    callbackUrl,
    usdToNgnRate,
  }: CreateIntentParams): Promise<CreateIntentResult> {
    if (!receiptEmail) {
      throw new Error("Paystack requires a receiptEmail to initialize a transaction");
    }

    // This Paystack integration has no USD support (confirmed directly
    // against the live API: "Currency not supported by merchant" — NGN
    // only, until Paystack approves an international-payments request).
    // usdToNgnRate (resolved from SystemSettings by the caller — see
    // types.ts's own comment on why it's passed in, not fetched here) is
    // the interim opt-in stopgap: 0/undefined means every currency is
    // sent through unchanged, so a USD charge still fails exactly as it
    // does today; a real rate converts USD to NGN right here, at
    // send-time, and nowhere else. Never applies to anything already NGN
    // (or any other non-USD currency) — only this one specific gap.
    let chargeAmount = amount;
    let chargeCurrency = currency.toUpperCase();

    if (chargeCurrency === "USD" && usdToNgnRate) {
      chargeAmount = amount * usdToNgnRate;
      chargeCurrency = "NGN";
    }

    try {
      const { data } = await getPaystackClient().post("/transaction/initialize", {
        amount: toMinorUnits(chargeAmount),
        currency: chargeCurrency,
        email: receiptEmail,
        // Same idempotency reasoning as stripeProvider's idempotencyKey —
        // one Payment document only ever calls this once in the normal
        // flow, so collisions should only ever happen on a genuine retry,
        // which Paystack correctly refuses as a duplicate reference rather
        // than silently returning the original (a real difference from
        // Stripe's idempotencyKey behavior — worth knowing, not a bug).
        reference: `polygrid_payment_${metadata.paymentId}`,
        metadata,
        // Omitted entirely when the caller doesn't supply one — Paystack
        // then falls back to whatever's configured as the dashboard's own
        // default Callback URL, not an error.
        ...(callbackUrl ? { callback_url: callbackUrl } : {}),
      });

      return {
        providerPaymentId: data.data.reference,
        // Repurposed: Paystack's flow is redirect-based, not a
        // client-secret/JS-SDK-confirm flow like Stripe's — this carries
        // the checkout URL the frontend should send the buyer to instead.
        // See docs/payments-plan.md for why createPaymentIntent's response
        // grew a `provider` field alongside this.
        clientSecret: data.data.authorization_url,
        chargedAmount: chargeAmount,
        chargedCurrency: chargeCurrency,
      };
    } catch (err) {
      if (axios.isAxiosError(err)) {
        throw providerCallFailed("Paystack", err.response?.data?.message ?? err.message);
      }
      throw err;
    }
  },

  async retrieveIntent(providerPaymentId: string) {
    try {
      const { data } = await getPaystackClient().get(`/transaction/verify/${providerPaymentId}`);
      const transaction = data.data;

      // transaction.amount is the TOTAL actually charged to the card,
      // which includes Paystack's own fee when this account has "fees to
      // customer" enabled (confirmed live: a 30000 NGN charge came back
      // as amount 30558.38, fees 558.38) — reconcilePaymentIntent
      // compares this against Payment.providerChargedAmount (what WE
      // told Paystack to charge, i.e. the base amount), so comparing
      // against the fee-inclusive total would make every fees-to-customer
      // charge look like a perpetual mismatch and never leave "pending".
      // requested_amount is what was actually requested at initialize
      // time — exactly the figure that matches. Falls back to amount for
      // any transaction shape that lacks it (fees absorbed by the
      // merchant instead of passed to the customer, older transactions,
      // ...), where the two are the same figure anyway.
      const chargedAmount = transaction.requested_amount ?? transaction.amount;

      return {
        status: mapStatus(transaction.status),
        amount: chargedAmount / 100,
        currency: (transaction.currency as string).toUpperCase(),
        feeAmount: transaction.fees ? transaction.fees / 100 : 0,
        raw: transaction,
      };
    } catch (err) {
      if (axios.isAxiosError(err)) {
        throw providerCallFailed("Paystack", err.response?.data?.message ?? err.message);
      }
      throw err;
    }
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
