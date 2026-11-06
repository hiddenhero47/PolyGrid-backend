import cron from "node-cron";
import { cronStatus } from "../status";
import { releaseExpiredPaymentHolds } from "../../helpers/paymentHoldRelease";

// Every 6 hours — releases a fraud-held payment (see
// helpers/paymentReconciliation.ts) once its hold window has passed. The
// actual release logic lives in helpers/paymentHoldRelease.ts (pure,
// directly unit-testable); this file is only the cron-scheduling +
// overlap-guard wrapper, same split pendingPaymentSweepTask.ts and
// digitalPurchaseRetentionTask.ts keep. Off the exact hour, same
// convention as the other tasks.
export const paymentHoldRelease = (): void => {
  cron.schedule(
    "13 */6 * * *",
    async () => {
      if (cronStatus.paymentHoldRelease.running) {
        console.log("[CRON][PAYMENT_HOLD_RELEASE] Previous run still executing");
        return;
      }

      try {
        cronStatus.paymentHoldRelease.running = true;
        cronStatus.paymentHoldRelease.lastRun = new Date();

        console.log(`[CRON][PAYMENT_HOLD_RELEASE] Started at ${new Date().toISOString()}`);

        const { checked, released } = await releaseExpiredPaymentHolds();

        console.log(`[CRON][PAYMENT_HOLD_RELEASE] Completed. Checked ${checked}, released ${released}.`);
      } catch (error) {
        console.error("[CRON][PAYMENT_HOLD_RELEASE] Fatal Error:", error);
      } finally {
        cronStatus.paymentHoldRelease.running = false;
      }
    },
    {
      timezone: "UTC",
      noOverlap: true,
    },
  );
};
