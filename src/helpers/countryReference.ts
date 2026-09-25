import { Country, State, City, ICountry, IState, ICity } from "country-state-city";

// A single source of truth for "is this a real country/state" — used both
// to validate input (every `country`/`state` field across the app was
// previously just an uppercased free string with no check against reality)
// and as reference data the frontend can query directly (see
// referenceController.ts) to populate country/state/city dropdowns instead
// of hand-maintaining its own copy of this list. Backed by the
// `country-state-city` package — bundled data, no network call, so every
// lookup here is synchronous and free.
export const getAllCountries = (): ICountry[] => Country.getAllCountries();

export const getCountry = (isoCode: string): ICountry | undefined => Country.getCountryByCode(isoCode.toUpperCase());

export const isValidCountryCode = (isoCode: string): boolean => !!getCountry(isoCode);

export const getStatesOfCountry = (countryCode: string): IState[] => State.getStatesOfCountry(countryCode.toUpperCase());

// Some countries genuinely have no state/province subdivisions in this
// dataset (mostly small nations) — treated as "nothing to check a state
// against," not "every state is invalid." A country that *does* have
// listed states must match one of them.
export const isValidStateCode = (countryCode: string, stateCode: string): boolean => {
  const states = getStatesOfCountry(countryCode);
  if (states.length === 0) return true;
  return states.some((state) => state.isoCode === stateCode.toUpperCase());
};

export const getCitiesOfCountry = (countryCode: string): ICity[] =>
  City.getCitiesOfCountry(countryCode.toUpperCase()) ?? [];

export const getCitiesOfState = (countryCode: string, stateCode: string): ICity[] =>
  City.getCitiesOfState(countryCode.toUpperCase(), stateCode.toUpperCase());

// The ISO 4217 currency code this dataset associates with a country — a
// reasonable *default* to pre-fill a form with, not a hard rule (several
// countries use more than one currency in practice; this dataset only
// tracks one per country). Never used to reject a currency value — see
// currencyReference.ts for that.
export const getDefaultCurrencyForCountry = (countryCode: string): string | undefined =>
  getCountry(countryCode)?.currency;
