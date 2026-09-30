import { Server as HttpServer } from "http";
import { Server as SocketIOServer, Socket } from "socket.io";
import { getAuthenticatedUser } from "../middleware/authMiddleware";
import { ALLOWED_ORIGINS } from "../middleware/corsMiddleware";

// Deliberately thin: this layer's only job is authenticating a connecting
// socket and putting it in a room for its user. It never receives chat
// business events from the client and has no message-sending logic of its
// own — sending a message is a normal REST call
// (POST /api/conversations/:id/messages, see conversationController.ts),
// exactly like every other write in this app. That controller calls
// emitToUser() below, once, after a message is actually persisted. Keeping
// all the validation/authorization/persistence on the REST side means the
// socket layer doesn't duplicate any of it — it just pushes what already
// happened to whichever of the two participants is currently connected.
let io: SocketIOServer | undefined;

export const initSocket = (httpServer: HttpServer): SocketIOServer => {
  io = new SocketIOServer(httpServer, {
    cors: { origin: ALLOWED_ORIGINS, credentials: true },
  });

  // The same token a normal request sends as `Authorization: Bearer …`,
  // sent once at connect time instead (`io(url, { auth: { token } })`) —
  // verified through the exact same getAuthenticatedUser check `protect`
  // uses, so a socket connection is never a looser trust boundary than an
  // HTTP request.
  io.use(async (socket: Socket, next) => {
    try {
      const token = socket.handshake.auth?.token as string | undefined;
      if (!token) throw new Error("Not authorized, no token!");

      const user = await getAuthenticatedUser(token);
      socket.data.userId = user.id as string;
      next();
    } catch {
      next(new Error("Not authorized"));
    }
  });

  io.on("connection", (socket: Socket) => {
    // One room per user, not per socket — a user with several open tabs/
    // devices gets the same message pushed to all of them, and the
    // controller emitting a message never needs to know how many
    // connections a recipient currently has, or whether they have any.
    socket.join(`user:${socket.data.userId as string}`);
  });

  return io;
};

// Never throws if nobody's connected — pushing a live update is always a
// best-effort addition on top of the message already being persisted via
// REST, never something a request's success depends on.
export const emitToUser = (userId: string, event: string, payload: unknown): void => {
  io?.to(`user:${userId}`).emit(event, payload);
};
