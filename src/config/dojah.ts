import axios, { AxiosInstance } from "axios";

// Lazy, memoized — same reasoning as config/stripe.ts and config/paystack.ts.
// Dojah authenticates with two headers: AppId (which app) and Authorization
// (the secret key) — confirm these exact header names against Dojah's
// current dashboard/docs before going live, not re-verified in this pass.
let client: AxiosInstance | null = null;

const getDojahClient = (): AxiosInstance => {
  if (!client) {
    if (!process.env.DOJAH_APP_ID || !process.env.DOJAH_SECRET_KEY) {
      throw new Error("DOJAH_APP_ID and DOJAH_SECRET_KEY must both be set");
    }

    client = axios.create({
      baseURL: "https://api.dojah.io",
      headers: {
        AppId: process.env.DOJAH_APP_ID,
        Authorization: process.env.DOJAH_SECRET_KEY,
      },
    });
  }

  return client;
};

export default getDojahClient;
