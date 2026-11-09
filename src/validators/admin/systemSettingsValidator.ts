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
    countryProviderOverrides: yup
      .object()
      .test(
        "valid-country-provider-map",
        "countryProviderOverrides must map ISO country codes to a routable provider (stripe or paystack)",
        (value) => {
          if (!value) return true;
          return Object.entries(value).every(
            ([country, provider]) => isValidCountryCode(country) && ROUTABLE_PROVIDERS.includes(provider as string),
          );
        },
      )
      .notRequired(),
    countryKycProviders: yup
      .object()
      .test(
        "valid-country-kyc-map",
        "countryKycProviders must map ISO country codes to a registered identity-verification provider",
        (value) => {
          if (!value) return true;
          return Object.entries(value).every(
            ([country, provider]) => isValidCountryCode(country) && KYC_PROVIDERS.includes(provider as string),
          );
        },
      )
      .notRequired(),
  })
  .noUnknown(true);
