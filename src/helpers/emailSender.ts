import fs from "fs/promises";
import path from "path";
import Handlebars from "handlebars";
import getMailgunClient from "../config/mailgun";

// Mirrors house-maduekwe-backend's server-src/helpers/emailSender.js —
// same Mailgun + Handlebars shape, same loadTemplates/sendEmail/
// renderTemplate/sendTemplatedEmail surface — so this can be extended the
// same way there without inventing a second convention. Every test file
// that touches a controller calling sendTemplatedEmail mocks this whole
// module (`jest.mock("../../src/helpers/emailSender", ...)`), same as HM's
// own test suite — no real Mailgun call is ever made in tests.

Handlebars.registerHelper("uppercase", (text: unknown) =>
  typeof text === "string" ? text.toUpperCase() : "",
);
Handlebars.registerHelper("year", () => new Date().getFullYear());

// Add templates here once — a missing file fails loudly at startup
// (loadTemplates), not the first time something tries to send it.
const templateRegistry: Record<string, string> = {
  forgotPassword: "../emails/forgot-password.html",
  paymentRequestDecision: "../emails/payment-request-decision.html",
};

const compiledTemplates: Record<string, Handlebars.TemplateDelegate> = {};

export const loadTemplates = async (): Promise<void> => {
  for (const [name, file] of Object.entries(templateRegistry)) {
    const filePath = path.join(__dirname, file);
    const source = await fs.readFile(filePath, "utf8");
    compiledTemplates[name] = Handlebars.compile(source);
  }

  console.log("✓ Email templates loaded");
};

export const sendEmail = async ({
  to,
  subject,
  html,
}: {
  to: string;
  subject: string;
  html: string;
}) => {
  return getMailgunClient().messages.create(process.env.MAILGUN_DOMAIN as string, {
    from: process.env.EMAIL_FROM,
    to,
    subject,
    html,
  });
};

export const renderTemplate = (
  templateName: string,
  variables: Record<string, unknown> = {},
): string | null => {
  const template = compiledTemplates[templateName];

  if (!template) {
    console.error(`Unknown email template: ${templateName}`);
    return null;
  }

  return template(variables);
};

export const sendTemplatedEmail = async ({
  to,
  subject,
  template,
  variables,
}: {
  to: string;
  subject: string;
  template: string;
  variables: Record<string, unknown>;
}) => {
  const html = renderTemplate(template, variables);

  if (!html) return;

  return sendEmail({ to, subject, html });
};
