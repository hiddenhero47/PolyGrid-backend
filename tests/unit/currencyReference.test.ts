import {
  isValidCurrencyCode,
  getCurrencyDecimalDigits,
  getAllCurrencyCodes,
  PLATFORM_CURRENCY,
  currencyField,
} from "../../src/helpers/currencyReference";

describe("currencyReference", () => {
  describe("isValidCurrencyCode", () => {
    it("accepts a real ISO 4217 code", () => {
      expect(isValidCurrencyCode("USD")).toBe(true);
      expect(isValidCurrencyCode("ngn")).toBe(true); // case-insensitive
    });

    it("rejects a made-up code", () => {
      expect(isValidCurrencyCode("XXX_NOT_REAL")).toBe(false);
    });
  });

  describe("getCurrencyDecimalDigits", () => {
    it("returns 2 for a normal currency", () => {
      expect(getCurrencyDecimalDigits("USD")).toBe(2);
    });

    it("returns 0 for a zero-decimal currency (matters for Stripe amount handling)", () => {
      expect(getCurrencyDecimalDigits("JPY")).toBe(0);
    });
  });

  describe("getAllCurrencyCodes", () => {
    it("includes the currencies this app already defaults to", () => {
      const codes = getAllCurrencyCodes();
      expect(codes).toContain("USD");
      expect(codes).toContain("NGN");
    });
  });

  describe("PLATFORM_CURRENCY / currencyField", () => {
    it("is locked to USD", () => {
      expect(PLATFORM_CURRENCY).toBe("USD");
    });

    it("accepts only PLATFORM_CURRENCY, even for another genuinely valid ISO code", () => {
      const validate = currencyField.validate.validator;
      expect(validate("USD")).toBe(true);
      expect(validate("usd")).toBe(true); // case-insensitive, matches the schema's own `uppercase: true`
      expect(validate("NGN")).toBe(false); // real ISO code, still rejected — this is the actual lock
      expect(validate("NOT_REAL")).toBe(false);
    });
  });
});
