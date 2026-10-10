import cron from "node-cron";
import { cronStatus } from "../status";
import { sweepExpiredPurchaseFiles } from "../../helpers/digitalPurchaseRetention";

// Weekly — a buyer's purchase-time file snapshot is retained while their
// subscription is active, wiped 7 days after it lapses. The actual sweep
// logic lives in helpers/digitalPurchaseRetention.ts (pure, directly
// unit-testable); this file is only the cron-scheduling + overlap-guard
// wrapper, same split house-maduekwe-backend's jobs/jobListings/orderJobs.js
// keeps from helpers/orderHelper.js. Sunday ~3am UTC, deliberately off the
// exact hour.
export const digitalPurchaseRetention = (): void => {
  cron.schedule(
    "17 3 * * 0",
    async () => {
      if (cronStatus.digitalPurchaseRetention.running) {
        console.log("[CRON][DIGITAL_PURCHASE_RETENTION] Previous run still executing");
        return;
      }

      try {
        cronStatus.digitalPurchaseRetention.running = true;
        cronStatus.digitalPurchaseRetention.lastRun = new Date();

        console.log(`[CRON][DIGITAL_PURCHASE_RETENTION] Started at ${new Date().toISOString()}`);

        const { checked, wiped } = await sweepExpiredPurchaseFiles();

        console.log(`[CRON][DIGITAL_PURCHASE_RETENTION] Completed. Checked ${checked}, wiped ${wiped}.`);
      } catch (error) {
        console.error("[CRON][DIGITAL_PURCHASE_RETENTION] Fatal Error:", error);
      } finally {
        cronStatus.digitalPurchaseRetention.running = false;
      }
    },
    {
      timezone: "UTC",
      // Belt-and-suspenders alongside the cronStatus.running guard above —
      // node-cron v4's own built-in overlap protection (this project's
      // node-cron version doesn't have the `scheduled` start/stop option
      // HM's older version uses; schedule() starts immediately).
      noOverlap: true,
    },
  );
};
