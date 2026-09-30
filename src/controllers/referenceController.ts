import asyncHandler from "express-async-handler";
import { Request, Response } from "express";
import {
  getAllCountries,
  getCountry,
  getStatesOfCountry,
  getCitiesOfCountry,
  getCitiesOfState,
} from "../helpers/countryReference";
import { getAllCurrencyCodes, getCurrencyDecimalDigits } from "../helpers/currencyReference";

// All of this is public, static, in-memory reference data (no DB, no
// auth) — the same data every country/state/currency field across the app
// validates input against (see countryReference.ts/currencyReference.ts),
// exposed here so the frontend can populate dropdowns from the exact same
// source of truth instead of hand-maintaining its own copy that could
// drift out of sync.

// @desc    List every country
// @route   GET /api/reference/countries
// @access  Public
export const listCountries = asyncHandler(async (_req: Request, res: Response) => {
  const countries = getAllCountries().map((country) => ({
    isoCode: country.isoCode,
    name: country.name,
    currency: country.currency,
    phonecode: country.phonecode,
  }));

  res.status(200).json({ data: countries });
});

// @desc    List a country's states/provinces (empty if this dataset has
//          none for it — that's a real, valid answer, not an error)
// @route   GET /api/reference/countries/:countryCode/states
// @access  Public
export const listStates = asyncHandler(async (req: Request, res: Response) => {
  const countryCode = req.params.countryCode as string;

  if (!getCountry(countryCode)) {
    res.status(404);
    throw new Error("Unknown country code");
  }

  const states = getStatesOfCountry(countryCode).map((state) => ({
    isoCode: state.isoCode,
    name: state.name,
  }));

  res.status(200).json({ data: states });
});

// @desc    List a country's cities, optionally scoped to one state
//          (?state=<isoCode>) — unscoped can be a large list for big
//          countries, meant for a frontend that filters/searches
//          client-side or narrows by state first.
// @route   GET /api/reference/countries/:countryCode/cities
// @access  Public
export const listCities = asyncHandler(async (req: Request, res: Response) => {
  const countryCode = req.params.countryCode as string;
  const stateCode = req.query.state as string | undefined;

  if (!getCountry(countryCode)) {
    res.status(404);
    throw new Error("Unknown country code");
  }

  const cities = stateCode
    ? getCitiesOfState(countryCode, stateCode)
    : getCitiesOfCountry(countryCode);

  res.status(200).json({ data: cities.map((city) => ({ name: city.name, stateCode: city.stateCode })) });
});

// @desc    List every ISO 4217 currency code, with its decimal digits
// @route   GET /api/reference/currencies
// @access  Public
export const listCurrencies = asyncHandler(async (_req: Request, res: Response) => {
  const currencies = getAllCurrencyCodes().map((code) => ({
    code,
    digits: getCurrencyDecimalDigits(code),
  }));

  res.status(200).json({ data: currencies });
});
