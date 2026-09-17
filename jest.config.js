/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  rootDir: ".",
  testMatch: ["<rootDir>/tests/**/*.test.ts"],
  setupFiles: ["<rootDir>/tests/setup/env.ts"],
  // Starts (once, for the whole run) and stops the disposable in-memory
  // replica set used when TEST_MONGO_URI isn't set — see
  // tests/setup/globalSetup.ts for why this has to be global rather than
  // per-file.
  globalSetup: "<rootDir>/tests/setup/globalSetup.ts",
  globalTeardown: "<rootDir>/tests/setup/globalTeardown.ts",
  testTimeout: 30000,
  verbose: true,
  // Integration tests share one DB connection and mutate real collections —
  // running them one-at-a-time avoids two test files racing on the same
  // data. See package.json's "test" script (--runInBand).
};
