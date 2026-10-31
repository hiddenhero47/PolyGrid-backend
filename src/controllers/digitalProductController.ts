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
import { DigitalCreatorProfile } from "../models/digitalCreatorProfileModel";
import { IUser, REVIEW_ROLES } from "../models/userModel";
import { Subscription } from "../models/subscriptionModel";
import { PROFILE_STATUS } from "../constants/profileStatus";
import { IMediaFile, toPublicMediaFile } from "../models/mediaFile";
import {
  uploadHandler,
  deleteStoredFile,
  FILE_VISIBILITY,
  DIGITAL_PRODUCT_DELIVERABLE_MIME_TYPES,
} from "../helpers/fileStorage";
import { getDigitalStorageProvider } from "../providers/digitalStorageProviders";
import { BIN_GRACE_MS, clearProductBin } from "../helpers/digitalProductBin";
import { toDownloadLinks } from "../helpers/digitalFileLinks";

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
  isVerified: product.isVerified,
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

// Owner-only — includes `files`, which toPublicDigitalProduct deliberately
// never does (the real deliverables are private). Names/mime/size only,
// never `key` (the actual storage-provider object key) — enough for the
// creator to see what's attached and manage it, not enough to reconstruct
// a download link outside getDigitalProductDownloadLink's own access check.
const toOwnerDigitalProduct = (product: IDigitalProduct) => ({
  ...toPublicDigitalProduct(product),
  files: product.files.map((file) => ({ fileName: file.fileName, mime: file.mime, size: file.size })),
});

// @desc    List my own products, any state — same gap/reasoning as
//          productController.getMyProducts: createDigitalProduct and its
//          sibling update/preview-image/file routes have no corresponding
//          read, so a creator otherwise has no way to see a product again
//          once they've added it. Every product they have, regardless of
//          isActive/isVerified — not the admin-verified-only public feed.
// @route   GET /api/digital-creator-profiles/me/products?page=&limit=
// @access  Private
export const getMyDigitalProducts = asyncHandler(async (req: Request, res: Response) => {
  const requester = req.user as IUser;
  const profile = await loadMyCreatorProfile(requester.id);

  if (!profile) {
    res.status(404);
    throw new Error("You don't have a digital creator profile yet");
  }

  const page = Math.max(Number(req.query.page) || 1, 1);
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  const skip = (page - 1) * limit;

  const filter = { creatorId: profile._id };

  const [products, total] = await Promise.all([
    DigitalProduct.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    DigitalProduct.countDocuments(filter),
  ]);

  res.status(200).json({
    data: products.map(toOwnerDigitalProduct),
    pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
  });
});

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

// Deliverables are identified (and removed — see removeDigitalProductFile)
// by fileName alone, which is just the attacher's own originalname. Two
// files sharing a name would be indistinguishable once attached, so this
// is checked before any upload happens — a bad batch never costs a
// wasted storage-provider PutObject.
const findDuplicateFileName = (
  existing: { fileName: string }[],
  incoming: Express.Multer.File[],
): string | null => {
  const names = new Set(existing.map((f) => f.fileName));

  for (const file of incoming) {
    if (names.has(file.originalname)) return file.originalname;
    names.add(file.originalname);
  }

  return null;
};

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

  const { category, title, description, price, currency } = req.body;

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

  const duplicateFileName = findDuplicateFileName([], filesForField(req, "files"));
  if (duplicateFileName) {
    res.status(400);
    throw new Error(`Two attached files are both named "${duplicateFileName}" — rename one of them`);
  }

  const [{ files: previewImages, warnings: previewWarnings }, { results: files, errorLogs: fileWarnings }] =
    await Promise.all([
      saveFilesForField(req, "previewImages", FILE_VISIBILITY.PUBLIC),
      getDigitalStorageProvider().uploadDigitalFiles(
        filesForField(req, "files"),
        `digital-products/${profile._id}`,
        DIGITAL_PRODUCT_DELIVERABLE_MIME_TYPES,
      ),
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

  await clearProductBin(product);

  const { category, title, description, price, currency, isActive } = req.body;

  if (category !== undefined) product.category = category;
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

  await clearProductBin(product);

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
//          updated revision, or replacing a removed one — see
//          removeDigitalProductFile right below).
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

  await clearProductBin(product);

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

  const duplicateFileName = findDuplicateFileName(product.files, filesForField(req, "files"));
  if (duplicateFileName) {
    res.status(400);
    throw new Error(
      `This product already has a file named "${duplicateFileName}" — rename it or remove the existing one first`,
    );
  }

  const { results: files, errorLogs: warnings } = await getDigitalStorageProvider().uploadDigitalFiles(
    filesForField(req, "files"),
    `digital-products/${profile._id}`,
    DIGITAL_PRODUCT_DELIVERABLE_MIME_TYPES,
  );
  product.files.push(...files);
  await product.save();

  res.status(201).json({
    ...toPublicDigitalProduct(product),
    ...(warnings.length > 0 ? { warnings } : {}),
  });
});

