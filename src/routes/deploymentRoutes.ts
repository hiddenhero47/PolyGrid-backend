import express from "express";
import { runDeploymentSetup } from "../controllers/deploymentController";
import { timeWindowGuard } from "../middleware/timeWindowGuard";

const router = express.Router();

// No `protect`/`secureRole` here on purpose — the whole point of this
// route is to work on a brand-new deployment where no admin account
// exists yet to authenticate as. timeWindowGuard is the gate instead —
// update the start date/duration below whenever this route needs to be
// reachable again (e.g. before a fresh deploy), as part of that same
// commit; see middleware/timeWindowGuard.ts for why this is a code-level
// literal and not an env var. Kept short (72h, not weeks) — this is a
// privileged, unauthenticated route; widen it for a specific run if a
// deploy is genuinely delayed, rather than defaulting to a long window
// "just in case."
router.post("/setup", timeWindowGuard("2026-10-19T00:00:00Z", 72), runDeploymentSetup);

export default router;
