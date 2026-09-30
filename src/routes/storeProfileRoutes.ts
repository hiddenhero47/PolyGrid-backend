import express from "express";
import {
  createStoreProfile,
  getMyStoreProfile,
  updateMyStoreProfile,
  uploadStoreLogo,
  searchStores,
  getStore,
} from "../controllers/storeProfileController";
import {
  createProduct,
  updateProduct,
  deleteProduct,
  addProductImages,
  removeProductImage,
} from "../controllers/productController";
import { protect } from "../middleware/authMiddleware";

const router = express.Router();

router.post("/", protect, createStoreProfile);
router.get("/", searchStores);
router.get("/me", protect, getMyStoreProfile);
router.patch("/me", protect, updateMyStoreProfile);
router.post("/me/logo", protect, uploadStoreLogo);

router.post("/me/products", protect, createProduct);
router.patch("/me/products/:id", protect, updateProduct);
router.delete("/me/products/:id", protect, deleteProduct);
router.post("/me/products/:id/images", protect, addProductImages);
router.delete("/me/products/:id/images/:fileName", protect, removeProductImage);

// Catch-all by id/slug — must stay last so it doesn't shadow the routes above.
router.get("/:idOrSlug", getStore);

export default router;
