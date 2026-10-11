import request from "supertest";
import createApp from "../../src/app";
import { connectTestDB, disconnectTestDB, clearTestDB } from "../setup/db";
import { createUser, generateToken } from "../setup/fixtures";
import { Notification, NOTIFICATION_TYPE } from "../../src/models/notificationModel";

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

describe("GET /api/notifications", () => {
  it("lists only my own notifications, newest first", async () => {
    const user = await createUser();
    const stranger = await createUser();

    await Notification.create({
      userId: user._id,
      type: NOTIFICATION_TYPE.JOB_STAGE_DONE,
      message: "First",
    });
    await Notification.create({
      userId: user._id,
      type: NOTIFICATION_TYPE.JOB_DISPUTE_RESOLVED,
      message: "Second",
    });
    await Notification.create({
      userId: stranger._id,
      type: NOTIFICATION_TYPE.JOB_STAGE_DONE,
      message: "Not mine",
    });

    const res = await request(app)
      .get("/api/notifications")
      .set("Authorization", `Bearer ${generateToken(user)}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0].message).toBe("Second");
    expect(res.body.pagination.total).toBe(2);
  });

  it("requires authentication", async () => {
    const res = await request(app).get("/api/notifications");
    expect(res.status).toBe(401);
  });
});

describe("GET /api/notifications/unread-count", () => {
  it("counts only unread notifications of mine", async () => {
    const user = await createUser();

    await Notification.create({
      userId: user._id,
      type: NOTIFICATION_TYPE.JOB_STAGE_DONE,
      message: "Unread one",
    });
    await Notification.create({
      userId: user._id,
      type: NOTIFICATION_TYPE.JOB_STAGE_DONE,
      message: "Already read",
      isRead: true,
    });

    const res = await request(app)
      .get("/api/notifications/unread-count")
      .set("Authorization", `Bearer ${generateToken(user)}`);

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
  });
});

describe("PATCH /api/notifications/:id/read", () => {
  it("marks my own notification read", async () => {
    const user = await createUser();
    const notification = await Notification.create({
      userId: user._id,
      type: NOTIFICATION_TYPE.JOB_STAGE_DONE,
      message: "Mark me",
    });

    const res = await request(app)
      .patch(`/api/notifications/${notification.id}/read`)
      .set("Authorization", `Bearer ${generateToken(user)}`);

    expect(res.status).toBe(200);
    expect(res.body.isRead).toBe(true);
  });

  it("404s on someone else's notification", async () => {
    const user = await createUser();
    const stranger = await createUser();
    const notification = await Notification.create({
      userId: stranger._id,
      type: NOTIFICATION_TYPE.JOB_STAGE_DONE,
      message: "Not yours",
    });

    const res = await request(app)
      .patch(`/api/notifications/${notification.id}/read`)
      .set("Authorization", `Bearer ${generateToken(user)}`);

    expect(res.status).toBe(404);
  });
});

describe("PATCH /api/notifications/read-all", () => {
  it("marks every one of my unread notifications read in one call", async () => {
    const user = await createUser();
    await Notification.create([
      { userId: user._id, type: NOTIFICATION_TYPE.JOB_STAGE_DONE, message: "A" },
      { userId: user._id, type: NOTIFICATION_TYPE.JOB_STAGE_DONE, message: "B" },
    ]);

    const res = await request(app)
      .patch("/api/notifications/read-all")
      .set("Authorization", `Bearer ${generateToken(user)}`);

    expect(res.status).toBe(200);

    const unreadCount = await request(app)
      .get("/api/notifications/unread-count")
      .set("Authorization", `Bearer ${generateToken(user)}`);
    expect(unreadCount.body.count).toBe(0);
  });
});
