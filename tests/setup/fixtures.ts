import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { Request } from "express";
import { User, IUser, SYSTEM_ROLE, SystemRole } from "../../src/models/userModel";
import { Plan, IPlan, PLAN_TIER, PlanTier } from "../../src/models/planModel";
import {
  Subscription,
  ISubscription,
  SUBSCRIPTION_STATUS,
  SubscriptionStatus,
} from "../../src/models/subscriptionModel";
import { FileGrant } from "../../src/models/fileGrantModel";
import { Job, IJob, JOB_STATUS } from "../../src/models/jobModel";
import { uploadHandler, FILE_VISIBILITY, SavedFileInfo } from "../../src/helpers/fileStorage";

let counter = 0;
const next = (): number => {
  counter += 1;
  return counter;
};

interface CreateUserOptions {
  systemRole?: SystemRole;
  [key: string]: unknown;
}

export const createUser = async ({
  systemRole = SYSTEM_ROLE.USER,
  ...overrides
}: CreateUserOptions = {}): Promise<IUser> => {
  const n = next();

  const user = new User({
    fullName: `Test User ${n}`,
    email: `test.user.${n}.${Date.now()}@example.com`,
    password: await bcrypt.hash("password123", 4),
    systemRole,
    ...overrides,
  });

  if (systemRole === SYSTEM_ROLE.ADMIN || systemRole === SYSTEM_ROLE.SUPER_ADMIN) {
    user._adminCreation = true; // required by userModel's pre-save guard
  }

  await user.save();

  return user;
};

export const createAdmin = (overrides?: CreateUserOptions): Promise<IUser> =>
  createUser({ systemRole: SYSTEM_ROLE.ADMIN, ...overrides });

export const createSuperAdmin = (overrides?: CreateUserOptions): Promise<IUser> =>
  createUser({ systemRole: SYSTEM_ROLE.SUPER_ADMIN, ...overrides });

interface CreatePlanOptions {
  planTier?: PlanTier;
  [key: string]: unknown;
}

// Note: Plan.planTier is unique — pass a distinct `planTier` if a single
// test needs more than one plan alive at once.
export const createPlan = async ({
  planTier = PLAN_TIER.PRO,
  ...overrides
}: CreatePlanOptions = {}): Promise<IPlan> => {
  const n = next();

  return Plan.create({
    planTier,
    name: `Test Plan ${n}`,
    privileges: ["engineering.consultant.access", "store.sell.physical"],
    duration: 30,
    price: 20,
    ...overrides,
  });
};

interface CreateSubscriptionOptions {
  user: IUser;
  plan?: IPlan;
  status?: SubscriptionStatus;
  expiresAt?: Date;
  [key: string]: unknown;
}

// Creates a Subscription for `user` and points user.currentSubscription at
// it, exactly like subscriptionController.ts's grantSubscription does.
export const createSubscription = async ({
  user,
  plan,
  status = SUBSCRIPTION_STATUS.ACTIVE,
  expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
  ...overrides
}: CreateSubscriptionOptions): Promise<ISubscription> => {
  // Plan.planTier is unique, so reuse the default PRO plan across repeated
  // calls in the same test rather than trying to create it again.
  const resolvedPlan =
    plan || (await Plan.findOne({ planTier: PLAN_TIER.PRO })) || (await createPlan());

  // Defaults periodStarted to "now", but when a test passes an `expiresAt`
  // already in the past (to simulate an already-expired subscription),
  // backdate it so it still satisfies the schema's periodStarted < expiresAt
  // validator. Explicit `periodStarted` in overrides always wins.
  const periodStarted = new Date(
    Math.min(Date.now(), expiresAt.getTime() - 24 * 60 * 60 * 1000),
  );

  const subscription = await Subscription.create({
    user: user._id,
    plan: resolvedPlan._id,
    planTier: resolvedPlan.planTier,
    privileges: resolvedPlan.privileges,
    status,
    periodStarted,
    expiresAt,
    ...overrides,
  });

  user.currentSubscription = subscription._id as mongoose.Types.ObjectId;
  await user.save();

  return subscription;
};

export const createUserWithActiveSubscription = async (
  userOverrides?: CreateUserOptions,
): Promise<IUser> => {
  const user = await createUser(userOverrides);
  await createSubscription({ user });
  return user;
};

// Matches userController.ts's generateToken exactly, so it's indistinguishable
// from a token issued by a real login.
export const generateToken = (user: IUser): string =>
  jwt.sign({ id: user._id, sessionId: user.sessionId }, process.env.JWT_SECRET as string, {
    expiresIn: "1d",
  });

// A real (tiny, valid) 1x1 transparent PNG — needed anywhere code validates
// file type by magic bytes (src/helpers/fileSignature.ts), not just by
// extension/declared mimetype. Fully local, no network involved.
export const TEST_PNG_BASE64 =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

export const TEST_PNG_BUFFER = Buffer.from(
  TEST_PNG_BASE64.split("base64,")[1],
  "base64",
);

interface CreatePrivateFileOptions {
  uploader: IUser;
  allowedUsers?: IUser[];
}

// Goes through the real uploadHandler (same path fileController.uploadPrivateFile
// uses) with a synthetic request, so fixtures stay honest about what
// actually lands on disk — a FileGrant is only written when allowedUsers is
// non-empty, matching the controller's "no shares, no DB record" rule.
export const createPrivateFile = async ({
  uploader,
  allowedUsers = [],
}: CreatePrivateFileOptions): Promise<SavedFileInfo> => {
  const fakeReq = {
    files: [{ buffer: TEST_PNG_BUFFER, originalname: "private-test.png" }],
    body: {},
  } as unknown as Request;

  const { results } = await uploadHandler({
    req: fakeReq,
    visibility: FILE_VISIBILITY.PRIVATE,
    ownerId: uploader.id,
  });
  const saved = results[0];

  if (allowedUsers.length > 0) {
    await FileGrant.create({
      ownerId: uploader._id,
      fileName: saved.fileName,
      allowedUsers: allowedUsers.map((u) => u._id),
    });
  }

  return saved;
};

interface CreateActiveJobOptions {
  client: IUser;
  provider: IUser;
  [key: string]: unknown;
}

// Direct DB insert, not through the real create+confirm HTTP flow —
// job.test.ts has its own HTTP-driven version of this (it's testing that
// flow itself); this one is for tests elsewhere (e.g. payment.test.ts) that
// just need an active job to act on, without re-exercising creation logic
// already covered there.
export const createActiveJob = async ({
  client,
  provider,
  ...overrides
}: CreateActiveJobOptions): Promise<IJob> => {
  const n = next();

  return Job.create({
    jobTitle: `Test Job ${n}`,
    jobDescription: "Test job description",
    createdBy: client._id,
    client: { userId: client._id, isConfirmed: true },
    provider: { userId: provider._id, isConfirmed: true },
    stages: [{ details: [], payment: 100 }],
    totalAmount: 1000,
    platformFeePercent: 5,
    status: JOB_STATUS.ACTIVE,
    ...overrides,
  });
};
