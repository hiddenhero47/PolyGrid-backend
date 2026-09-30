import mongoose from "mongoose";
import asyncHandler from "express-async-handler";
import { Request, Response } from "express";
import {
  DigitalProduct,
  IDigitalProduct,
  DIGITAL_PRODUCT_CATEGORY,
  DigitalProductCategory,
  MAX_PREVIEW_IMAGES,
  MAX_DELIVERABLE_FILES,
} from "../models/digitalProductModel";
import { DigitalCreatorProfile, IDigitalCreatorProfile } from "../models/digitalCreatorProfileModel";
import { DigitalPurchase, DIGITAL_PURCHASE_STATUS } from "../models/digitalPurchaseModel";
import { IUser } from "../models/userModel";
import { Subscription } from "../models/subscriptionModel";
import { IMediaFile, toPublicMediaFile } from "../models/mediaFile";
import { uploadHandler, deleteStoredFile, FILE_VISIBILITY } from "../helpers/fileStorage";
import { signFileUrl, FILE_URL_MODE } from "../helpers/fileSigning";
import { parseMultipartData } from "../helpers/parseMultipartData";

// Never includes `files` — the actual deliverables are private and only
// ever reachable through getDownloadLink's access check.
export const toPublicDigitalProduct = (product: IDigitalProduct) => ({
  id: product.id,
  creatorId: product.creatorId,
  category: product.category,
  title: product.title,
  description: product.description,
  previewImages: product.previewImages.map(toPublicMediaFile),
  price: product.price,
  currency: product.currency,
  isActive: product.isActive,
  createdAt: product.createdAt,
});

// Every write in this file is scoped to the caller's own creator profile —
// same "one lookup doubles as existence + ownership check" shape as
// productController's loadMyStore.
const loadMyCreatorProfile = async (requesterId: string) =>
  DigitalCreatorProfile.findOne({ userId: requesterId });

const loadMyProduct = async (requesterId: string, productId: string) => {
  const profile = await loadMyCreatorProfile(requesterId);
  if (!profile) return { profile: null, product: null };

  if (!mongoose.Types.ObjectId.isValid(productId)) return { profile, product: null };

  const product = await DigitalProduct.findOne({ _id: productId, creatorId: profile._id });
  return { profile, product };
};

// forms.any() (mounted globally in app.ts) puts every attached file into
// one flat req.files array regardless of field name, each tagged with its
// own `.fieldname` — this is what actually distinguishes the public
// `previewImages` field from the private `files` field, not multer config.
const filesForField = (req: Request, fieldname: string): Express.Multer.File[] =>
  ((req.files as Express.Multer.File[] | undefined) ?? []).filter((f) => f.fieldname === fieldname);

const saveFilesForField = async (
  req: Request,
  fieldname: string,
  visibility: (typeof FILE_VISIBILITY)[keyof typeof FILE_VISIBILITY],
  ownerId?: string,
): Promise<{ files: IMediaFile[]; warnings: string[] }> => {
  // body: {} deliberately drops base64/url support for this field — a
  // shared req.body would otherwise get processed once per field call,
  // double-saving the same base64/url payload under both `previewImages`
  // and `files`. Real multipart attachments only, which is all either
  // field actually needs.
  const shimReq = { files: filesForField(req, fieldname), body: {} } as unknown as Request;
  const { results, errorLogs } = await uploadHandler({ req: shimReq, visibility, ownerId });

  return {
    files: results.map((r) => ({
      fileName: r.fileName,
      storagePath: r.storagePath,
      mime: r.mime,
      size: r.size,
      url: r.url,
    })),
    warnings: errorLogs,
  };
};

interface DigitalProductPayload {
  category?: string;
  title?: string;
  description?: string;
  price?: number;
  currency?: string;
}

