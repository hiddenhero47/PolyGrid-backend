import currencyCodes from "currency-codes";

// ISO 4217 — the same "real reference data, not a free string" instinct as
// countryReference.ts. `digits` matters beyond validation: it's the number
// of decimal places a currency actually uses (2 for USD/NGN, 0 for JPY),
// which is exactly what Stripe's own "zero-decimal currency" handling
// needs — anywhere this codebase does real money math against an amount +
// currency pair should read `digits` from here rather than assuming 2.
// Kept as general reference data (GET /api/reference/currencies, display/
// formatting elsewhere) even though every money field in this app now
// only ever actually holds PLATFORM_CURRENCY — see currencyField below.
export const isValidCurrencyCode = (code: string): boolean => !!currencyCodes.code(code.toUpperCase());

export const getCurrencyDecimalDigits = (code: string): number => currencyCodes.code(code.toUpperCase())?.digits ?? 2;

export const getAllCurrencyCodes = (): string[] => currencyCodes.codes();

// The platform's one and only currency — a deliberate v1 decision to avoid
// the complexity (and confusion, especially around payouts) of real
// multi-currency conversion. Every model that handles money (Plan, Job,
// JobOpening, Bid, TenderProject, mentorship pricing, Product,
// DigitalProduct, DigitalPurchase, Payment, StoreOrder, SystemPayout)
// validates its `currency` field against this via currencyField below,
// not the full ISO 4217 list isValidCurrencyCode checks. Supporting a
// second currency later is a deliberate migration (real exchange-rate
// handling, a currency picker, …), not a config flip — change this one
// constant and every validator still only accepts whatever it's set to.
export const PLATFORM_CURRENCY = "USD";

// The one Mongoose field definition every money-handling model's
// `currency` field spreads in (`currency: { ...currencyField, ... }`),
// instead of redeclaring the same validator a dozen times. Deliberately
// has no `default`/`required` of its own — each model adds whichever it
// already had, so this only ever changes the validator, not a model's
// existing required/default shape.
export const currencyField = {
  type: String,
  uppercase: true,
  trim: true,
  validate: {
    validator: (code: string) => code.toUpperCase() === PLATFORM_CURRENCY,
    message: () => `Only ${PLATFORM_CURRENCY} is supported right now`,
  },
};
