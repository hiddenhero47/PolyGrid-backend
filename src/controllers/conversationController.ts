import mongoose from "mongoose";
import asyncHandler from "express-async-handler";
import { Request, Response } from "express";
import { Conversation, IConversation, sortParticipants } from "../models/conversationModel";
import { Message, IMessage } from "../models/messageModel";
import { MessageReport } from "../models/messageReportModel";
import { Contact } from "../models/contactModel";
import { User, IUser } from "../models/userModel";
import { emitToUser } from "../socket";

const paginationParams = (req: Request) => {
  const page = Math.max(Number(req.query.page) || 1, 1);
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  return { page, limit, skip: (page - 1) * limit };
};

const PREVIEW_LENGTH = 140;

// Chat piggybacks on an existing Contact connection rather than being an
// open channel to any registered user — same "counterparty must already be
// known to you" instinct Jobs already enforces.
const areContacts = async (userId: string, otherUserId: string): Promise<boolean> =>
  !!(await Contact.exists({ userId, "list.user": otherUserId }));

// A conversation looked up by id that either doesn't exist or isn't mine
// is treated identically (404) — never 403 — so probing a guessed/foreign
// id can't confirm a conversation exists between two other people.
const loadMyConversation = async (
  conversationId: string,
  requesterId: string,
): Promise<IConversation | null> => {
  if (!mongoose.Types.ObjectId.isValid(conversationId)) return null;

  const conversation = await Conversation.findById(conversationId);
  if (!conversation) return null;
  if (!conversation.participants.some((p) => p.toString() === requesterId)) return null;

  return conversation;
};

const otherParticipantId = (conversation: IConversation, requesterId: string): string =>
  conversation.participants.map(String).find((id) => id !== requesterId) as string;

interface PopulatedParticipant {
  _id: mongoose.Types.ObjectId;
  fullName: string;
  avatar?: { url?: string };
}

// Only what toConversationSummary actually reads — a plain IConversation
// has `participants: [ObjectId, ObjectId]`; both callers here pass one
// with `participants` populated into full user docs instead, which is a
// different (wider) shape TS won't treat as an IConversation at all.
type ConversationWithParticipants = Pick<
  IConversation,
  "id" | "_id" | "lastMessageAt" | "lastMessagePreview" | "lastReadAt"
> & {
  participants: PopulatedParticipant[];
};

const toConversationSummary = async (
  conversation: ConversationWithParticipants,
  requesterId: string,
) => {
  const other = conversation.participants.find(
    (p) => p._id.toString() !== requesterId,
  ) as PopulatedParticipant;

  const myLastReadAt = conversation.lastReadAt.get(requesterId);

  const unreadCount = await Message.countDocuments({
    conversationId: conversation._id,
    sender: { $ne: requesterId },
    ...(myLastReadAt ? { createdAt: { $gt: myLastReadAt } } : {}),
  });

  return {
    id: conversation.id,
    otherParticipant: { id: other._id, fullName: other.fullName, avatar: other.avatar?.url },
    lastMessageAt: conversation.lastMessageAt,
    lastMessagePreview: conversation.lastMessagePreview,
    unreadCount,
  };
};

// @desc    Start (or fetch the existing) conversation with a contact
// @route   POST /api/conversations
// @access  Private
export const startOrGetConversation = asyncHandler(async (req: Request, res: Response) => {
  const requester = req.user as IUser;
  const { userId: otherUserId } = req.body;

  if (!otherUserId || !mongoose.Types.ObjectId.isValid(otherUserId)) {
    res.status(400);
    throw new Error("A valid userId is required");
  }

  if (otherUserId === requester.id) {
    res.status(400);
    throw new Error("You can't start a conversation with yourself");
  }

  const otherUser = await User.findById(otherUserId);
  if (!otherUser) {
    res.status(404);
    throw new Error("User not found");
  }

  if (!(await areContacts(requester.id, otherUserId))) {
    res.status(403);
    throw new Error("You can only message a connected contact");
  }

  const participants = sortParticipants(requester._id, otherUser._id);

  // Atomic find-or-create — two near-simultaneous "start a conversation"
  // calls between the same pair can't race into two documents; the unique
  // index on `participants` backs this up if they somehow still did.
  const conversation = await Conversation.findOneAndUpdate(
    { participants },
    { $setOnInsert: { participants } },
    { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true },
  ).populate<{ participants: PopulatedParticipant[] }>("participants", "fullName avatar");

  res.status(200).json(await toConversationSummary(conversation, requester.id));
});

