import Stripe from "stripe";
import getStripeClient from "../config/stripe";
import { IUser } from "../models/userModel";
import { PLATFORM_CURRENCY } from "./currencyReference";

// Pre-fills the connected account's bank account from whatever the user
// already has on file (User.payoutAccount — today's fully-manual payout
// flow, see systemPayoutModel.ts), so onboarding doesn't make them retype
// it. Stripe still independently verifies identity (KYC) during hosted
// onboarding regardless.
//
// Known caveat, not a redesign: Stripe's bank-account field shape varies
// per country (routing number, sort code, IFSC, …), all submitted here as
// `routing_number` — Stripe maps it per `country`. Confirmed to work for
// common cases (US/GB-style accounts); a newly supported country should
// be spot-checked against Stripe's own per-country bank account
// requirements before relying on this pre-fill for it. If it's ever
// rejected, createConnectedAccount still succeeds without it — the
// provider just has to enter it manually during onboarding instead.
// Typed against AccountCreateExternalAccountParams.BankAccount (the
// narrower of the two near-identical shapes Stripe's SDK declares for
// "a bank account dict") rather than AccountCreateParams.ExternalAccount
// — its literal `object: 'bank_account'` is what createExternalAccount
// (used by updateExternalAccount below) requires, and it's still
// structurally assignable wherever the broader shape is expected (account
// creation, below).
const buildExternalAccount = (
  payoutAccount: IUser["payoutAccount"],
): (Stripe.AccountCreateExternalAccountParams.BankAccount & { currency: string }) | undefined => {
  if (!payoutAccount) return undefined;

  return {
    object: "bank_account",
    country: payoutAccount.country,
    currency: PLATFORM_CURRENCY,
    account_number: payoutAccount.accountNumber,
    account_holder_name: payoutAccount.accountName,
    routing_number: payoutAccount.bankCode,
  };
};

// Express: Stripe hosts onboarding + the provider's own simple dashboard,
// and takes on most KYC/compliance itself — the least compliance burden
// on PolyGrid, matching the "avoid needing a license" goal (see
// docs/payments-plan.md). `transfers` is the only capability requested —
// this account only ever RECEIVES a Transfer from PolyGrid's own balance
// (see markSystemPayoutPaid), it never charges a card itself.
//
// Payout schedule is deliberately `manual` — Stripe never auto-forwards
// this account's balance to its bank on its own schedule. The admin goes
// into Stripe's own Connect dashboard and releases it by hand, a second,
// independent checkpoint beyond PolyGrid's own approval flow.
export const createConnectedAccount = async (user: IUser): Promise<string> => {
  const stripe = getStripeClient();

  const account = await stripe.accounts.create({
    type: "express",
    country: user.country,
    email: user.email,
    capabilities: { transfers: { requested: true } },
    external_account: buildExternalAccount(user.payoutAccount),
    settings: { payouts: { schedule: { interval: "manual" } } },
  });

  return account.id;
};

// Keeps Stripe in sync when the user changes their bank details in
// PolyGrid *after* they've already onboarded (userController.ts's
// updatePayoutAccount) — without this, Stripe would silently keep
// whatever bank account it had on file from onboarding time (or whatever
// the provider separately changed directly through Stripe's own
// dashboard), drifting away from what PolyGrid shows as their payout
// account. `default_for_currency: true` makes this the one Stripe
// actually pays out to going forward; the previous external account is
// left in place (Stripe allows several, only one is ever the default) —
// deliberately not deleted, since failing to delete an old one is
// harmless but failing to add the new one isn't.
export const updateExternalAccount = async (
  accountId: string,
  payoutAccount: IUser["payoutAccount"],
): Promise<void> => {
  const stripe = getStripeClient();
  const externalAccount = buildExternalAccount(payoutAccount);

  if (!externalAccount) return;

  await stripe.accounts.createExternalAccount(accountId, {
    external_account: externalAccount,
    default_for_currency: true,
  });
};

export const createOnboardingLink = async (
  accountId: string,
  refreshUrl: string,
  returnUrl: string,
): Promise<string> => {
  const stripe = getStripeClient();

  const link = await stripe.accountLinks.create({
    account: accountId,
    type: "account_onboarding",
    refresh_url: refreshUrl,
    return_url: returnUrl,
  });

  return link.url;
};

// A Transfer moves money from PolyGrid's own Stripe balance to a
// provider/creator's connected account balance — the first of Connect's
// two hops (see Part C of docs/payments-plan.md). Deliberately no
// `source_transaction` pin: a Job can be funded by several separate
// Payments over time, so this draws from the platform's general
// available balance rather than one specific charge. Known tradeoff:
// this can fail with "insufficient available balance" if attempted
// before recently-charged funds clear — callers should leave the
// SystemPayout PENDING for a retry on that failure, not treat it as a
// hard failure.
export const createTransfer = async (params: {
  amount: number;
  currency: string;
  destinationAccountId: string;
  description?: string;
  metadata?: Record<string, string>;
}): Promise<string> => {
  const stripe = getStripeClient();

  const transfer = await stripe.transfers.create({
    amount: toMinorUnits(params.amount),
    currency: params.currency.toLowerCase(),
    destination: params.destinationAccountId,
    description: params.description,
    metadata: params.metadata,
  });

  return transfer.id;
};

// A plain Refund against the ORIGINAL charge/PaymentIntent — always safe
// under "separate charges and transfers" because refundableAmount (see
// jobController.ts) guarantees a refund only ever draws from money still
// sitting in PolyGrid's own balance, never anything already Transferred
// to a provider. No Connect-specific API involved; this is the exact
// same call for any Stripe payment, Connect or not.
export const createRefund = async (params: {
  paymentIntentId: string;
  amount: number;
}): Promise<string> => {
  const stripe = getStripeClient();

  const refund = await stripe.refunds.create({
    payment_intent: params.paymentIntentId,
    amount: toMinorUnits(params.amount),
  });

  return refund.id;
};

// A Connect webhook event arrives on its own endpoint with its own
// signing secret (registered as a "Connect" webhook in the Stripe
// dashboard, not the regular payments one) — see routes/paymentRoutes.ts.
// Kept separate from stripeProvider.ts's constructWebhookEvent
// deliberately: payment reconciliation and connected-account status sync
// are different concerns with different secrets, even though both go
// through the same Stripe client.
export const constructConnectWebhookEvent = (
  rawBody: Buffer,
  signature: string,
): { type: string; data: { object: Stripe.Account } } => {
  const stripe = getStripeClient();
  const event = stripe.webhooks.constructEvent(
    rawBody,
    signature,
    process.env.STRIPE_CONNECT_WEBHOOK_SECRET as string,
  );

  return { type: event.type, data: event.data as { object: Stripe.Account } };
};

// Stripe amounts are always in the currency's smallest unit — mirrors
// stripeProvider.ts's own toMinorUnits exactly (not reused directly to
// avoid a cross-provider-file dependency for one multiply). Every amount
// in this app is PLATFORM_CURRENCY (USD, 2 decimal digits) — see
// currencyReference.ts for the general case this doesn't need yet.
const toMinorUnits = (amount: number): number => Math.round(amount * 100);
