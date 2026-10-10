import { DigitalStorageProviderAdapter } from "./types";
import { internalStorageProvider } from "./internalStorageProvider";
import { s3StorageProvider } from "./s3StorageProvider";

export const DIGITAL_STORAGE_PROVIDER = {
  INTERNAL: "internal",
  AWS: "aws",
} as const;
export type DigitalStorageProviderName = (typeof DIGITAL_STORAGE_PROVIDER)[keyof typeof DIGITAL_STORAGE_PROVIDER];

const registry: Record<DigitalStorageProviderName, DigitalStorageProviderAdapter> = {
  [DIGITAL_STORAGE_PROVIDER.INTERNAL]: internalStorageProvider,
  [DIGITAL_STORAGE_PROVIDER.AWS]: s3StorageProvider,
};

// Deliberately read straight from process.env, resolved fresh on every
// call — never cached, never exposed through any API endpoint, and never
// meant to change at runtime. Which provider is active is a deploy-time
// decision (edit .env, redeploy), not something any request should be
// able to flip: switching providers mid-flight would leave existing
// `key`s pointing at whichever store they were actually written to,
// while new reads went looking in the other one. Defaults to `internal`
// — this project doesn't have real AWS credentials set up yet; set
// DIGITAL_STORAGE_PROVIDER=aws once it does. See
// docs/digital-storefront-plan.md.
export const getDigitalStorageProvider = (): DigitalStorageProviderAdapter => {
  const configured = process.env.DIGITAL_STORAGE_PROVIDER;

  if (configured === DIGITAL_STORAGE_PROVIDER.AWS) {
    return registry[DIGITAL_STORAGE_PROVIDER.AWS];
  }

  return registry[DIGITAL_STORAGE_PROVIDER.INTERNAL];
};
