import {
  isValidCountryCode,
  isValidStateCode,
  getDefaultCurrencyForCountry,
  getStatesOfCountry,
  getCitiesOfState,
  getAllCountries,
} from "../../src/helpers/countryReference";

describe("countryReference", () => {
  describe("isValidCountryCode", () => {
    it("accepts a real ISO 3166-1 alpha-2 code", () => {
      expect(isValidCountryCode("NG")).toBe(true);
      expect(isValidCountryCode("ng")).toBe(true); // case-insensitive
    });

    it("rejects a made-up code", () => {
      expect(isValidCountryCode("ZZ")).toBe(false);
    });
  });

  describe("isValidStateCode", () => {
    it("accepts a real state for a country that has listed states", () => {
      expect(isValidStateCode("NG", "LA")).toBe(true); // Lagos
      expect(isValidStateCode("ng", "la")).toBe(true);
    });

    it("rejects a state that doesn't belong to that country", () => {
      expect(isValidStateCode("NG", "CA")).toBe(false); // California is a US state, not Nigerian
    });

    it("accepts anything for a country with no states listed in this dataset", () => {
      // Not every country has state-level data — that's a real "nothing to
      // check against" case, not an "everything is invalid" one. Found
      // dynamically rather than hardcoding a country name, since which
      // ones have no states is a fact about the bundled dataset, not
      // something worth guessing at.
      const countryWithNoStates = getAllCountries().find(
        (country) => getStatesOfCountry(country.isoCode).length === 0,
      );
      expect(countryWithNoStates).toBeDefined();
      expect(isValidStateCode(countryWithNoStates!.isoCode, "anything")).toBe(true);
    });
  });

  describe("getDefaultCurrencyForCountry", () => {
    it("returns the ISO 4217 code this dataset associates with a country", () => {
      expect(getDefaultCurrencyForCountry("NG")).toBe("NGN");
      expect(getDefaultCurrencyForCountry("US")).toBe("USD");
    });
  });

  describe("getCitiesOfState", () => {
    it("returns real cities for a known country/state pair", () => {
      const cities = getCitiesOfState("NG", "LA");
      expect(cities.length).toBeGreaterThan(0);
      expect(cities.every((city) => city.stateCode === "LA")).toBe(true);
    });
  });
});
