import asyncHandler from "express-async-handler";
import { Request, Response } from "express";
import {
  ensureSuperAdminExists,
  ensureVerificationTemplatesSeeded,
  ensureConversationIndexesFixed,
  SetupTaskResult,
} from "../helpers/deploymentSetup";

// Runs every registered setup task and collects its result — the actual
// tasks live in helpers/deploymentSetup.ts (pure, directly unit-testable,
// each idempotent on its own). Add new tasks here as the app grows (new
// countries, new one-time backfills, etc.) the same way
// house-maduekwe-backend's runSetupScripts grew a new ensureX call per
// task rather than one task doing everything.
export const runDeploymentSetupTasks = async (): Promise<SetupTaskResult[]> => [
  await ensureSuperAdminExists(),
  await ensureVerificationTemplatesSeeded(),
  await ensureConversationIndexesFixed(),
];

// @desc    Run every deployment setup task (idempotent — safe to call
//          repeatedly). Deliberately not run automatically at server
//          boot (PM2 restarts this process on every deploy, and these
//          tasks are no-ops after their first real run — see server.ts)
//          — call this route instead, the one time it's actually needed.
//          Gated by timeWindowGuard — see routes/deploymentRoutes.ts for
//          the open window, a code literal, never an env var.
// @route   POST /api/deployment/setup
// @access  Public, but see timeWindowGuard (route-level, not auth-level)
export const runDeploymentSetup = asyncHandler(async (_req: Request, res: Response) => {
  const results = await runDeploymentSetupTasks();

  res.status(200).json({
    success: results.every((r) => r.status === "success"),
    timestamp: new Date(),
    results,
  });
});
