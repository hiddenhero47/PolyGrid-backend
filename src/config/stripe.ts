import Stripe from "stripe";

// Lazy, memoized — never constructed at module-import time. The Stripe SDK
// throws immediately if the key is missing/empty, and this file is pulled
// in transitively by app.ts (via paymentController.ts) — constructing
// eagerly would mean the *entire app*, not just payment routes, fails to
// boot whenever STRIPE_SECRET_KEY isn't set. Only code that actually needs
// Stripe pays that cost, and only when it runs.
let client: Stripe | null = null;

const getStripeClient = (): Stripe => {
  if (!client) {
    if (!process.env.STRIPE_SECRET_KEY) {
      throw new Error("STRIPE_SECRET_KEY is not set");
    }

    client = new Stripe(process.env.STRIPE_SECRET_KEY);
  }

  return client;
};

export default getStripeClient;