// @desc    Create a digital product listing under my creator profile
// @route   POST /api/digital-creator-profiles/me/products
// @access  Private
// multipart/form-data — non-file fields JSON-stringified under `data`
// (parseMultipartData), preview images attached under the `previewImages`
// field (public), the actual deliverables attached under the `files` field
// (private — never served directly, only through getDownloadLink).
export const createDigitalProduct = asyncHandler(async (req: Request, res: Response) => {
  const requester = req.user as IUser;
  const profile = await loadMyCreatorProfile(requester.id);

  if (!profile) {
    res.status(404);
    throw new Error("You don't have a digital creator profile yet");
  }

  const { category, title, description, price, currency } = parseMultipartData<DigitalProductPayload>(req);

  if (!title || price === undefined) {
    res.status(400);
    throw new Error("Please add a title and price");
  }

  if (!category || !Object.values(DIGITAL_PRODUCT_CATEGORY).includes(category as DigitalProductCategory)) {
    res.status(400);
    throw new Error("Please add a valid category");
  }

  const previewCount = filesForField(req, "previewImages").length;
  if (previewCount > MAX_PREVIEW_IMAGES) {
    res.status(400);
    throw new Error(`You can attach at most ${MAX_PREVIEW_IMAGES} preview images`);
  }

  const deliverableCount = filesForField(req, "files").length;
  if (deliverableCount === 0) {
    res.status(400);
    throw new Error("Attach at least one deliverable file");
  }
  if (deliverableCount > MAX_DELIVERABLE_FILES) {
    res.status(400);
    throw new Error(`You can attach at most ${MAX_DELIVERABLE_FILES} deliverable files`);
  }

  const ownerId = profile.userId.toString();

  const [{ files: previewImages, warnings: previewWarnings }, { files, warnings: fileWarnings }] =
    await Promise.all([
      saveFilesForField(req, "previewImages", FILE_VISIBILITY.PUBLIC),
      saveFilesForField(req, "files", FILE_VISIBILITY.PRIVATE, ownerId),
    ]);

  if (files.length === 0) {
    res.status(400);
    throw new Error(fileWarnings[0] || "None of the attached deliverable files were valid");
  }

  const product = await DigitalProduct.create({
    creatorId: profile._id,
    category,
    title,
    description,
    previewImages,
    price,
    currency: currency || "USD",
    files,
  });

  const warnings = [...previewWarnings, ...fileWarnings];
  res.status(201).json({
    ...toPublicDigitalProduct(product),
    ...(warnings.length > 0 ? { warnings } : {}),
  });
});

// @desc    Update one of my digital products — fields and the isActive
//          toggle only. There is no delete endpoint: a creator can never
//          hard-delete a listing (see docs/digital-storefront-plan.md), so
//          `isActive: false` is the only removal mechanism, and it only
//          hides the listing from discovery — it never revokes a past
//          buyer's download access.
// @route   PATCH /api/digital-creator-profiles/me/products/:id
// @access  Private
export const updateDigitalProduct = asyncHandler(async (req: Request, res: Response) => {
  const requester = req.user as IUser;
  const { profile, product } = await loadMyProduct(requester.id, req.params.id as string);

  if (!profile) {
    res.status(404);
    throw new Error("You don't have a digital creator profile yet");
  }
  if (!product) {
    res.status(404);
    throw new Error("Product not found");
  }

  const { category, title, description, price, currency, isActive } = req.body;

  if (category !== undefined) {
    if (!Object.values(DIGITAL_PRODUCT_CATEGORY).includes(category)) {
      res.status(400);
      throw new Error("Please add a valid category");
    }
    product.category = category;
  }

  if (title) product.title = title;
  if (description !== undefined) product.description = description;
  if (price !== undefined) product.price = price;
  if (currency) product.currency = currency;
  if (isActive !== undefined) product.isActive = Boolean(isActive);

  await product.save();

  res.status(200).json(toPublicDigitalProduct(product));
});

// @desc    Add more preview images to one of my digital products
// @route   POST /api/digital-creator-profiles/me/products/:id/preview-images
// @access  Private
export const addDigitalProductPreviewImages = asyncHandler(async (req: Request, res: Response) => {
  const requester = req.user as IUser;
  const { profile, product } = await loadMyProduct(requester.id, req.params.id as string);

  if (!profile) {
    res.status(404);
    throw new Error("You don't have a digital creator profile yet");
  }
  if (!product) {
    res.status(404);
    throw new Error("Product not found");
  }

  const attachedCount = filesForField(req, "previewImages").length;
  if (attachedCount === 0) {
    res.status(400);
    throw new Error("Attach at least one preview image under the previewImages field");
  }
  if (product.previewImages.length + attachedCount > MAX_PREVIEW_IMAGES) {
    res.status(400);
    throw new Error(
      `This product already has ${product.previewImages.length} of ${MAX_PREVIEW_IMAGES} preview images allowed — attach fewer`,
    );
  }

  const { files: previewImages, warnings } = await saveFilesForField(req, "previewImages", FILE_VISIBILITY.PUBLIC);
  product.previewImages.push(...previewImages);
  await product.save();

  res.status(201).json({
    ...toPublicDigitalProduct(product),
    ...(warnings.length > 0 ? { warnings } : {}),
  });
});

