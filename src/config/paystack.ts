import axios, { AxiosInstance } from "axios";

// Lazy, memoized — same reasoning as config/stripe.ts: only code that
// actually needs Paystack pays the cost of this failing fast on a
// missing key, not the whole app at boot.
let client: AxiosInstance | null = null;

const getPaystackClient = (): AxiosInstance => {
  if (!client) {
    if (!process.env.PAYSTACK_SECRET_KEY) {
      throw new Error("PAYSTACK_SECRET_KEY is not set");
    }

    client = axios.create({
      baseURL: "https://api.paystack.co",
      headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` },
    });
  }

  return client;
};

export default getPaystackClient;
