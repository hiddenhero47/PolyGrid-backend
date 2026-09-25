import fs from "fs";
import path from "path";

export default async function globalTeardown(): Promise<void> {
  if (global.__MONGO_REPLSET__) {
    await global.__MONGO_REPLSET__.stop();
  }

  // Removes whatever tests/integration/mediaFile.test.ts wrote to disk via
  // STORAGE_ROOT (see .env.test.example) — run once for the whole suite
  // rather than per-file so tests can still run in parallel-safe isolation
  // without racing to delete each other's files mid-run.
  if (process.env.STORAGE_ROOT) {
    await fs.promises.rm(path.resolve(process.env.STORAGE_ROOT), {
      recursive: true,
      force: true,
    });
  }
}
