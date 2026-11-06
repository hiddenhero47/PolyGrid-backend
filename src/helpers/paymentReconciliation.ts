import { Payment, IPayment, PAYMENT_STATUS, PAYMENT_TARGET_TYPE } from "../models/paymentModel";
import { PAYMENT_PROVIDER_NAME } from "../models/paymentProviderModel";
import { ISubscription, SUBSCRIPTION_STATUS, Subscription } from "../models/subscriptionModel";
import { getPaymentProvider } from "../providers/paymentProviders";
import { completePaymentTarget } from "./paymentCompletion";
import { getSystemSettings } from "./systemSettings";
import { notifyPaymentHoldUpdate } from "./paymentHoldNotify";

export interface ReconcileResult {
  status: "success" | "pending" | "failed";
  payment: IPayment;
  subscription?: ISubscription;
}

type RetrievedIntent = Awaited<ReturnType<ReturnType<typeof getPaymentProvider>["retrieveIntent"]>>;

// The check-and-activate sequence a successful payment_intent.succeeded
// delivery runs — a standalone helper (not inlined in paymentController's
// webhook) so the exact same logic can be triggered by
// paymentController.refreshPayment and the pendingPaymentSweep cron job,
// whenever a webhook never arrives (wrong URL, an outage, a dev tunnel
// restarting mid-session). Never trusts the caller's claim about the
// intent, only what `intent` (always a fresh provider.retrieveIntent
// result) actually says. The idempotency guard makes re-running this on an
// already-reconciled payment a pure no-op regardless of which caller
// triggered it.
export const reconcilePaymentIntent = async (
  payment: IPayment,
  intentId: string,
  intent: RetrievedIntent,
): Promise<ReconcileResult> => {
  if (payment.status === PAYMENT_STATUS.SUCCESS && payment.providerPaymentId === intentId) {
    const subscription =
      payment.targetType === PAYMENT_TARGET_TYPE.SUBSCRIPTION
        ? await Subscription.findById(payment.targetId)
        : null;
    return { status: "success", payment, subscription: subscription ?? undefined };
  }

  const isSuccess = intent.status === "succeeded";
  const isAmount = Math.round(intent.amount * 100) === Math.round(payment.amount * 100);
  const isCurrency = intent.currency.toUpperCase() === payment.currency.toUpperCase();

  if (!isSuccess || !isAmount || !isCurrency) {
    // Stripe has no single "this failed" PaymentIntent status — most
    // non-succeeded states (requires_payment_method, requires_action,
    // processing, ...) just mean checkout hasn't finished yet. 'canceled'
    // is the one state that's genuinely final.
    return { status: intent.status === "canceled" ? "failed" : "pending", payment };
  }

  payment.status = PAYMENT_STATUS.SUCCESS;
  payment.providerPaymentId = intentId;
  payment.providerFeeAmount = intent.feeAmount;
  payment.rawProviderPayload = intent.raw as Record<string, unknown>;
  await payment.save();

  // Card-fraud mitigation (see docs/payments-plan.md): the charge
  // succeeded — Stripe already has the money — but above this threshold
  // the *value* (escrow credit, download, subscription activation) is
  // deliberately deferred, giving a stolen-card chargeback time to arrive
  // before PolyGrid hands anything over. paymentController.ts's
  // stripeWebhook handling of charge.dispute.created is what actually
  // cancels the release if that signal arrives; helpers/
  // paymentHoldRelease.ts's sweep is what releases it otherwise.
  const settings = await getSystemSettings();

  if (payment.amount > settings.fraudHoldThresholdAmount) {
    payment.isOnHold = true;
    payment.holdReleaseAt = new Date(Date.now() + settings.fraudHoldHours * 60 * 60 * 1000);
    await payment.save();
    await notifyPaymentHoldUpdate(payment, false);
    return { status: "success", payment };
  }

  const { subscription } = await completePaymentTarget(payment);
  return { status: "success", payment, subscription };
};

// 10 minutes — long enough that a webhook delivered promptly has already
// landed, short enough that a customer who just finished checkout isn't
// stuck 'pending' for long if theirs got lost.
const REFRESH_AFTER_MS = 10 * 60 * 1000;

// 24 hours with no successful webhook/refresh — waiting on the customer to
// come back and finish an abandoned checkout is no longer realistic; close
// the payment out instead of leaving it 'pending' forever.
const ABANDON_AFTER_MS = 24 * 60 * 60 * 1000;

// @desc    Re-checks every still-PENDING Stripe payment old enough that its
//          webhook should have already arrived, via the same
//          reconcilePaymentIntent the webhook/refresh endpoint use. A
//          payment that's actually succeeded at Stripe gets activated here
//          instead of staying stuck; one that's old enough and still
//          unresolved gets marked 'failed' (and, if it was funding a
//          subscription purchase, that subscription is canceled) rather
//          than lingering indefinitely.
export const sweepPendingStripePayments = async (): Promise<{
  checked: number;
  resolved: number;
  abandoned: number;
}> => {
  const refreshCutoff = new Date(Date.now() - REFRESH_AFTER_MS);
  const abandonCutoff = new Date(Date.now() - ABANDON_AFTER_MS);

  const provider = getPaymentProvider(PAYMENT_PROVIDER_NAME.STRIPE);

  const pending = await Payment.find({
    provider: PAYMENT_PROVIDER_NAME.STRIPE,
    status: PAYMENT_STATUS.PENDING,
    createdAt: { $lte: refreshCutoff },
    providerPaymentId: { $exists: true, $ne: null },
  });

  let resolved = 0;
  let abandoned = 0;

  for (const payment of pending) {
    try {
      const intent = await provider.retrieveIntent(payment.providerPaymentId as string);
      const result = await reconcilePaymentIntent(payment, payment.providerPaymentId as string, intent);

      if (result.status === "success") {
        resolved += 1;
        continue;
      }

      if (payment.createdAt <= abandonCutoff) {
        payment.status = PAYMENT_STATUS.FAILED;
        await payment.save();
        abandoned += 1;

        if (payment.targetType === PAYMENT_TARGET_TYPE.SUBSCRIPTION) {
          await Subscription.updateOne(
            { _id: payment.targetId, status: SUBSCRIPTION_STATUS.PENDING },
            { status: SUBSCRIPTION_STATUS.CANCELED },
          );
        }
      }
    } catch (error) {
      console.error(`[PENDING_PAYMENT_SWEEP] Failed to refresh payment ${payment.id}:`, error);
    }
  }

  return { checked: pending.length, resolved, abandoned };
};
