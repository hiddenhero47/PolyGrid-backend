import mongoose from "mongoose";
import { Notification, NotificationType } from "../models/notificationModel";
import { emitToUser } from "../socket";

// Persists the notification, then pushes it live over the socket if the
// recipient happens to be connected — same "the write already happened,
// the push is just a best-effort bonus on top" order
// conversationController.ts's message:new already uses. Never throws: a
// notification is always a side effect of some other action (a tender
// award, a verification decision, …) and must never be able to fail that
// action's own request.
export const notify = async (
  userId: mongoose.Types.ObjectId | string,
  type: NotificationType,
  message: string,
  data?: Record<string, unknown>,
): Promise<void> => {
  try {
    const notification = await Notification.create({ userId, type, message, data });
    emitToUser(userId.toString(), "notification:new", notification);
  } catch (err) {
    console.error("Failed to create notification", err);
  }
};
