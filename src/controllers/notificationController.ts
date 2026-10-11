import asyncHandler from "express-async-handler";
import { Request, Response } from "express";
import { Notification } from "../models/notificationModel";
import { IUser } from "../models/userModel";

// @desc    My notification feed, newest first
// @route   GET /api/notifications
// @access  Private
export const getMyNotifications = asyncHandler(async (req: Request, res: Response) => {
  const requester = req.user as IUser;

  const page = Math.max(Number(req.query.page) || 1, 1);
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  const skip = (page - 1) * limit;

  const filter = { userId: requester._id };

  const [notifications, total] = await Promise.all([
    Notification.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    Notification.countDocuments(filter),
  ]);

  res.status(200).json({
    data: notifications,
    pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
  });
});

// @desc    Unread count — lets a frontend badge without paging through
//          the whole feed
// @route   GET /api/notifications/unread-count
// @access  Private
export const getUnreadCount = asyncHandler(async (req: Request, res: Response) => {
  const requester = req.user as IUser;
  const count = await Notification.countDocuments({ userId: requester._id, isRead: false });
  res.status(200).json({ count });
});

// @desc    Mark a single notification read
// @route   PATCH /api/notifications/:id/read
// @access  Private (owner only)
export const markNotificationRead = asyncHandler(async (req: Request, res: Response) => {
  const requester = req.user as IUser;
  const notification = await Notification.findOne({ _id: req.params.id, userId: requester._id });

  if (!notification) {
    res.status(404);
    throw new Error("Notification not found");
  }

  notification.isRead = true;
  await notification.save();

  res.status(200).json(notification);
});

// @desc    Mark every one of my notifications read in one call
// @route   PATCH /api/notifications/read-all
// @access  Private
export const markAllNotificationsRead = asyncHandler(async (req: Request, res: Response) => {
  const requester = req.user as IUser;
  await Notification.updateMany({ userId: requester._id, isRead: false }, { isRead: true });
  res.status(200).json({ message: "All notifications marked read" });
});
