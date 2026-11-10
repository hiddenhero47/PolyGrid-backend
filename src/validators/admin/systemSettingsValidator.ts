import * as yup from "yup";
import { isValidCountryCode } from "../../helpers/countryReference";
import { PAYMENT_PROVIDER_NAME } from "../../models/paymentProviderModel";
import { IDENTITY_VERIFICATION_PROVIDER_NAME } from "../../providers/identityVerificationProviders/types";

// Excludes MANUAL deliberately — it has no registered adapter
// (providers/paymentProviders/index.ts), so routing a country to it would
// make every intent-creation call for that country throw.
const ROUTABLE_PROVIDERS: string[] = [PAYMENT_PROVIDER_NAME.STRIPE, PAYMENT_PROVIDER_NAME.PAYSTACK];
const KYC_PROVIDERS: string[] = Object.values(IDENTITY_VERIFICATION_PROVIDER_NAME);

export const updateSystemSettingsSchema = yup
  .object({
    maxOutstandingExposure: yup.number().min(0).notRequired(),
    maxTransactionAmount: yup.number().min(0).notRequired(),
    supportedCountries: yup
      .array()
      .of(
        yup
          .string()
          .trim()
          .uppercase()
          .test("is-country", "Not a recognized ISO country code", (value) => !value || isValidCountryCode(value)),
      )
      .notRequired(),
    fraudHoldThresholdAmount: yup.number().min(0).notRequired(),
    fraudHoldHours: yup.number().min(0).notRequired(),
    manualReviewThresholdAmount: yup.number().min(0).notRequired(),
    // yup.mixed(), not yup.object() — a bare object() field has no shape
    // of its own, so stripUnknown (validateBody) silently strips every
    // key inside it down to {} even though .test() itself passed. Same
    // gotcha validate.ts's own comment warns about; mixed() has nothing
    // to strip against, so the value passes through untouched. (Caught
    // live: PATCH was 200ing and then silently discarding this field.)
    countryProviderOverrides: yup
      .mixed()
      .test(
        "valid-country-provider-map",
        "countryProviderOverrides must map ISO country codes to a routable provider (stripe or paystack)",
        (value) => {
          if (!value) return true;
          return Object.entries(value as Record<string, string>).every(
            ([country, provider]) => isValidCountryCode(country) && ROUTABLE_PROVIDERS.includes(provider),
          );
        },
      )
      .notRequired(),
    countryKycProviders: yup
      .mixed()
      .test(
        "valid-country-kyc-map",
        "countryKycProviders must map ISO country codes to a registered identity-verification provider",
        (value) => {
          if (!value) return true;
          return Object.entries(value as Record<string, string>).every(
            ([country, provider]) => isValidCountryCode(country) && KYC_PROVIDERS.includes(provider),
          );
        },
      )
      .notRequired(),
    usdToNgnRate: yup.number().min(0).notRequired(),
  })
  .noUnknown(true);