// @desc    Remove one preview image from one of my digital products
// @route   DELETE /api/digital-creator-profiles/me/products/:id/preview-images/:fileName
// @access  Private
export const removeDigitalProductPreviewImage = asyncHandler(async (req: Request, res: Response) => {
  const requester = req.user as IUser;
  const { profile, product } = await loadMyProduct(requester.id, req.params.id as string);

  if (!profile) {
    res.status(404);
    throw new Error("You don't have a digital creator profile yet");
  }
  if (!product) {
    res.status(404);
    throw new Error("Product not found");
  }

  const fileName = req.params.fileName as string;
  const image = product.previewImages.find((img) => img.fileName === fileName);

  if (!image) {
    res.status(404);
    throw new Error("Preview image not found on this product");
  }

  await deleteStoredFile(image.storagePath);
  product.previewImages = product.previewImages.filter(
    (img) => img.fileName !== fileName,
  ) as typeof product.previewImages;
  await product.save();

  res.status(200).json(toPublicDigitalProduct(product));
});

// @desc    Add more deliverable files to one of my digital products (e.g. an
//          updated revision) — deliberately append-only, no remove
//          endpoint: a file already sold to a past buyer shouldn't be
//          pulled out from under them just because the creator is editing
//          the listing.
// @route   POST /api/digital-creator-profiles/me/products/:id/files
// @access  Private
export const addDigitalProductFiles = asyncHandler(async (req: Request, res: Response) => {
  const requester = req.user as IUser;
  const { profile, product } = await loadMyProduct(requester.id, req.params.id as string);

  if (!profile) {
    res.status(404);
    throw new Error("You don't have a digital creator profile yet");
  }
  if (!product) {
    res.status(404);
    throw new Error("Product not found");
  }

  const attachedCount = filesForField(req, "files").length;
  if (attachedCount === 0) {
    res.status(400);
    throw new Error("Attach at least one file under the files field");
  }
  if (product.files.length + attachedCount > MAX_DELIVERABLE_FILES) {
    res.status(400);
    throw new Error(
      `This product already has ${product.files.length} of ${MAX_DELIVERABLE_FILES} deliverable files allowed — attach fewer`,
    );
  }

  const { files, warnings } = await saveFilesForField(
    req,
    "files",
    FILE_VISIBILITY.PRIVATE,
    profile.userId.toString(),
  );
  product.files.push(...files);
  await product.save();

  res.status(201).json({
    ...toPublicDigitalProduct(product),
    ...(warnings.length > 0 ? { warnings } : {}),
  });
});

const paginationParams = (req: Request) => {
  const page = Math.max(Number(req.query.page) || 1, 1);
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  return { page, limit, skip: (page - 1) * limit };
};

