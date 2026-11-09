// Mirrors providers/paymentProviders/types.ts's own reasoning exactly —
// a deliberately small interface (the one operation payoutKycController.ts
// actually needs) so a second vendor later is a new file implementing the
// same shape, not a rewrite of the controller.
export const IDENTITY_VERIFICATION_PROVIDER_NAME = {
  DOJAH: "dojah",
} as const;
export type IdentityVerificationProviderName =
  (typeof IDENTITY_VERIFICATION_PROVIDER_NAME)[keyof typeof IDENTITY_VERIFICATION_PROVIDER_NAME];

export interface VerifyMatchParams {
  idType: "bvn" | "nin";
  idNumber: string;
  firstName: string;
  lastName: string;
}

export interface VerifyMatchResult {
  matched: boolean;
  // The vendor's own reference for this specific check — kept for
  // support/audit purposes so a dispute can point at the exact check
  // without ever resubmitting the number. Never the idNumber itself.
  reference: string;
  raw: unknown;
}

export interface IdentityVerificationAdapter {
  verifyMatch(params: VerifyMatchParams): Promise<VerifyMatchResult>;
}
