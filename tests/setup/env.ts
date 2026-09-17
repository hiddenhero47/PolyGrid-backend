import dotenv from "dotenv";
import path from "path";
import fs from "fs";

// Prefer .env.test (keeps the test DB/secrets separate from dev/prod) and
// fall back to the regular .env if it doesn't exist yet.
const testEnvPath = path.resolve(__dirname, "../../.env.test");

if (fs.existsSync(testEnvPath)) {
  dotenv.config({ path: testEnvPath, quiet: true });
} else {
  dotenv.config({ quiet: true });
}
