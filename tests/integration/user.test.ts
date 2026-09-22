import request from "supertest";
import createApp from "../../src/app";
import { connectTestDB, disconnectTestDB, clearTestDB } from "../setup/db";
import { createUser, createSuperAdmin, generateToken, TEST_PNG_BUFFER } from "../setup/fixtures";
import { SYSTEM_ROLE, ACCOUNT_TYPE } from "../../src/models/userModel";
import bcrypt from "bcryptjs";

const app = createApp();

beforeAll(async () => {
  await connectTestDB();
});

afterEach(async () => {
  await clearTestDB();
});

afterAll(async () => {
  await disconnectTestDB();
});

describe("POST /api/users (register)", () => {
  it("registers a new user and returns a usable token", async () => {
    const res = await request(app)
      .post("/api/users")
      .send({ fullName: "Jane Doe", email: "jane@example.com", password: "password123" });

    expect(res.status).toBe(201);
    expect(res.body.systemRole).toBe(SYSTEM_ROLE.USER);
    expect(res.body.activeAccountType).toBe(ACCOUNT_TYPE.NORMAL);
    expect(res.body.token).toEqual(expect.any(String));

    const me = await request(app)
      .get("/api/users/me")
      .set("Authorization", `Bearer ${res.body.token}`);

    expect(me.status).toBe(200);
    expect(me.body.email).toBe("jane@example.com");
  });

  it("rejects a duplicate email", async () => {
    await createUser({ email: "dupe@example.com" });

    const res = await request(app)
      .post("/api/users")
      .send({ fullName: "Jane", email: "dupe@example.com", password: "password123" });

    expect(res.status).toBe(400);
  });

  it("rejects missing fields", async () => {
    const res = await request(app).post("/api/users").send({ email: "x@example.com" });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/users/login", () => {
  it("logs in with correct credentials", async () => {
    const password = "password123";
    const user = await createUser({ password: await bcrypt.hash(password, 4) });

    const res = await request(app)
      .post("/api/users/login")
      .send({ email: user.email, password });

    expect(res.status).toBe(200);
    expect(res.body.token).toEqual(expect.any(String));
  });

  it("rejects a wrong password", async () => {
    const user = await createUser();

    const res = await request(app)
      .post("/api/users/login")
      .send({ email: user.email, password: "wrong-password" });

    expect(res.status).toBe(400);
  });
});

describe("PUT /api/users/profile", () => {
  it("updates fullName/phoneNumber", async () => {
    const user = await createUser();
    const token = generateToken(user);

    const res = await request(app)
      .put("/api/users/profile")
      .set("Authorization", `Bearer ${token}`)
      .send({
        fullName: "New Name",
        phoneNumber: { number: "+2348012345678", country: "NG" },
      });

    expect(res.status).toBe(200);
    expect(res.body.user.fullName).toBe("New Name");
    expect(res.body.user.phoneNumber).toEqual({
      number: "+2348012345678",
      country: "NG",
    });
  });

  it("uploads a public avatar", async () => {
    const user = await createUser();

    const res = await request(app)
      .put("/api/users/profile")
      .set("Authorization", `Bearer ${generateToken(user)}`)
      .attach("file", TEST_PNG_BUFFER, "avatar.png");

    expect(res.status).toBe(200);
    expect(res.body.user.avatar.fileName).toEqual(expect.any(String));
    expect(res.body.user.avatar.url).toContain("/public/");
    expect(res.body.user.avatar.storagePath).toBeUndefined(); // internal only
  });

  it("does not fail the whole update when the attached file is invalid — it's one optional field among several", async () => {
    const user = await createUser();

    const res = await request(app)
      .put("/api/users/profile")
      .set("Authorization", `Bearer ${generateToken(user)}`)
      .field("fullName", "Still Updates")
      .attach("file", Buffer.from("not a real image"), "avatar.png");

    expect(res.status).toBe(200);
    expect(res.body.user.fullName).toBe("Still Updates");
    expect(res.body.user.avatar).toBeUndefined();
    expect(res.body.avatarWarnings).toEqual(expect.arrayContaining([expect.any(String)]));
  });

  it("deletes the previous avatar file when replaced", async () => {
    const user = await createUser();
    const token = generateToken(user);

    const first = await request(app)
      .put("/api/users/profile")
      .set("Authorization", `Bearer ${token}`)
      .attach("file", TEST_PNG_BUFFER, "avatar.png");
    const firstUrl = first.body.user.avatar.url as string;
    const firstPath = new URL(firstUrl).pathname;

    const second = await request(app)
      .put("/api/users/profile")
      .set("Authorization", `Bearer ${token}`)
      .attach("file", TEST_PNG_BUFFER, "avatar2.png");
    expect(second.status).toBe(200);

    const staleFetch = await request(app).get(firstPath);
    expect(staleFetch.status).toBe(404);
  });

  it("rejects a phoneNumber missing both number and country", async () => {
    const user = await createUser();
    const token = generateToken(user);

    const res = await request(app)
      .put("/api/users/profile")
      .set("Authorization", `Bearer ${token}`)
      .send({ phoneNumber: {} });

    expect(res.status).toBe(400);
  });

  it("changes password and invalidates the old session", async () => {
    const password = "password123";
    const user = await createUser({ password: await bcrypt.hash(password, 4) });
    const token = generateToken(user);

    const res = await request(app)
      .put("/api/users/profile")
      .set("Authorization", `Bearer ${token}`)
      .send({ oldPassword: password, password: "newpassword456" });

    expect(res.status).toBe(200);

    // The token issued before the password change must now be rejected.
    const staleAttempt = await request(app)
      .get("/api/users/me")
      .set("Authorization", `Bearer ${token}`);
    expect(staleAttempt.status).toBe(401);

    const loginRes = await request(app)
      .post("/api/users/login")
      .send({ email: user.email, password: "newpassword456" });
    expect(loginRes.status).toBe(200);
  });

  it("rejects a password change without the correct old password", async () => {
    const user = await createUser();
    const token = generateToken(user);

    const res = await request(app)
      .put("/api/users/profile")
      .set("Authorization", `Bearer ${token}`)
      .send({ oldPassword: "wrong", password: "newpassword456" });

    expect(res.status).toBe(400);
  });
});

describe("PATCH /api/users/account-type", () => {
  it("toggles between normal and business", async () => {
    const user = await createUser();
    const token = generateToken(user);

    const first = await request(app)
      .patch("/api/users/account-type")
      .set("Authorization", `Bearer ${token}`)
      .send({});
    expect(first.status).toBe(200);
    expect(first.body.activeAccountType).toBe(ACCOUNT_TYPE.BUSINESS);

    const second = await request(app)
      .patch("/api/users/account-type")
      .set("Authorization", `Bearer ${token}`)
      .send({});
    expect(second.body.activeAccountType).toBe(ACCOUNT_TYPE.NORMAL);
  });

  it("sets an explicit target type", async () => {
    const user = await createUser();
    const token = generateToken(user);

    const res = await request(app)
      .patch("/api/users/account-type")
      .set("Authorization", `Bearer ${token}`)
      .send({ activeAccountType: ACCOUNT_TYPE.BUSINESS });

    expect(res.body.activeAccountType).toBe(ACCOUNT_TYPE.BUSINESS);
  });
});

describe("PATCH /api/users/invalidate", () => {
  it("logs out of every session", async () => {
    const user = await createUser();
    const token = generateToken(user);

    const res = await request(app)
      .patch("/api/users/invalidate")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);

    const stale = await request(app)
      .get("/api/users/me")
      .set("Authorization", `Bearer ${token}`);
    expect(stale.status).toBe(401);
  });
});

describe("password reset flow", () => {
  it("requests a reset token then resets the password", async () => {
    const user = await createUser();

    const requestRes = await request(app)
      .post("/api/users/request-reset")
      .send({ email: user.email });
    expect(requestRes.status).toBe(200);
    expect(requestRes.body.token).toEqual(expect.any(String));

    const resetRes = await request(app)
      .post("/api/users/reset-password")
      .send({ token: requestRes.body.token, password: "brandNewPassword1" });
    expect(resetRes.status).toBe(200);

    const loginRes = await request(app)
      .post("/api/users/login")
      .send({ email: user.email, password: "brandNewPassword1" });
    expect(loginRes.status).toBe(200);
  });

  it("does not reveal whether an account exists", async () => {
    const res = await request(app)
      .post("/api/users/request-reset")
      .send({ email: "nobody@example.com" });

    expect(res.status).toBe(200);
    expect(res.body.token).toBeUndefined();
  });

  it("rejects an invalid reset token", async () => {
    const res = await request(app)
      .post("/api/users/reset-password")
      .send({ token: "not-a-real-token", password: "whatever123" });

    expect(res.status).toBe(400);
  });
});

describe("admin-only user management", () => {
  it("blocks a basic user from creating an admin", async () => {
    const user = await createUser();
    const token = generateToken(user);

    const res = await request(app)
      .post("/api/users/admin-create")
      .set("Authorization", `Bearer ${token}`)
      .send({ fullName: "New Admin", email: "admin@example.com", password: "password123" });

    expect(res.status).toBe(401);
  });

  it("lets a super admin create an admin", async () => {
    const superAdmin = await createSuperAdmin();
    const token = generateToken(superAdmin);

    const res = await request(app)
      .post("/api/users/admin-create")
      .set("Authorization", `Bearer ${token}`)
      .send({ fullName: "New Admin", email: "admin@example.com", password: "password123" });

    expect(res.status).toBe(201);
    expect(res.body.systemRole).toBe(SYSTEM_ROLE.ADMIN);
  });

  it("lists users with pagination", async () => {
    const superAdmin = await createSuperAdmin();
    const token = generateToken(superAdmin);
    await createUser();
    await createUser();

    const res = await request(app)
      .get("/api/users?limit=2")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeLessThanOrEqual(2);
    expect(res.body.pagination.total).toBeGreaterThanOrEqual(3);
  });

  it("changes a user's role", async () => {
    const superAdmin = await createSuperAdmin();
    const token = generateToken(superAdmin);
    const user = await createUser();

    const res = await request(app)
      .patch(`/api/users/${user.id}/role`)
      .set("Authorization", `Bearer ${token}`)
      .send({ systemRole: SYSTEM_ROLE.ADMIN });

    expect(res.status).toBe(200);
    expect(res.body.user.systemRole).toBe(SYSTEM_ROLE.ADMIN);
  });

  it("prevents modifying the Super Admin's own role", async () => {
    const superAdmin = await createSuperAdmin();
    const token = generateToken(superAdmin);

    const res = await request(app)
      .patch(`/api/users/${superAdmin.id}/role`)
      .set("Authorization", `Bearer ${token}`)
      .send({ systemRole: SYSTEM_ROLE.ADMIN });

    expect(res.status).toBe(400);
  });
});
