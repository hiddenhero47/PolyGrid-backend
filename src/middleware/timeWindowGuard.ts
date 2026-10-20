import { Request, Response, NextFunction } from "express";

// Gates a one-off/setup route to a window — the same idea as
// house-maduekwe-backend's own timeWindowGuard: hardcode the window
// directly where the route is defined (`timeWindowGuard("2026-04-05T00:00:00Z", 24)`),
// not read from env. Deliberately NOT env-driven: the whole point is that
// opening a window for a new one-off task (a DB-normalization route after
// a model change, say) is just part of writing and deploying that route's
// code — never a separate "go to the server and edit env vars" step. An
// absolute, author-chosen start date is also the only way this genuinely
// closes for good once past it — a window computed relative to server
// boot would silently re-open on every restart for as long as the route
// stays in the codebase, which defeats the purpose.
//
// Two things improved over HM's version, both at zero operational cost:
// - Validated eagerly, at route-registration time (i.e. at deploy/boot),
//   not per-request — a malformed date or hours value fails loudly
//   immediately instead of silently 403-ing forever with no clue why.
// - Logs every time it actually lets a request through, so there's an
//   audit trail of exactly when a sensitive setup route was used.
export const timeWindowGuard = (allowedStart: string, allowedHours: number) => {
  const start = new Date(allowedStart);

  if (Number.isNaN(start.getTime())) {
    throw new Error(`timeWindowGuard: "${allowedStart}" is not a valid date`);
  }
  if (!Number.isFinite(allowedHours) || allowedHours <= 0) {
    throw new Error(`timeWindowGuard: allowedHours must be a positive number, got ${allowedHours}`);
  }

  const end = new Date(start.getTime() + allowedHours * 60 * 60 * 1000);

  return (req: Request, res: Response, next: NextFunction): void => {
    const now = new Date();

    if (now >= start && now <= end) {
      console.log(`[TIME_WINDOW_GUARD] Allowed request to ${req.originalUrl} at ${now.toISOString()}`);
      next();
      return;
    }

    res.status(403).json({ success: false, message: "Setup route not available at this time." });
  };
};
