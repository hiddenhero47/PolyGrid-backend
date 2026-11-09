import { IdentityVerificationAdapter, IDENTITY_VERIFICATION_PROVIDER_NAME, IdentityVerificationProviderName } from "./types";
import { dojahProvider } from "./dojahProvider";

const registry: Partial<Record<IdentityVerificationProviderName, IdentityVerificationAdapter>> = {
  [IDENTITY_VERIFICATION_PROVIDER_NAME.DOJAH]: dojahProvider,
};

export const getIdentityVerificationProvider = (
  name: IdentityVerificationProviderName,
): IdentityVerificationAdapter => {
  const provider = registry[name];

  if (!provider) {
    throw new Error(`No identity verification adapter registered for '${name}'`);
  }

  return provider;
};
