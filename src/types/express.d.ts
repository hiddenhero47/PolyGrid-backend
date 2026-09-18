import { IUser } from "../models/userModel";
import { ISubscription } from "../models/subscriptionModel";

declare global {
  namespace Express {
    interface Request {
      user?: IUser;
      // Set by `attachCurrentPlan`/`requireActiveSubscription` — the
      // caller's current Subscription record, or null if they've never
      // subscribed. Undefined means neither middleware has run yet.
      currentPlan?: ISubscription | null;
    }
  }
}

export {};
