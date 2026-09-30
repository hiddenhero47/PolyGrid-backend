import asyncHandler from "express-async-handler";
import { Request, Response } from "express";
import { DigitalPurchase } from "../models/digitalPurchaseModel";
import { IUser } from "../models/userModel";

const paginationParams = (req: Request) => {
  const page = Math.max(Number(req.query.page) || 1, 1);
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  return { page, limit, skip: (page - 1) * limit };
};

// @desc    My purchase history — what I've bought and its current status
//          (pending while checkout is in flight, success once the webhook
//          confirms it — see digitalPurchaseModel.ts).
// @route   GET /api/digital-purchases/mine
// @access  Private
export const getMyDigitalPurchases = asyncHandler(async (req: Request, res: Response) => {
  const requester = req.user as IUser;
  const { page, limit, skip } = paginationParams(req);

  const filter = { buyer: requester._id };

  const [purchases, total] = await Promise.all([
    DigitalPurchase.find(filter)
      .populate("product", "title category previewImages")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
    DigitalPurchase.countDocuments(filter),
  ]);

  res.status(200).json({
    data: purchases.map((purchase) => ({
      id: purchase.id,
      product: purchase.product,
      priceSnapshot: purchase.priceSnapshot,
      currency: purchase.currency,
      status: purchase.status,
      createdAt: purchase.createdAt,
    })),
    pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
  });
});
