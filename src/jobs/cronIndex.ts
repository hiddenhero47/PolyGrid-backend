import { digitalPurchaseRetention } from "./tasks/digitalPurchaseRetentionTask";
import { profileProductCleanup } from "./tasks/profileProductCleanupTask";

// Mirrors house-maduekwe-backend's jobs/cronIndex.js — one entry point
// server.ts calls once at boot, which registers every scheduled task.
// `initialized` guards against a second accidental call double-scheduling
// everything (e.g. a test importing this module more than once).
let initialized = false;

export const startCronJobs = (): void => {
  if (initialized) return;

  initialized = true;

  digitalPurchaseRetention();
  profileProductCleanup();

  console.log("All cron jobs started");
};
