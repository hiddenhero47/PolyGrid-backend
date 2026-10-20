import * as yup from "yup";
import { ACCOUNT_TYPE, ACCOUNT_STATUS, SYSTEM_ROLE } from "../../models/userModel";
import { optionalTrimmedString } from "../common";

// Same scope as every other validator here: shape/required-ness only.
// Password-hash comparisons, token/session lookups, role-change business
// rules (can't modify Super Admin, can't change your own role) all need a
// loaded User document (or a bcrypt/jwt call) and stay in
// userController.ts exactly where they were.

// Declared even though nothing validates its contents today (the
// controller passes it straight to Mongoose, which is the only thing
// that's ever checked it) — `.noUnknown(true)` + `stripUnknown` elsewhere
// would otherwise silently drop it off a registration request.
const phoneNumberPassthrough = yup
  .object({
    number: yup.string().notRequired(),
    country: yup.string().notRequired(),
  })
  .notRequired();

export const registerUserSchema = yup
  .object({
    fullName: yup.string().trim().required("fullName is required"),
    email: yup.string().trim().lowercase().email("A valid email is required").required("email is required"),
    password: yup.string().required("password is required"),
    phoneNumber: phoneNumberPassthrough,
  })
  .noUnknown(true);

export const loginUserSchema = yup
  .object({
    email: yup.string().trim().required("email is required"),
    password: yup.string().required("password is required"),
    // Only actually required once loginUser loads the account and finds
    // user2fa.enable true — unknowable before that, so it's optional here
    // and checked in the controller instead.
    token: yup.string().trim().notRequired(),
  })
  .noUnknown(true);

// `token` (the 2FA code) is only actually required once googleLogin
// loads the matched account and finds user2fa.enable true — same
// "unknowable before the account is loaded" reasoning as
// loginUserSchema's own `token` field.
export const googleLoginSchema = yup
  .object({
    idToken: yup.string().required("idToken is required"),
    token: yup.string().trim().notRequired(),
  })
  .noUnknown(true);

export const appleLoginSchema = yup
  .object({
    identityToken: yup.string().required("identityToken is required"),
    token: yup.string().trim().notRequired(),
  })
  .noUnknown(true);

// Every field optional (a partial update) — `phoneNumber`'s own
// "not both missing" rule replicates exactly what the controller used to
// check by hand, no tighter and no looser (e.g. `{number: "..."}` alone,
// with no country, still passes here precisely as it did before).
export const updateUserProfileSchema = yup
  .object({
    fullName: yup.string().trim().notRequired(),
    phoneNumber: yup
      .object({
        number: yup.string().trim().notRequired(),
        country: yup.string().trim().uppercase().notRequired(),
      })
      // Without this, yup casts a *missing* phoneNumber key into `{}`
      // rather than leaving it `undefined` (a nested object schema's own
      // default casting behavior) — which would make the "not both
      // missing" test below fail even when the caller never sent
      // phoneNumber at all.
      .default(undefined)
      .test(
        "not-both-missing",
        "Both phone number and country code are required",
        (value) => !value || Boolean(value.number) || Boolean(value.country),
      )
      .notRequired(),
    password: yup.string().notRequired(),
    oldPassword: yup.string().notRequired(),
  })
  .noUnknown(true);

export const toggleAccountTypeSchema = yup
  .object({
    activeAccountType: yup.string().oneOf(Object.values(ACCOUNT_TYPE)).notRequired(),
  })
  .noUnknown(true)
  .default({});

export const requestResetSchema = yup
  .object({
    email: yup.string().trim().required("Email is required"),
  })
  .noUnknown(true);

export const resetPasswordSchema = yup
  .object({
    token: yup.string().required("Token and password are required"),
    password: yup.string().required("Token and password are required"),
  })
  .noUnknown(true);

export const resendVerificationSchema = yup
  .object({
    email: yup.string().trim().required("Email is required"),
  })
  .noUnknown(true);

export const verifyEmailSchema = yup
  .object({
    token: yup.string().required("Token is required"),
  })
  .noUnknown(true);

export const registerAdminSchema = yup
  .object({
    fullName: yup.string().trim().required("fullName is required"),
    email: yup.string().trim().lowercase().email("A valid email is required").required("email is required"),
    password: yup.string().required("password is required"),
  })
  .noUnknown(true);

export const changeUserRoleSchema = yup
  .object({
    systemRole: yup
      .string()
      .oneOf(Object.values(SYSTEM_ROLE), "Invalid role")
      .required("Invalid role"),
  })
  .noUnknown(true);

export const setAccountStatusSchema = yup
  .object({
    accountStatus: yup
      .string()
      .oneOf(Object.values(ACCOUNT_STATUS), "accountStatus must be 'active' or 'suspended'")
      .required("accountStatus must be 'active' or 'suspended'"),
  })
  .noUnknown(true);

// `currentPassword`/`otpToken` aren't declared here on purpose —
// verifyIdentityMiddleware (wired before this in the route) reads them
// off the raw body first; by the time this schema's own `stripUnknown`
// runs, they've already done their job and are fine to drop. Country
// format is already enforced once, at the Mongoose schema level.
export const updatePayoutAccountSchema = yup
  .object({
    accountName: yup.string().trim().required("accountName is required"),
    accountNumber: yup.string().trim().required("accountNumber is required"),
    bankName: yup.string().trim().required("bankName is required"),
    bankCode: optionalTrimmedString(),
    country: yup.string().trim().required("country is required"),
  })
  .noUnknown(true);

// setupTwoFactor has no body fields of its own — `currentPassword`/
// `otpToken` are read by verifyIdentityMiddleware before this schema's
// own `stripUnknown` runs, same reasoning as updatePayoutAccountSchema.
export const setupTwoFactorSchema = yup.object({}).noUnknown(true).default({});

export const verifyTwoFactorSchema = yup
  .object({
    token: yup.string().trim().required("A 6-digit code is required"),
  })
  .noUnknown(true);

export const toggleTwoFactorSchema = yup
  .object({
    enable: yup.boolean().required("enable must be true or false"),
  })
  .noUnknown(true);