// @desc    List my conversations, most recently active first
// @route   GET /api/conversations
// @access  Private
export const listConversations = asyncHandler(async (req: Request, res: Response) => {
  const requester = req.user as IUser;
  const { page, limit, skip } = paginationParams(req);

  const filter = { participants: requester._id };

  const [conversations, total] = await Promise.all([
    Conversation.find(filter)
      .sort({ lastMessageAt: -1, createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate<{ participants: PopulatedParticipant[] }>("participants", "fullName avatar"),
    Conversation.countDocuments(filter),
  ]);

  const data = await Promise.all(
    conversations.map((conversation) => toConversationSummary(conversation, requester.id)),
  );

  res.status(200).json({
    data,
    pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
  });
});

// @desc    A conversation's message history, newest first
// @route   GET /api/conversations/:id/messages
// @access  Private — participants only
export const listMessages = asyncHandler(async (req: Request, res: Response) => {
  const requester = req.user as IUser;
  const conversation = await loadMyConversation(req.params.id as string, requester.id);

  if (!conversation) {
    res.status(404);
    throw new Error("Conversation not found");
  }

  const { page, limit, skip } = paginationParams(req);
  const filter = { conversationId: conversation._id };

  const [data, total] = await Promise.all([
    Message.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    Message.countDocuments(filter),
  ]);

  res.status(200).json({
    data,
    pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
  });
});

// @desc    Send a message — persisted here; live delivery to the other
//          participant (if connected) happens as a side effect via
//          emitToUser, never as a separate socket-only write path.
// @route   POST /api/conversations/:id/messages
// @access  Private — participants only
export const sendMessage = asyncHandler(async (req: Request, res: Response) => {
  const requester = req.user as IUser;
  const conversation = await loadMyConversation(req.params.id as string, requester.id);

  if (!conversation) {
    res.status(404);
    throw new Error("Conversation not found");
  }

  const { body } = req.body;
  if (!body || typeof body !== "string" || !body.trim()) {
    res.status(400);
    throw new Error("Message body is required");
  }

  const message: IMessage = await Message.create({
    conversationId: conversation._id,
    sender: requester._id,
    body: body.trim(),
  });

  conversation.lastMessageAt = message.createdAt;
  conversation.lastMessagePreview = message.body.slice(0, PREVIEW_LENGTH);
  await conversation.save();

  emitToUser(otherParticipantId(conversation, requester.id), "message:new", message);

  res.status(201).json(message);
});

// @desc    Mark a conversation read up to now — drives the unread count
//          the conversation list shows, nothing more (no "seen" receipt
//          broadcast to the other participant).
// @route   PATCH /api/conversations/:id/read
// @access  Private — participants only
export const markConversationRead = asyncHandler(async (req: Request, res: Response) => {
  const requester = req.user as IUser;
  const conversation = await loadMyConversation(req.params.id as string, requester.id);

  if (!conversation) {
    res.status(404);
    throw new Error("Conversation not found");
  }

  conversation.lastReadAt.set(requester.id, new Date());
  await conversation.save();

  res.status(200).json({ success: true });
});

// @desc    Report a message — not moderation, just a permanent, admin-
//          visible record that something was flagged and why.
// @route   POST /api/messages/:id/report
// @access  Private — must be a participant of the message's conversation
export const reportMessage = asyncHandler(async (req: Request, res: Response) => {
  const requester = req.user as IUser;
  const { reason } = req.body;

  if (!reason || typeof reason !== "string" || !reason.trim()) {
    res.status(400);
    throw new Error("A reason is required");
  }

  const message = await Message.findById(req.params.id);
  if (!message) {
    res.status(404);
    throw new Error("Message not found");
  }

  const conversation = await loadMyConversation(message.conversationId.toString(), requester.id);
  if (!conversation) {
    res.status(404);
    throw new Error("Message not found");
  }

  const report = await MessageReport.create({
    messageId: message._id,
    conversationId: conversation._id,
    reportedBy: requester._id,
    reason: reason.trim(),
  });

  res.status(201).json(report);
});

// @desc    List reported messages, newest first
// @route   GET /api/messages/reports
// @access  Private (Admin / Super Admin only)
export const getMessageReports = asyncHandler(async (req: Request, res: Response) => {
  const { page, limit, skip } = paginationParams(req);

  const [data, total] = await Promise.all([
    MessageReport.find()
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("reportedBy", "fullName email")
      .populate("messageId"),
    MessageReport.countDocuments(),
  ]);

  res.status(200).json({
    data,
    pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
  });
});
