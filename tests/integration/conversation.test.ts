import request from "supertest";
import createApp from "../../src/app";
import { connectTestDB, disconnectTestDB, clearTestDB } from "../setup/db";
import {
  createUser,
  createAdmin,
  createContactConnection,
  generateToken,
} from "../setup/fixtures";
import { Conversation } from "../../src/models/conversationModel";
import { Message } from "../../src/models/messageModel";

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

describe("POST /api/conversations", () => {
  it("requires authentication", async () => {
    const res = await request(app).post("/api/conversations").send({});
    expect(res.status).toBe(401);
  });

  it("blocks starting a conversation with someone who isn't a contact", async () => {
    const me = await createUser();
    const stranger = await createUser();

    const res = await request(app)
      .post("/api/conversations")
      .set("Authorization", `Bearer ${generateToken(me)}`)
      .send({ userId: stranger.id });

    expect(res.status).toBe(403);
  });

  it("404s for an unknown userId", async () => {
    const me = await createUser();

    const res = await request(app)
      .post("/api/conversations")
      .set("Authorization", `Bearer ${generateToken(me)}`)
      .send({ userId: "507f1f77bcf86cd799439011" });

    expect(res.status).toBe(404);
  });

  it("rejects starting a conversation with yourself", async () => {
    const me = await createUser();

    const res = await request(app)
      .post("/api/conversations")
      .set("Authorization", `Bearer ${generateToken(me)}`)
      .send({ userId: me.id });

    expect(res.status).toBe(400);
  });

  it("starts a conversation with a connected contact", async () => {
    const me = await createUser();
    const contact = await createUser();
    await createContactConnection(me, contact);

    const res = await request(app)
      .post("/api/conversations")
      .set("Authorization", `Bearer ${generateToken(me)}`)
      .send({ userId: contact.id });

    expect(res.status).toBe(200);
    expect(res.body.otherParticipant.id).toBe(contact.id);
    expect(res.body.unreadCount).toBe(0);
  });

  it("returns the same conversation on a second call, from either side, instead of creating a duplicate", async () => {
    const me = await createUser();
    const contact = await createUser();
    await createContactConnection(me, contact);

    const first = await request(app)
      .post("/api/conversations")
      .set("Authorization", `Bearer ${generateToken(me)}`)
      .send({ userId: contact.id });

    const second = await request(app)
      .post("/api/conversations")
      .set("Authorization", `Bearer ${generateToken(contact)}`)
      .send({ userId: me.id });

    expect(second.body.id).toBe(first.body.id);
    expect(await Conversation.countDocuments()).toBe(1);
  });
});

describe("messaging within a conversation", () => {
  const setupConversation = async () => {
    const me = await createUser();
    const contact = await createUser();
    await createContactConnection(me, contact);
    const token = generateToken(me);

    const started = await request(app)
      .post("/api/conversations")
      .set("Authorization", `Bearer ${token}`)
      .send({ userId: contact.id });

    return { me, contact, conversationId: started.body.id as string };
  };

  it("requires a non-empty body", async () => {
    const { me, conversationId } = await setupConversation();

    const res = await request(app)
      .post(`/api/conversations/${conversationId}/messages`)
      .set("Authorization", `Bearer ${generateToken(me)}`)
      .send({ body: "   " });

    expect(res.status).toBe(400);
  });

  it("sends a message, updates the conversation's lastMessage fields, and a stranger 404s the same conversation id", async () => {
    const { me, contact, conversationId } = await setupConversation();
    const stranger = await createUser();

    const res = await request(app)
      .post(`/api/conversations/${conversationId}/messages`)
      .set("Authorization", `Bearer ${generateToken(me)}`)
      .send({ body: "Hey, about the job — " });

    expect(res.status).toBe(201);
    expect(res.body.body).toBe("Hey, about the job —");
    expect(res.body.sender).toBe(me.id);

    const conversation = await Conversation.findById(conversationId);
    expect(conversation?.lastMessagePreview).toBe("Hey, about the job —");
    expect(conversation?.lastMessageAt).toBeTruthy();

    const strangerRes = await request(app)
      .get(`/api/conversations/${conversationId}/messages`)
      .set("Authorization", `Bearer ${generateToken(stranger)}`);
    expect(strangerRes.status).toBe(404);

    const contactRes = await request(app)
      .get(`/api/conversations/${conversationId}/messages`)
      .set("Authorization", `Bearer ${generateToken(contact)}`);
    expect(contactRes.status).toBe(200);
    expect(contactRes.body.data).toHaveLength(1);
  });

  it("counts unread messages for the recipient and clears them after marking read", async () => {
    const { me, contact, conversationId } = await setupConversation();
    const meToken = generateToken(me);
    const contactToken = generateToken(contact);

    await request(app)
      .post(`/api/conversations/${conversationId}/messages`)
      .set("Authorization", `Bearer ${meToken}`)
      .send({ body: "First message" });
    await request(app)
      .post(`/api/conversations/${conversationId}/messages`)
      .set("Authorization", `Bearer ${meToken}`)
      .send({ body: "Second message" });

    const list = await request(app)
      .get("/api/conversations")
      .set("Authorization", `Bearer ${contactToken}`);
    expect(list.body.data[0].unreadCount).toBe(2);

    await request(app)
      .patch(`/api/conversations/${conversationId}/read`)
      .set("Authorization", `Bearer ${contactToken}`);

    const listAfter = await request(app)
      .get("/api/conversations")
      .set("Authorization", `Bearer ${contactToken}`);
    expect(listAfter.body.data[0].unreadCount).toBe(0);

    // My own sent messages never count as unread for me.
    const myList = await request(app)
      .get("/api/conversations")
      .set("Authorization", `Bearer ${meToken}`);
    expect(myList.body.data[0].unreadCount).toBe(0);
  });
});

