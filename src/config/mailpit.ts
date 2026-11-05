import nodemailer, { Transporter } from "nodemailer";

// Dev-only counterpart to config/mailgun.ts's getMailgunClient — same lazy,
// memoized shape, but there's no required env var to validate here: Mailpit
// is a local SMTP catcher (https://mailpit.axllent.org/), so a missing
// MAILPIT_HOST/MAILPIT_PORT just means "use the defaults a local Mailpit
// listens on" rather than "fail loudly."
let transporter: Transporter | null = null;

const getMailpitTransporter = (): Transporter => {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.MAILPIT_HOST || "localhost",
      port: Number(process.env.MAILPIT_PORT) || 1025,
      secure: false,
    });
  }

  return transporter;
};

export default getMailpitTransporter;
