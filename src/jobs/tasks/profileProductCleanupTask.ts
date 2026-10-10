import cron from "node-cron";
import { cronStatus } from "../status";
import { sweepInactiveProfileProducts } from "../../helpers/profileProductCleanup";

// Every 2 hours, a small batch at a time (BATCH_SIZE_PER_TYPE in
// helpers/profileProductCleanup.ts) — reclaims storage from a seller
// whose subscription has lapsed for a month by clearing their catalog's
// files, rather than one big monthly sweep tearing through however many
// sellers lapsed that month all at once. The actual sweep logic lives in
// helpers/profileProductCleanup.ts (pure, directly unit-testable); this
// file is only the cron-scheduling + overlap-guard wrapper, same split
// digitalPurchaseRetentionTask.ts keeps. 13 minutes past every even hour,
// deliberately off the exact hour.
export const profileProductCleanup = (): void => {
  cron.schedule(
    "13 */2 * * *",
    async () => {
      if (cronStatus.profileProductCleanup.running) {
        console.log("[CRON][PROFILE_PRODUCT_CLEANUP] Previous run still executing");
        return;
      }

      try {
        cronStatus.profileProductCleanup.running = true;
        cronStatus.profileProductCleanup.lastRun = new Date();

        console.log(`[CRON][PROFILE_PRODUCT_CLEANUP] Started at ${new Date().toISOString()}`);

        const { storeProfilesProcessed, digitalCreatorProfilesProcessed } = await sweepInactiveProfileProducts();

        console.log(
          `[CRON][PROFILE_PRODUCT_CLEANUP] Completed. Stores: ${storeProfilesProcessed}, digital creators: ${digitalCreatorProfilesProcessed}.`,
        );
      } catch (error) {
        console.error("[CRON][PROFILE_PRODUCT_CLEANUP] Fatal Error:", error);
      } finally {
        cronStatus.profileProductCleanup.running = false;
      }
    },
    {
      timezone: "UTC",
      noOverlap: true,
    },
  );
};
