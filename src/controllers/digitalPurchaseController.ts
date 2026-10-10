import mongoose from "mongoose";
import asyncHandler from "express-async-handler";
import { Request, Response } from "express";
import { DigitalPurchase, DIGITAL_PURCHASE_STATUS } from "../models/digitalPurchaseModel";
import { IUser } from "../models/userModel";
import { toDownloadLinks } from "../helpers/digitalFileLinks";

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

// @desc    Mint short-lived download links for MY OWN copy of one
//          purchase's files (DigitalPurchase.files) — keyed by the
//          purchase itself, never the product, so this never looks up
//          `DigitalProduct` at all. A creator later editing, deactivating,
//          or (per helpers/profileProductCleanup.ts) having their whole
//          catalog cleared after a month unsubscribed can't affect this
//          route at all — see digitalProductController.getDigitalProductDownloadLink
//          (the creator's own, separate, product-keyed route) and
//          docs/digital-storefront-plan.md for the split.
// @route   GET /api/digital-purchases/:id/download
// @access  Private
export const getDigitalPurchaseDownloadLink = asyncHandler(async (req: Request, res: Response) => {
  const requester = req.user as IUser;
  const id = req.params.id as string;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    res.status(404);
    throw new Error("Purchase not found");
  }

  const purchase = await DigitalPurchase.findOne({ _id: id, buyer: requester._id });
  if (!purchase) {
    res.status(404);
    throw new Error("Purchase not found");
  }

  if (purchase.status !== DIGITAL_PURCHASE_STATUS.SUCCESS) {
    res.status(403);
    throw new Error("This purchase hasn't completed yet");
  }

  if (purchase.files.length === 0) {
    if (purchase.filesDeletedAt) {
      res.status(410);
      throw new Error(
        "Your download access for this purchase has expired. Files are retained for a limited time after your subscription lapses.",
      );
    }

    res.status(503);
    throw new Error("Your files are still being prepared — please try again shortly");
  }

  res.status(200).json({ files: await toDownloadLinks(purchase.files) });
});
