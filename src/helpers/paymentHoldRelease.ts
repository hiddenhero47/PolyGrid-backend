import { Payment } from "../models/paymentModel";
import { completePaymentTarget } from "./paymentCompletion";
import { notifyPaymentHoldUpdate } from "./paymentHoldNotify";
import { getSystemSettings } from "./systemSettings";

// @desc    Releases every fraud-hold (helpers/paymentReconciliation.ts)
//          whose holdReleaseAt has passed — runs the exact same
//          completePaymentTarget the immediate path would have run at
//          charge time, just deferred. Each release is wrapped in its own
//          try/catch (same instinct as sweepPendingStripePayments' own
//          per-item try/catch) — one failure logs and continues, it never
//          blocks the rest of the batch.
//
//          Above SystemSettings.manualReviewThresholdAmount, this
//          deliberately does NOT auto-release — it's left isOnHold and
//          keeps reappearing in this same query every run (harmless)
//          until an admin explicitly approves it via
//          POST /api/payments/:id/approve-hold
//          (paymentController.ts's approveHeldPayment). `checked` still
//          counts it; `released` doesn't.
export const releaseExpiredPaymentHolds = async (): Promise<{ checked: number; released: number }> => {
  const due = await Payment.find({ isOnHold: true, holdReleaseAt: { $lte: new Date() } });
  const settings = await getSystemSettings();

  let released = 0;

  for (const payment of due) {
    if (payment.amount > settings.manualReviewThresholdAmount) continue;

    try {
      await completePaymentTarget(payment);

      payment.isOnHold = false;
      await payment.save();

      await notifyPaymentHoldUpdate(payment, true);
      released += 1;
    } catch (error) {
      console.error(`[PAYMENT_HOLD_RELEASE] Failed to release payment ${payment.id}:`, error);
    }
  }

  return { checked: due.length, released };
};
