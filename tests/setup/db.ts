import mongoose from "mongoose";

// TEST_MONGO_URI is resolved by tests/setup/globalSetup.ts: it either comes
// from your own .env.test, or — if you didn't set one — a disposable
// in-memory replica set is started once for the whole test run and its URI
// is written here. Either way, by the time any test file runs, it's set.
export const connectTestDB = async (): Promise<void> => {
  const uri = process.env.TEST_MONGO_URI || process.env.MONGO_URI;

  if (!uri) {
    throw new Error(
      "TEST_MONGO_URI is not set. This should have been set automatically by " +
        "tests/setup/globalSetup.ts — check that mongodb-memory-server installed " +
        "correctly, or set TEST_MONGO_URI/.env.test yourself (see .env.test.example).",
    );
  }

  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(uri);
  }
};

export const disconnectTestDB = async (): Promise<void> => {
  await mongoose.connection.close();
};

// Wipes every collection. Call this between tests (afterEach) so each test
// starts from a clean slate — scoped to whatever TEST_MONGO_URI points at,
// which should never be your dev/prod database.
export const clearTestDB = async (): Promise<void> => {
  // If connectTestDB() never succeeded, skip rather than let every test hang
  // for Mongoose's ~10s command-buffer timeout.
  if (mongoose.connection.readyState !== 1) return;

  const { collections } = mongoose.connection;

  await Promise.all(
    Object.values(collections).map((collection) => collection.deleteMany({})),
  );
};
