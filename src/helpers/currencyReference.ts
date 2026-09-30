import currencyCodes from "currency-codes";

// ISO 4217 — the same "real reference data, not a free string" instinct as
// countryReference.ts. `digits` matters beyond validation: it's the number
// of decimal places a currency actually uses (2 for USD/NGN, 0 for JPY),
// which is exactly what Stripe's own "zero-decimal currency" handling
// needs — anywhere this codebase does real money math against an amount +
// currency pair should read `digits` from here rather than assuming 2.
export const isValidCurrencyCode = (code: string): boolean => !!currencyCodes.code(code.toUpperCase());

export const getCurrencyDecimalDigits = (code: string): number => currencyCodes.code(code.toUpperCase())?.digits ?? 2;

export const getAllCurrencyCodes = (): string[] => currencyCodes.codes();
