import http from "http";
import { AddressInfo } from "net";
import request from "supertest";
import { io as ioClient, Socket as ClientSocket } from "socket.io-client";
import createApp from "../../src/app";
import { initSocket } from "../../src/socket";
import { connectTestDB, disconnectTestDB, clearTestDB } from "../setup/db";
import { createUser, createContactConnection, generateToken } from "../setup/fixtures";

// Proves the actual wiring — a message sent over plain REST reaches a
// connected recipient's socket live — without re-testing anything the
// REST-only conversation.test.ts already covers (validation, permissions,
// unread counts, etc.). The socket layer itself has no business logic of
// its own to test beyond "does authentication work" and "does the push
// arrive."
const app = createApp();
let httpServer: http.Server;
let baseUrl: string;

beforeAll(async () => {
  await connectTestDB();
  httpServer = http.createServer(app);
  initSocket(httpServer);
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const { port } = httpServer.address() as AddressInfo;
  baseUrl = `http://localhost:${port}`;
});

afterEach(async () => {
  await clearTestDB();
});

afterAll(async () => {
  await disconnectTestDB();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

const connectClient = (token: string): Promise<ClientSocket> =>
  new Promise((resolve, reject) => {
    const socket = ioClient(baseUrl, { auth: { token }, transports: ["websocket"] });
    socket.on("connect", () => resolve(socket));
    socket.on("connect_error", (err) => reject(err));
  });

describe("Socket.IO chat delivery", () => {
  it("rejects a connection with no token", async () => {
    await expect(
      new Promise((resolve, reject) => {
        const socket = ioClient(baseUrl, { transports: ["websocket"] });
        socket.on("connect", () => reject(new Error("should not have connected")));
        socket.on("connect_error", resolve);
      }),
    ).resolves.toBeDefined();
  });

  it("rejects a connection with a garbled token", async () => {
    await expect(
      new Promise((resolve, reject) => {
        const socket = ioClient(baseUrl, {
          auth: { token: "garbled.token.value" },
          transports: ["websocket"],
        });
        socket.on("connect", () => reject(new Error("should not have connected")));
        socket.on("connect_error", resolve);
      }),
    ).resolves.toBeDefined();
  });

  it("pushes a message:new event to the recipient the instant it's sent over REST", async () => {
    const me = await createUser();
    const contact = await createUser();
    await createContactConnection(me, contact);

    const recipientSocket = await connectClient(generateToken(contact));

    const started = await request(app)
      .post("/api/conversations")
      .set("Authorization", `Bearer ${generateToken(me)}`)
      .send({ userId: contact.id });

    const received = new Promise((resolve) => {
      recipientSocket.on("message:new", resolve);
    });

    await request(app)
      .post(`/api/conversations/${started.body.id}/messages`)
      .set("Authorization", `Bearer ${generateToken(me)}`)
      .send({ body: "Live delivery check" });

    const message = (await received) as { body: string; sender: string };
    expect(message.body).toBe("Live delivery check");
    expect(message.sender).toBe(me.id);

    recipientSocket.disconnect();
  });

  it("never pushes to the sender's own room, only the other participant's", async () => {
    const me = await createUser();
    const contact = await createUser();
    await createContactConnection(me, contact);

    const senderSocket = await connectClient(generateToken(me));
    let receivedBySender = false;
    senderSocket.on("message:new", () => {
      receivedBySender = true;
    });

    const started = await request(app)
      .post("/api/conversations")
      .set("Authorization", `Bearer ${generateToken(me)}`)
      .send({ userId: contact.id });

    await request(app)
      .post(`/api/conversations/${started.body.id}/messages`)
      .set("Authorization", `Bearer ${generateToken(me)}`)
      .send({ body: "Only the other side should get a push" });

    // No event to wait on here on purpose — asserting a *lack* of delivery
    // needs a real pause, not a race against whichever happens first.
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(receivedBySender).toBe(false);
    senderSocket.disconnect();
  });
});
