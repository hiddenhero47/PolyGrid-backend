import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import {
  User,
  IUser,
  SYSTEM_ROLE,
  SystemRole,
  SUBSCRIPTION_STATUS,
} from "../../src/models/userModel";

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

export const createUserWithActiveSubscription = (
  overrides?: CreateUserOptions,
): Promise<IUser> =>
  createUser({
    subscription: {
      planTier: "pro",
      status: SUBSCRIPTION_STATUS.ACTIVE,
      currentPeriodStart: new Date(),
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      autoRenew: true,
    },
    ...overrides,
  });

// Matches userController.ts's generateToken exactly, so it's indistinguishable
// from a token issued by a real login.
export const generateToken = (user: IUser): string =>
  jwt.sign({ id: user._id, sessionId: user.sessionId }, process.env.JWT_SECRET as string, {
    expiresIn: "1d",
  });