// @desc    Remove one deliverable file from one of my digital products
//          (e.g. to replace it — remove then addDigitalProductFiles).
//          Moves the entry into `bin` with a deleteAt BIN_GRACE_MS from
//          now, rather than deleting the underlying storage object
//          immediately: a purchase already in flight may still reference
//          this exact key via its frozen fileManifest, and the webhook's
//          copy step needs it to still exist whenever it runs. Once
//          deleteAt passes, clearProductBin (called lazily elsewhere in
//          this file) actually deletes it. See
//          docs/digital-storefront-plan.md.
// @route   DELETE /api/digital-creator-profiles/me/products/:id/files/:fileName
// @access  Private
export const removeDigitalProductFile = asyncHandler(async (req: Request, res: Response) => {
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

  await clearProductBin(product);

  const fileName = req.params.fileName as string;
  const file = product.files.find((f) => f.fileName === fileName);

  if (!file) {
    res.status(404);
    throw new Error("File not found on this product");
  }

  if (product.files.length === 1) {
    res.status(400);
    throw new Error("A product must keep at least one deliverable file");
  }

  product.files = product.files.filter((f) => f.fileName !== fileName) as typeof product.files;
  product.bin.push({ file, deleteAt: new Date(Date.now() + BIN_GRACE_MS) });
  await product.save();

  res.status(200).json(toPublicDigitalProduct(product));
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
//          Subscription) so an unsubscribed, unverified, inactive, or
//          banned creator's products never appear — checked live on
//          every page, nothing denormalized onto the product itself,
//          same cost (one query per page) as the store-level version
//          used for Physical. `isVerified` on the product itself
//          (admin/customer_care confirming the listing matches what it
//          promises — see setDigitalProductVerification) gates it too,
//          independently of the creator's own verification.
// @route   GET /api/digital-products/feed
// @access  Public
export const listDigitalProductFeed = asyncHandler(async (req: Request, res: Response) => {
  const { page, limit, skip } = paginationParams(req);
  const { category } = req.query as { category?: string };

  const match: Record<string, unknown> = { isActive: true, isVerified: true };
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
    { $match: { "creator.isVerified": true, "creator.status": PROFILE_STATUS.ACTIVE } },
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

// @desc    The digital-product review queue — admin/customer_care's way to
//          actually find what needs setDigitalProductVerification called
//          on it. listDigitalProductFeed only ever surfaces
//          isVerified:true (plus active/verified-creator/subscribed)
//          products, and getMyDigitalProducts is creator-scoped, so
//          nothing previously listed products awaiting review across
//          every creator. Deliberately ungated by isActive (a reviewer
//          needs to see a product even if its creator has since
//          deactivated it) or the creator's own verification/subscription
//          status — those gate *buyer* visibility, not reviewer
//          visibility. `status` maps directly onto the product's own
//          isVerified flag; invalid/missing defaults to 'pending', the
//          queue's primary use case.
// @route   GET /api/digital-products/review?status=pending|approved&page=&limit=
// @access  Private (Admin / Super Admin / Customer Care)
export const listDigitalProductsForReview = asyncHandler(async (req: Request, res: Response) => {
  const { page, limit, skip } = paginationParams(req);
  const status = req.query.status === "approved" ? "approved" : "pending";

  const pipeline = [
    { $match: { isVerified: status === "approved" } },
    {
      $lookup: {
        from: "digitalcreatorprofiles",
        localField: "creatorId",
        foreignField: "_id",
        as: "creator",
      },
    },
    { $unwind: "$creator" },
    { $sort: { createdAt: -1 as const } },
  ];

  const [products, totalResult] = await Promise.all([
    DigitalProduct.aggregate([...pipeline, { $skip: skip }, { $limit: limit }]),
    DigitalProduct.aggregate([...pipeline, { $count: "total" }]),
  ]);

  const total = totalResult[0]?.total ?? 0;

  res.status(200).json({
    data: products.map((product) => ({
      // Same aggregate()-has-no-.id-virtual fix listDigitalProductFeed
      // already applies, plus toOwnerDigitalProduct's redacted `files`
      // (fileName/mime/size, never the storage key) — a reviewer needs to
      // see what's attached, same as the product's own creator does.
      ...toOwnerDigitalProduct(product as IDigitalProduct),
      id: (product._id as mongoose.Types.ObjectId).toString(),
      creator: {
        id: product.creator._id,
        displayName: product.creator.displayName,
        slug: product.creator.slug,
        isVerified: product.creator.isVerified,
        status: product.creator.status,
        country: product.creator.country,
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
  if (!product) {
    res.status(404);
    throw new Error("Product not found");
  }

  await clearProductBin(product);

  if (!product.isActive) {
    res.status(404);
    throw new Error("Product not found");
  }

  const creator = await DigitalCreatorProfile.findById(product.creatorId);
  const subscription = creator?.currentSubscription
    ? await Subscription.findById(creator.currentSubscription)
    : null;

  if (
    !product.isVerified ||
    !creator?.isVerified ||
    creator.status !== PROFILE_STATUS.ACTIVE ||
    !subscription?.isActive()
  ) {
    res.status(200).json({ available: false, message: "This product is not currently available." });
    return;
  }

  res.status(200).json(toPublicDigitalProduct(product));
});

// @desc    Confirm (or revoke) that a digital product listing is
//          authentic — the deliverable files actually match what the
//          title/description/price promise. Separate from (and
//          independent of) the creator's own isVerified/status; see
//          digitalProductModel.ts. Deliberately open to customer_care
//          too, not just Admin/Super Admin — unlike most moderation
//          actions in this codebase, checking a listing's contents
//          against what it claims is exactly the kind of day-to-day
//          review work customer_care is meant to help with.
// @route   PATCH /api/digital-products/:id/verify
// @access  Private (Admin / Super Admin / Customer Care)
export const setDigitalProductVerification = asyncHandler(async (req: Request, res: Response) => {
  const reviewer = req.user as IUser;
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

  const { isVerified } = req.body;

  product.isVerified = isVerified;
  product.verifiedBy = reviewer._id as mongoose.Types.ObjectId;
  product.verifiedAt = new Date();
  await product.save();

  res.status(200).json(toPublicDigitalProduct(product));
});

// @desc    Mint short-lived download links for one of MY OWN digital
//          product's live deliverable files, OR — for a REVIEW_ROLES
//          member working the review queue (listDigitalProductsForReview)
//          — any product's, so a reviewer can actually open the
//          deliverables to check they match what the listing claims.
//          Keyed by the product, which is exactly right here since it's
//          the creator's/reviewer's own current files being requested. A
//          buyer never uses this route: they download their own
//          purchased copy via GET /api/digital-purchases/:id/download
//          instead (see digitalPurchaseController.getDigitalPurchaseDownloadLink),
//          which is keyed by the purchase itself and never needs this
//          product to still exist at all — see docs/digital-storefront-
//          plan.md for why that separation matters (this route used to
//          serve both roles off one DigitalProduct lookup, which meant a
//          buyer's download depended on the live product being found
//          first, even though the actual bytes they'd get were already
//          fully independent of it).
// @route   GET /api/digital-products/:id/download
// @access  Private (the product's own creator, or Admin/Super Admin/Customer Care)
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

  await clearProductBin(product);

  const creator = await DigitalCreatorProfile.findById(product.creatorId);
  const isOwner = creator?.userId.toString() === requester.id;
  const isReviewer = REVIEW_ROLES.includes(requester.systemRole as (typeof REVIEW_ROLES)[number]);

  if (!isOwner && !isReviewer) {
    res.status(403);
    throw new Error("You don't have access to this product's files");
  }

  res.status(200).json({ files: await toDownloadLinks(product.files) });
});