// @desc    The flat, cross-creator "browse everything" feed — the primary
//          discovery surface for Digital (see docs/digital-storefront-plan.md
//          for why this differs from Physical's store-first browsing). One
//          aggregation, anchored directly on DigitalProduct, with a two-hop
//          $lookup (DigitalProduct -> its creator's DigitalCreatorProfile ->
//          Subscription) so an unsubscribed or unverified creator's
//          products never appear — checked live on every page, nothing
//          denormalized onto the product itself, same cost (one query per
//          page) as the store-level version used for Physical.
// @route   GET /api/digital-products/feed
// @access  Public
export const listDigitalProductFeed = asyncHandler(async (req: Request, res: Response) => {
  const { page, limit, skip } = paginationParams(req);
  const { category } = req.query as { category?: string };

  const match: Record<string, unknown> = { isActive: true };
  if (category && Object.values(DIGITAL_PRODUCT_CATEGORY).includes(category as DigitalProductCategory)) {
    match.category = category;
  }

  const pipeline = [
    { $match: match },
    {
      $lookup: {
        from: "digitalcreatorprofiles",
        localField: "creatorId",
        foreignField: "_id",
        as: "creator",
      },
    },
    { $unwind: "$creator" },
    { $match: { "creator.isVerified": true } },
    {
      $lookup: {
        from: "subscriptions",
        localField: "creator.currentSubscription",
        foreignField: "_id",
        as: "subscription",
      },
    },
    { $unwind: "$subscription" },
    { $match: { "subscription.status": "active", "subscription.expiresAt": { $gt: new Date() } } },
    { $sort: { createdAt: -1 as const } },
  ];

  const [products, totalResult] = await Promise.all([
    DigitalProduct.aggregate([...pipeline, { $skip: skip }, { $limit: limit }]),
    DigitalProduct.aggregate([...pipeline, { $count: "total" }]),
  ]);

  const total = totalResult[0]?.total ?? 0;

  res.status(200).json({
    data: products.map((product) => ({
      // An aggregate() result is a plain object, not a Mongoose document —
      // it has no `.id` virtual, so toPublicDigitalProduct's `product.id`
      // comes back undefined here unless overridden explicitly.
      ...toPublicDigitalProduct(product as IDigitalProduct),
      id: (product._id as mongoose.Types.ObjectId).toString(),
      creator: {
        id: product.creator._id,
        slug: product.creator.slug,
        displayName: product.creator.displayName,
        avatar: product.creator.avatar ? toPublicMediaFile(product.creator.avatar) : undefined,
      },
    })),
    pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
  });
});

// @desc    View a single digital product directly — the URL always
//          resolves, but (matching getProduct/getStore) it's withheld
//          unless the owning creator is currently verified AND subscribed,
//          checked live.
// @route   GET /api/digital-products/:id
// @access  Public
export const getDigitalProduct = asyncHandler(async (req: Request, res: Response) => {
  const id = req.params.id as string;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    res.status(404);
    throw new Error("Product not found");
  }

  const product = await DigitalProduct.findById(id);
  if (!product || !product.isActive) {
    res.status(404);
    throw new Error("Product not found");
  }

  const creator = await DigitalCreatorProfile.findById(product.creatorId);
  const subscription = creator?.currentSubscription
    ? await Subscription.findById(creator.currentSubscription)
    : null;

  if (!creator?.isVerified || !subscription?.isActive()) {
    res.status(200).json({ available: false, message: "This product is not currently available." });
    return;
  }

  res.status(200).json(toPublicDigitalProduct(product));
});

// @desc    Mint short-lived signed download links for every deliverable
//          file on a digital product. Access is permanent once granted —
//          checked purely off a DigitalPurchase{status: success} record
//          (or the requester being the product's own creator), and
//          deliberately never re-checks the creator's live subscription/
//          verification or the product's isActive flag: those only ever
//          gate discovery (the feed, the creator page, direct product
//          view), never a download someone already paid for. See
//          docs/digital-storefront-plan.md.
// @route   GET /api/digital-products/:id/download
// @access  Private
export const getDigitalProductDownloadLink = asyncHandler(async (req: Request, res: Response) => {
  const requester = req.user as IUser;
  const id = req.params.id as string;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    res.status(404);
    throw new Error("Product not found");
  }

  const product = await DigitalProduct.findById(id);
  if (!product) {
    res.status(404);
    throw new Error("Product not found");
  }

  const creator = await DigitalCreatorProfile.findById(product.creatorId);
  const isCreator = creator?.userId.toString() === requester.id;

  if (!isCreator) {
    const purchase = await DigitalPurchase.findOne({
      product: product._id,
      buyer: requester._id,
      status: DIGITAL_PURCHASE_STATUS.SUCCESS,
    });

    if (!purchase) {
      res.status(403);
      throw new Error("You don't have access to this product's files");
    }
  }

  const ownerId = (creator as IDigitalCreatorProfile).userId.toString();

  const files = product.files.map((file) => ({
    fileName: file.fileName,
    mime: file.mime,
    size: file.size,
    downloadUrl: signFileUrl({ ownerId, fileName: file.fileName, mode: FILE_URL_MODE.DOWNLOAD }),
  }));

  res.status(200).json({ files });
});
