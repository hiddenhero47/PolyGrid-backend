import cron from "node-cron";
import { cronStatus } from "../status";
import { sweepPendingStripePayments } from "../../helpers/paymentReconciliation";

// Every 15 minutes — recovers a payment whose webhook never arrived
// (misconfigured URL, an outage, a dev tunnel restarting mid-session) by
// re-checking it directly against Stripe, and closes out ones old enough
// that waiting on the customer to resume checkout is no longer realistic.
// The actual sweep logic lives in helpers/paymentReconciliation.ts (pure,
// directly unit-testable); this file is only the cron-scheduling +
// overlap-guard wrapper, same split digitalPurchaseRetentionTask.ts and
// profileProductCleanupTask.ts keep.
export const pendingPaymentSweep = (): void => {
  cron.schedule(
    "*/15 * * * *",
    async () => {
      if (cronStatus.pendingPaymentSweep.running) {
        console.log("[CRON][PENDING_PAYMENT_SWEEP] Previous run still executing");
        return;
      }

      try {
        cronStatus.pendingPaymentSweep.running = true;
        cronStatus.pendingPaymentSweep.lastRun = new Date();

        console.log(`[CRON][PENDING_PAYMENT_SWEEP] Started at ${new Date().toISOString()}`);

        const { checked, resolved, abandoned } = await sweepPendingStripePayments();

        console.log(
          `[CRON][PENDING_PAYMENT_SWEEP] Completed. Checked ${checked}, resolved ${resolved}, abandoned ${abandoned}.`,
        );
      } catch (error) {
        console.error("[CRON][PENDING_PAYMENT_SWEEP] Fatal Error:", error);
      } finally {
        cronStatus.pendingPaymentSweep.running = false;
      }
    },
    {
      timezone: "UTC",
      noOverlap: true,
    },
  );
};
