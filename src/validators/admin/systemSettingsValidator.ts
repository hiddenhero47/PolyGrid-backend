import * as yup from "yup";
import { isValidCountryCode } from "../../helpers/countryReference";

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
  })
  .noUnknown(true);
