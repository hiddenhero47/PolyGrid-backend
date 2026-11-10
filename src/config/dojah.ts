import axios, { AxiosInstance } from "axios";

// Lazy, memoized — same reasoning as config/stripe.ts and config/paystack.ts.
// Dojah authenticates with two headers: AppId (which app) and Authorization
// (the secret key, sent raw — no "Bearer " prefix, that causes a 401) —
// confirmed against Dojah's own current docs.
//
// Unlike Stripe/Paystack, sandbox and production are two entirely
// different hostnames, not just a different key on the same URL — so
// DOJAH_ENV picks which one, defaulting to "sandbox" (same closed/
// conservative-by-default posture as SystemSettings' own defaults: never
// accidentally point a test key at production, or vice versa).
let client: AxiosInstance | null = null;

const getDojahClient = (): AxiosInstance => {
  if (!client) {
    if (!process.env.DOJAH_APP_ID || !process.env.DOJAH_SECRET_KEY) {
      throw new Error("DOJAH_APP_ID and DOJAH_SECRET_KEY must both be set");
    }

    const baseURL =
      process.env.DOJAH_ENV === "production" ? "https://api.dojah.io" : "https://sandbox.dojah.io";

    client = axios.create({
      baseURL,
      headers: {
        AppId: process.env.DOJAH_APP_ID,
        Authorization: process.env.DOJAH_SECRET_KEY,
      },
    });
  }

  return client;
};

export default getDojahClient;
