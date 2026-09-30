import mongoose from "mongoose";
import asyncHandler from "express-async-handler";
import { Request, Response } from "express";
import {
  Product,
  IProduct,
  IShippingOption,
  MAX_PRODUCT_IMAGES,
  MAX_SHIPPING_LOCATIONS,
  STOCK_STATUS,
  StockStatus,
} from "../models/productModel";
import { StoreProfile, MaterialCategory } from "../models/storeProfileModel";
import { IUser } from "../models/userModel";
import { Subscription } from "../models/subscriptionModel";
import { IMediaFile, toPublicMediaFile } from "../models/mediaFile";
import { uploadHandler, deleteStoredFile, FILE_VISIBILITY } from "../helpers/fileStorage";
import { parseMultipartData } from "../helpers/parseMultipartData";
import { isValidCountryCode, isValidStateCode } from "../helpers/countryReference";
import { AppError } from "../middleware/errorMiddleware";

export const toPublicProduct = (product: IProduct) => ({
  id: product.id,
  storeId: product.storeId,
  category: product.category,
  subCategory: product.subCategory,
  title: product.title,
  description: product.description,
  images: product.images.map(toPublicMediaFile),
  price: product.price,
  currency: product.currency,
  unit: product.unit,
  stockStatus: product.stockStatus,
  shippingLocations: product.shippingLocations,
  createdAt: product.createdAt,
});

interface ShippingLocationInput {
  country?: string;
  state?: string;
  price?: number;
}

const badRequest = (message: string): never => {
  const error: AppError = new Error(message);
  error.statusCode = 400;
  throw error;
};

// Deliberately stricter than filterValidCategories/filterValidLinks
// elsewhere in this codebase, which silently drop a malformed entry — a
// product with no valid shipping locations at all can't be ordered by
// anyone, so a bad entry here is a clean 400 the seller has to fix, not a
// silent omission they'd only discover later as "why can't anyone buy
// this."
const resolveShippingLocations = (input: unknown): IShippingOption[] => {
  if (!Array.isArray(input) || input.length === 0) {
    return badRequest("At least one shipping location is required");
  }
  if (input.length > MAX_SHIPPING_LOCATIONS) {
    return badRequest(`You can add at most ${MAX_SHIPPING_LOCATIONS} shipping locations`);
  }

  return input.map((raw, index) => {
    const entry = raw as ShippingLocationInput;
    const label = `Shipping location ${index + 1}`;

    if (!entry.country || !isValidCountryCode(entry.country)) {
      return badRequest(`${label}: a valid country is required`);
    }
    const country = entry.country.toUpperCase();

    const state = entry.state ? entry.state.toUpperCase() : undefined;
    if (state && !isValidStateCode(country, state)) {
      return badRequest(`${label}: not a recognized state/province for ${country}`);
    }

    if (entry.price === undefined || Number(entry.price) < 0) {
      return badRequest(`${label}: a non-negative price is required`);
    }

    return { country, state, price: Number(entry.price) };
  });
};

// Every write in this file is scoped to the caller's own store — a
// product never gets touched by anyone but its owner, so this one lookup
// doubles as both "does my store exist" and the ownership check.
const loadMyStore = async (requesterId: string) => StoreProfile.findOne({ userId: requesterId });

const saveProductImages = async (
  req: Request,
): Promise<{ images: IMediaFile[]; warnings: string[] }> => {
  const { results, errorLogs } = await uploadHandler({ req, visibility: FILE_VISIBILITY.PUBLIC });

  return {
    images: results.map((r) => ({
      fileName: r.fileName,
      storagePath: r.storagePath,
      mime: r.mime,
      size: r.size,
      url: r.url,
    })),
    warnings: errorLogs,
  };
};

interface ProductPayload {
  category?: string;
  subCategory?: string;
  title?: string;
  description?: string;
  price?: number;
  currency?: string;
  unit?: string;
  stockStatus?: string;
  shippingLocations?: unknown;
}

// @desc    Create a product under my store — its category must be one the
//          store itself declared it sells
// @route   POST /api/store-profiles/me/products
// @access  Private
export const createProduct = asyncHandler(async (req: Request, res: Response) => {
  const requester = req.user as IUser;
  const store = await loadMyStore(requester.id);

  if (!store) {
    res.status(404);
    throw new Error("You don't have a store profile yet");
  }

  const { category, subCategory, title, description, price, currency, unit, shippingLocations } =
    parseMultipartData<ProductPayload>(req);

  if (!title || price === undefined || !unit) {
    res.status(400);
    throw new Error("Please add a title, price, and unit");
  }

  if (!category || !store.categories.includes(category as MaterialCategory)) {
    res.status(400);
    throw new Error("category must be one of this store's own categories");
  }

  const resolvedShippingLocations = resolveShippingLocations(shippingLocations);

  const attachedCount = (req.files as Express.Multer.File[] | undefined)?.length ?? 0;
  if (attachedCount > MAX_PRODUCT_IMAGES) {
    res.status(400);
    throw new Error(`You can attach at most ${MAX_PRODUCT_IMAGES} images to a product`);
  }

  const { images, warnings: imageWarnings } = await saveProductImages(req);

  const product = await Product.create({
    storeId: store._id,
    category,
    subCategory,
    title,
    description,
    images,
    price,
    currency: currency || "USD",
    unit,
    shippingLocations: resolvedShippingLocations,
  });

  res.status(201).json({
    ...toPublicProduct(product),
    ...(imageWarnings.length > 0 ? { imageWarnings } : {}),
  });
});

