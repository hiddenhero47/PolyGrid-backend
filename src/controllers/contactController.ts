import mongoose from "mongoose";
import asyncHandler from "express-async-handler";
import { Request, Response } from "express";
import { Contact } from "../models/contactModel";
import { User, IUser } from "../models/userModel";
import { toPublicMediaFile } from "../models/mediaFile";

const ensureConnection = async (
  ownerId: mongoose.Types.ObjectId,
  other: { _id: mongoose.Types.ObjectId; email: string },
): Promise<void> => {
  // Two steps rather than one clever upsert: combining `upsert: true` with a
  // query that excludes documents which already have this entry (via $ne on
  // an array field) means "already connected" and "document doesn't exist
  // yet" both look like "no match" to Mongo — which would then try to
  // upsert a second document and collide with the unique userId index.
  await Contact.findOneAndUpdate(
    { userId: ownerId },
    { $setOnInsert: { userId: ownerId } },
    { upsert: true },
  );

  await Contact.updateOne(
    { userId: ownerId, "list.user": { $ne: other._id } },
    { $push: { list: { user: other._id, email: other.email, connectedAt: new Date() } } },
  );
};

// Adds each user to the other's contact list, idempotently. Exported for
// jobController.ts to call as a side effect of creating a job together.
export const connectUsers = async (
  userIdA: mongoose.Types.ObjectId | string,
  userIdB: mongoose.Types.ObjectId | string,
): Promise<void> => {
  if (userIdA.toString() === userIdB.toString()) return;

  const [userA, userB] = await Promise.all([
    User.findById(userIdA).select("email"),
    User.findById(userIdB).select("email"),
  ]);

  if (!userA || !userB) return;

  await Promise.all([ensureConnection(userA._id, userB), ensureConnection(userB._id, userA)]);
};

// @desc    Add a contact directly, by userId or email
// @route   POST /api/contacts
// @access  Private
export const addContact = asyncHandler(async (req: Request, res: Response) => {
  const requester = req.user as IUser;
  const { userId, email } = req.body;

  const target = userId
    ? await User.findById(userId)
    : await User.findOne({ email: String(email).toLowerCase().trim() });

  if (!target) {
    res.status(404);
    throw new Error("User not found");
  }

  if (target._id.toString() === requester.id) {
    res.status(400);
    throw new Error("You cannot add yourself as a contact");
  }

  await connectUsers(requester._id, target._id);

  res.status(200).json({ message: "Contact added" });
});

// @desc    List my contacts, newest first, optionally filtered by name or
//          email (?q=)
// @route   GET /api/contacts
// @access  Private
export const getContacts = asyncHandler(async (req: Request, res: Response) => {
  const requester = req.user as IUser;
  const page = Math.max(Number(req.query.page) || 1, 1);
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  const skip = (page - 1) * limit;
  const q = typeof req.query.q === "string" ? req.query.q.trim().toLowerCase() : "";

  const contact = await Contact.findOne({ userId: requester._id }).lean();
  let fullList = [...(contact?.list ?? [])].sort(
    (a, b) => b.connectedAt.getTime() - a.connectedAt.getTime(),
  );

  // Fetched for the whole list up front (bounded by however many contacts
  // this person actually has, not a page size) — needed both to filter
  // by name below and to attach fullName/avatar per row, same summary
  // jobController.toJobPartyUserSummary gives, so a contact row can show
  // a name instead of just an email.
  const users = await User.find({ _id: { $in: fullList.map((entry) => entry.user) } }).select("fullName avatar");
  const userById = new Map(users.map((user) => [user.id, user]));

  if (q) {
    fullList = fullList.filter((entry) => {
      const fullName = userById.get(entry.user.toString())?.fullName ?? "";
      return entry.email.toLowerCase().includes(q) || fullName.toLowerCase().includes(q);
    });
  }

  const data = fullList.slice(skip, skip + limit).map((entry) => {
    const user = userById.get(entry.user.toString());
    return {
      user: entry.user,
      email: entry.email,
      fullName: user?.fullName,
      avatar: user?.avatar ? toPublicMediaFile(user.avatar) : undefined,
      connectedAt: entry.connectedAt,
    };
  });

  res.status(200).json({
    data,
    pagination: {
      total: fullList.length,
      page,
      limit,
      totalPages: Math.ceil(fullList.length / limit),
    },
  });
});

// @desc    Remove a contact from my own list (one-directional)
// @route   DELETE /api/contacts/:userId
// @access  Private
export const removeContact = asyncHandler(async (req: Request, res: Response) => {
  const requester = req.user as IUser;
  const targetId = req.params.userId as string;

  if (!mongoose.Types.ObjectId.isValid(targetId)) {
    res.status(400);
    throw new Error("Invalid user id");
  }

  await Contact.updateOne({ userId: requester._id }, { $pull: { list: { user: targetId } } });

  res.status(200).json({ message: "Contact removed" });
});
