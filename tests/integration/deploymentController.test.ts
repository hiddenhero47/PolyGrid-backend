// Calls the controller directly, bypassing the route/middleware layer —
// deliberately, not via supertest against the mounted route. The real
// route's open window is a literal date in routes/deploymentRoutes.ts
// (see middleware/timeWindowGuard.ts for why), which would make an
// HTTP-level test of "is it currently open" a ticking time bomb that
// silently starts failing once that window passes. timeWindowGuard
// itself already has exhaustive, time-independent coverage in
// tests/unit/timeWindowGuard.test.ts; this file only needs to prove the
// controller orchestrates its tasks and shapes its response correctly.
import { Response } from "express";
import { connectTestDB, disconnectTestDB, clearTestDB } from "../setup/db";
import { User, SYSTEM_ROLE } from "../../src/models/userModel";
import { VerificationTemplate } from "../../src/models/verificationTemplateModel";
import { PROFILE_TYPE } from "../../src/constants/profileTypes";
import { runDeploymentSetup } from "../../src/controllers/deploymentController";

const ENV_KEYS = ["SUPER_ADMIN_NAME", "SUPER_ADMIN_EMAIL", "SUPER_ADMIN_PASSWORD"] as const;
const savedEnv: Record<string, string | undefined> = {};

const mockRes = () => {
  const res: Partial<Response> = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as Response;
};

beforeAll(async () => {
  await connectTestDB();
});

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
});

afterEach(async () => {
  await clearTestDB();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

afterAll(async () => {
  await disconnectTestDB();
});

describe("runDeploymentSetup", () => {
  it("runs every setup task and reports overall success", async () => {
    process.env.SUPER_ADMIN_NAME = "Test Admin";
    process.env.SUPER_ADMIN_EMAIL = "controller-test-super-admin@example.com";
    process.env.SUPER_ADMIN_PASSWORD = "a-strong-password";

    const res = mockRes();
    await runDeploymentSetup({} as never, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(200);
    const payload = (res.json as jest.Mock).mock.calls[0][0];
    expect(payload.success).toBe(true);
    expect(payload.results).toHaveLength(2);
    expect(payload.results.every((r: { status: string }) => r.status === "success")).toBe(true);

    expect(await User.findOne({ systemRole: SYSTEM_ROLE.SUPER_ADMIN })).not.toBeNull();
    expect(await VerificationTemplate.countDocuments({ country: "NG", isActive: true })).toBe(
      Object.values(PROFILE_TYPE).length,
    );
  });

  it("reports overall failure (but still 200s, with per-task detail) when a task fails", async () => {
    delete process.env.SUPER_ADMIN_NAME;
    delete process.env.SUPER_ADMIN_EMAIL;
    delete process.env.SUPER_ADMIN_PASSWORD;

    const res = mockRes();
    await runDeploymentSetup({} as never, res, jest.fn());

    const payload = (res.json as jest.Mock).mock.calls[0][0];
    expect(payload.success).toBe(false);
    expect(payload.results.some((r: { status: string }) => r.status === "failed")).toBe(true);
    // The other task still ran independently.
    expect(await VerificationTemplate.countDocuments({ country: "NG", isActive: true })).toBe(
      Object.values(PROFILE_TYPE).length,
    );
  });

  it("is idempotent — calling it twice changes nothing the second time", async () => {
    process.env.SUPER_ADMIN_NAME = "Test Admin";
    process.env.SUPER_ADMIN_EMAIL = "controller-test-super-admin-2@example.com";
    process.env.SUPER_ADMIN_PASSWORD = "a-strong-password";

    await runDeploymentSetup({} as never, mockRes(), jest.fn());
    await runDeploymentSetup({} as never, mockRes(), jest.fn());

    expect(await User.countDocuments({ systemRole: SYSTEM_ROLE.SUPER_ADMIN })).toBe(1);
    expect(await VerificationTemplate.countDocuments({ country: "NG" })).toBe(Object.values(PROFILE_TYPE).length);
  });
});
