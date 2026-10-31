// Shared in-memory status tracker for every scheduled task under
// jobs/tasks/ — mirrors house-maduekwe-backend's jobs/status.js exactly
// (one entry per job, `running` as an overlap guard, `lastRun` for
// visibility/debugging). Deliberately a plain mutated object, not a DB
// collection — this is operational state about THIS process, not domain
// data, and resets on restart on purpose.
export interface CronJobStatus {
  running: boolean;
  lastRun: Date | null;
}

export const cronStatus: Record<string, CronJobStatus> = {
  digitalPurchaseRetention: { running: false, lastRun: null },
  profileProductCleanup: { running: false, lastRun: null },
  pendingPaymentSweep: { running: false, lastRun: null },
};
