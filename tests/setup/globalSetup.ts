import "./env"; // loads .env.test (or .env fallback) into process.env
import { MongoMemoryReplSet } from "mongodb-memory-server";

declare global {
  // eslint-disable-next-line no-var
  var __MONGO_REPLSET__: MongoMemoryReplSet | undefined;
}

// Runs ONCE for the whole test run (not per file) — starting a fresh
// replica set per test file was unreliable and slow. If you've set
// TEST_MONGO_URI/MONGO_URI yourself (via .env.test), that takes priority
// and nothing gets spun up here.
export default async function globalSetup(): Promise<void> {
  if (process.env.TEST_MONGO_URI || process.env.MONGO_URI) {
    return;
  }

  const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });

  // globalSetup and globalTeardown run in the same process, so stashing the
  // instance on `global` here is how globalTeardown gets it back.
  global.__MONGO_REPLSET__ = replSet;
  process.env.TEST_MONGO_URI = replSet.getUri();
}
