import { Request, Response } from "express";
import { connectTestDB, disconnectTestDB, clearTestDB } from "../setup/db";
import {
  createUser,
  createUserWithActiveSubscription,
  createSubscription,
} from "../setup/fixtures";
import {
  attachCurrentPlan,
  requireActiveSubscription,
} from "../../src/middleware/authMiddleware";
import { SUBSCRIPTION_STATUS } from "../../src/models/subscriptionModel";
import { getCarryoverDays, DAY_MS } from "../../src/helpers/profileSubscriptionSync";

beforeAll(async () => {
  await connectTestDB();
});

afterEach(async () => {
  await clearTestDB();
});

afterAll(async () => {
  await disconnectTestDB();
});

describe("Subscription.isActive", () => {
  it("is true once status is active and expiresAt is in the future", async () => {
    const user = await createUser();
    const subscription = await createSubscription({ user });

    expect(subscription.isActive()).toBe(true);
  });

  it("is false once expiresAt has passed, even if status is still active", async () => {
    const user = await createUser();
    const subscription = await createSubscription({
      user,
      status: SUBSCRIPTION_STATUS.ACTIVE,
      expiresAt: new Date(Date.now() - 1000),
    });

    expect(subscription.isActive()).toBe(false);
  });

  it("is false once status is canceled, even if expiresAt is in the future", async () => {
    const user = await createUser();
    const subscription = await createSubscription({
      user,
      status: SUBSCRIPTION_STATUS.CANCELED,
    });

    expect(subscription.isActive()).toBe(false);
  });
});

describe("getCarryoverDays", () => {
  it("returns 0 for a user who has never subscribed", async () => {
    const user = await createUser();
    expect(await getCarryoverDays(user.id)).toBe(0);
  });

  it("returns 0 once the subscription has already expired", async () => {
    const user = await createUser();
    await createSubscription({ user, expiresAt: new Date(Date.now() - 1000) });
    expect(await getCarryoverDays(user.id)).toBe(0);
  });

  it("returns 0 for a canceled subscription, even with time left on its clock", async () => {
    const user = await createUser();
    await createSubscription({
      user,
      status: SUBSCRIPTION_STATUS.CANCELED,
      expiresAt: new Date(Date.now() + 5 * DAY_MS),
    });
    expect(await getCarryoverDays(user.id)).toBe(0);
  });

  it("floors to whole days — never rounds a partial day up", async () => {
    const user = await createUser();
    // 5 days + 20 hours left: floor must read as 5, not 6.
    await createSubscription({ user, expiresAt: new Date(Date.now() + 5 * DAY_MS + 20 * 60 * 60 * 1000) });
    expect(await getCarryoverDays(user.id)).toBe(5);
  });

  it("returns 0 for well under a day left, not a free day from rounding", async () => {
    const user = await createUser();
    await createSubscription({ user, expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000) }); // 2 hours
    expect(await getCarryoverDays(user.id)).toBe(0);
  });
});

describe("attachCurrentPlan middleware", () => {
  const buildRes = () => ({}) as Response;

  it("attaches the user's current Subscription", async () => {
    const user = await createUserWithActiveSubscription();
    const req = { user } as Request;
    const next = jest.fn();

    await attachCurrentPlan(req, buildRes(), next);

    expect(req.currentPlan).toBeTruthy();
    expect(req.currentPlan?.planTier).toBe("pro");
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("attaches null for a user who has never subscribed", async () => {
    const user = await createUser();
    const req = { user } as Request;
    const next = jest.fn();

    await attachCurrentPlan(req, buildRes(), next);

    expect(req.currentPlan).toBeNull();
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe("requireActiveSubscription middleware", () => {
  const buildRes = () => ({}) as Response;

  it("calls next() with no error for a user with an active subscription", async () => {
    const user = await createUserWithActiveSubscription();
    const req = { user } as Request;
    const next = jest.fn();

    await requireActiveSubscription(req, buildRes(), next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith();
  });

  it("calls next(error) with a 402 for a user who has never subscribed", async () => {
    const user = await createUser();
    const req = { user } as Request;
    const next = jest.fn();

    await requireActiveSubscription(req, buildRes(), next);

    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0];
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/active PolyGrid subscription/i);
    expect(err.statusCode).toBe(402);
  });

  it("calls next(error) for a user whose subscription has expired", async () => {
    const user = await createUser();
    await createSubscription({ user, expiresAt: new Date(Date.now() - 1000) });
    const req = { user } as Request;
    const next = jest.fn();

    await requireActiveSubscription(req, buildRes(), next);

    const err = next.mock.calls[0][0];
    expect(err.statusCode).toBe(402);
  });
});
