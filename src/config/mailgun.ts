import Mailgun from "mailgun.js";
import formData from "form-data";

// mailgun.js doesn't re-export its client's interface type from the
// package root, only the Mailgun class itself — deriving it off
// `.client`'s own return type avoids reaching into a deep, unexported
// subpath just for an annotation.
type MailgunClient = ReturnType<InstanceType<typeof Mailgun>["client"]>;

// Lazy, memoized — same reasoning as config/stripe.ts's getStripeClient:
// never constructed at module-import time, since this file is pulled in
// transitively by app.ts (via emailSender.ts, via controllers that send
// mail). Constructing eagerly would mean the *entire app* fails to boot
// whenever MAILGUN_API_KEY isn't set, not just the mail-sending paths.
let client: MailgunClient | null = null;

const getMailgunClient = (): MailgunClient => {
  if (!client) {
    if (!process.env.MAILGUN_API_KEY) {
      throw new Error("MAILGUN_API_KEY is not set");
    }

    client = new Mailgun(formData).client({
      username: "api",
      key: process.env.MAILGUN_API_KEY,
    });
  }

  return client;
};

export default getMailgunClient;