describe("POST /api/messages/:id/report and GET /api/messages/reports", () => {
  it("requires a reason", async () => {
    const me = await createUser();
    const contact = await createUser();
    await createContactConnection(me, contact);
    const token = generateToken(me);

    const started = await request(app)
      .post("/api/conversations")
      .set("Authorization", `Bearer ${token}`)
      .send({ userId: contact.id });
    const sent = await request(app)
      .post(`/api/conversations/${started.body.id}/messages`)
      .set("Authorization", `Bearer ${token}`)
      .send({ body: "hi" });

    const res = await request(app)
      .post(`/api/messages/${sent.body._id}/report`)
      .set("Authorization", `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(400);
  });

  it("blocks reporting a message from a conversation I'm not part of", async () => {
    const me = await createUser();
    const contact = await createUser();
    const stranger = await createUser();
    await createContactConnection(me, contact);
    const token = generateToken(me);

    const started = await request(app)
      .post("/api/conversations")
      .set("Authorization", `Bearer ${token}`)
      .send({ userId: contact.id });
    const sent = await request(app)
      .post(`/api/conversations/${started.body.id}/messages`)
      .set("Authorization", `Bearer ${token}`)
      .send({ body: "hi" });

    const res = await request(app)
      .post(`/api/messages/${sent.body._id}/report`)
      .set("Authorization", `Bearer ${generateToken(stranger)}`)
      .send({ reason: "spam" });

    expect(res.status).toBe(404);
  });

  it("lets a participant report a message, and an admin lists it", async () => {
    const me = await createUser();
    const contact = await createUser();
    await createContactConnection(me, contact);
    const token = generateToken(me);
    const admin = await createAdmin();

    const started = await request(app)
      .post("/api/conversations")
      .set("Authorization", `Bearer ${token}`)
      .send({ userId: contact.id });
    const sent = await request(app)
      .post(`/api/conversations/${started.body.id}/messages`)
      .set("Authorization", `Bearer ${token}`)
      .send({ body: "something reportable" });

    const reportRes = await request(app)
      .post(`/api/messages/${sent.body._id}/report`)
      .set("Authorization", `Bearer ${generateToken(contact)}`)
      .send({ reason: "This felt harassing" });
    expect(reportRes.status).toBe(201);

    const nonAdmin = await request(app)
      .get("/api/messages/reports")
      .set("Authorization", `Bearer ${token}`);
    expect(nonAdmin.status).toBe(401);

    const adminRes = await request(app)
      .get("/api/messages/reports")
      .set("Authorization", `Bearer ${generateToken(admin)}`);
    expect(adminRes.status).toBe(200);
    expect(adminRes.body.data).toHaveLength(1);
    expect(adminRes.body.data[0].reason).toBe("This felt harassing");

    expect(await Message.countDocuments()).toBe(1); // reporting never deletes the message
  });
});