const loadMyProduct = async (requesterId: string, productId: string) => {
  const store = await loadMyStore(requesterId);
  if (!store) return { store: null, product: null };

  if (!mongoose.Types.ObjectId.isValid(productId)) return { store, product: null };

  const product = await Product.findOne({ _id: productId, storeId: store._id });
  return { store, product };
};

// @desc    Update one of my products
// @route   PATCH /api/store-profiles/me/products/:id
// @access  Private
export const updateProduct = asyncHandler(async (req: Request, res: Response) => {
  const requester = req.user as IUser;
  const { store, product } = await loadMyProduct(requester.id, req.params.id as string);

  if (!store) {
    res.status(404);
    throw new Error("You don't have a store profile yet");
  }
  if (!product) {
    res.status(404);
    throw new Error("Product not found");
  }

  const { category, subCategory, title, description, price, currency, unit, stockStatus, shippingLocations } =
    req.body;

  if (category !== undefined) {
    if (!store.categories.includes(category)) {
      res.status(400);
      throw new Error("category must be one of this store's own categories");
    }
    product.category = category;
  }

  if (subCategory !== undefined) product.subCategory = subCategory;
  if (title) product.title = title;
  if (description !== undefined) product.description = description;
  if (price !== undefined) product.price = price;
  if (currency) product.currency = currency;
  if (unit) product.unit = unit;

  if (shippingLocations !== undefined) {
    product.shippingLocations = resolveShippingLocations(shippingLocations) as typeof product.shippingLocations;
  }

  if (stockStatus !== undefined) {
    if (!Object.values(STOCK_STATUS).includes(stockStatus)) {
      res.status(400);
      throw new Error("Invalid stockStatus");
    }
    product.stockStatus = stockStatus as StockStatus;
  }

  await product.save();

  res.status(200).json(toPublicProduct(product));
});

// @desc    Delete one of my products, and every image it owns
// @route   DELETE /api/store-profiles/me/products/:id
// @access  Private
export const deleteProduct = asyncHandler(async (req: Request, res: Response) => {
  const requester = req.user as IUser;
  const { store, product } = await loadMyProduct(requester.id, req.params.id as string);

  if (!store) {
    res.status(404);
    throw new Error("You don't have a store profile yet");
  }
  if (!product) {
    res.status(404);
    throw new Error("Product not found");
  }

  await Promise.all(product.images.map((image) => deleteStoredFile(image.storagePath)));
  await product.deleteOne();

  res.status(200).json({ success: true });
});

// @desc    Add more images to one of my products
// @route   POST /api/store-profiles/me/products/:id/images
// @access  Private
export const addProductImages = asyncHandler(async (req: Request, res: Response) => {
  const requester = req.user as IUser;
  const { store, product } = await loadMyProduct(requester.id, req.params.id as string);

  if (!store) {
    res.status(404);
    throw new Error("You don't have a store profile yet");
  }
  if (!product) {
    res.status(404);
    throw new Error("Product not found");
  }

  const attachedCount = (req.files as Express.Multer.File[] | undefined)?.length ?? 0;
  if (attachedCount === 0) {
    res.status(400);
    throw new Error("Attach at least one image");
  }
  if (product.images.length + attachedCount > MAX_PRODUCT_IMAGES) {
    res.status(400);
    throw new Error(
      `This product already has ${product.images.length} of ${MAX_PRODUCT_IMAGES} images allowed — attach fewer`,
    );
  }

  const { images, warnings: imageWarnings } = await saveProductImages(req);
  product.images.push(...images);
  await product.save();

  res.status(201).json({
    ...toPublicProduct(product),
    ...(imageWarnings.length > 0 ? { imageWarnings } : {}),
  });
});

// @desc    Remove one image from one of my products
// @route   DELETE /api/store-profiles/me/products/:id/images/:fileName
// @access  Private
export const removeProductImage = asyncHandler(async (req: Request, res: Response) => {
  const requester = req.user as IUser;
  const { store, product } = await loadMyProduct(requester.id, req.params.id as string);

  if (!store) {
    res.status(404);
    throw new Error("You don't have a store profile yet");
  }
  if (!product) {
    res.status(404);
    throw new Error("Product not found");
  }

  const fileName = req.params.fileName as string;
  const image = product.images.find((img) => img.fileName === fileName);

  if (!image) {
    res.status(404);
    throw new Error("Image not found on this product");
  }

  await deleteStoredFile(image.storagePath);
  product.images = product.images.filter((img) => img.fileName !== fileName) as typeof product.images;
  await product.save();

  res.status(200).json(toPublicProduct(product));
});

// @desc    View a single product directly — the URL always resolves, but
//          (matching getStore/getProfile) it's withheld unless the
//          *owning store* is currently subscribed, checked live with one
//          extra query. This is the one place a product needs any
//          awareness of subscription status at all, and it's still never
//          stored on the product itself.
// @route   GET /api/products/:id
// @access  Public
export const getProduct = asyncHandler(async (req: Request, res: Response) => {
  const id = req.params.id as string;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    res.status(404);
    throw new Error("Product not found");
  }

  const product = await Product.findById(id);
  if (!product) {
    res.status(404);
    throw new Error("Product not found");
  }

  const store = await StoreProfile.findById(product.storeId);
  const subscription =
    store?.currentSubscription ? await Subscription.findById(store.currentSubscription) : null;

  if (!subscription?.isActive()) {
    res.status(200).json({ available: false, message: "This product is not currently available." });
    return;
  }

  res.status(200).json(toPublicProduct(product));
});
