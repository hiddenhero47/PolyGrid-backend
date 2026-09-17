import { connectTestDB, disconnectTestDB, clearTestDB } from "../setup/db";
import { createUser, createUserWithActiveSubscription } from "../setup/fixtures";
import { requireActiveSubscription } from "../../src/middleware/authMiddleware";
import { SUBSCRIPTION_STATUS } from "../../src/models/userModel";
import { Request, Response, NextFunction } from "express";

beforeAll(async () => {
  await connectTestDB();
});

afterEach(async () => {
  await clearTestDB();
});

afterAll(async () => {
  await disconnectTestDB();
});

describe("User.hasActiveSubscription", () => {
  it("is false for a brand-new user (default subscription is expired)", async () => {
    const user = await createUser();
    expect(user.hasActiveSubscription()).toBe(false);
  });

  it("is true once status is active and expiresAt is in the future", async () => {
    const user = await createUserWithActiveSubscription();
    expect(user.hasActiveSubscription()).toBe(true);
  });

  it("is false once expiresAt has passed, even if status is still active", async () => {
    const user = await createUser({
      subscription: {
        planTier: "pro",
        status: SUBSCRIPTION_STATUS.ACTIVE,
        currentPeriodStart: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000),
        expiresAt: new Date(Date.now() - 1000),
        autoRenew: false,
      },
    });

    expect(user.hasActiveSubscription()).toBe(false);
  });
});

describe("requireActiveSubscription middleware", () => {
  const buildRes = () => ({}) as Response;
  const buildNext = (): NextFunction => jest.fn();

  it("calls next() for a user with an active subscription", async () => {
    const user = await createUserWithActiveSubscription();
    const req = { user } as Request;
    const next = buildNext();

    requireActiveSubscription(req, buildRes(), next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it("throws a 402 for a user without an active subscription", async () => {
    const user = await createUser();
    const req = { user } as unknown as Request;
    const next = buildNext();

    expect(() => requireActiveSubscription(req, buildRes(), next)).toThrow(
      /active PolyGrid subscription/i,
    );
    expect(next).not.toHaveBeenCalled();
  });
});
