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
  getMyProducts,
  updateProduct,
  deleteProduct,
  addProductImages,
  removeProductImage,
} from "../controllers/productController";
import { protect } from "../middleware/authMiddleware";
import { validateBody } from "../validators/validate";
import {
  createStoreProfileSchema,
  updateStoreProfileSchema,
} from "../validators/storeProfile/storeProfileValidator";
import { createProductSchema, updateProductSchema } from "../validators/product/productValidator";

const router = express.Router();

router.post("/", protect, validateBody(createStoreProfileSchema), createStoreProfile);
router.get("/", searchStores);
router.get("/me", protect, getMyStoreProfile);
router.patch("/me", protect, validateBody(updateStoreProfileSchema), updateMyStoreProfile);
router.post("/me/logo", protect, uploadStoreLogo);

router.get("/me/products", protect, getMyProducts);
router.post("/me/products", protect, validateBody(createProductSchema), createProduct);
router.patch("/me/products/:id", protect, validateBody(updateProductSchema), updateProduct);
router.delete("/me/products/:id", protect, deleteProduct);
router.post("/me/products/:id/images", protect, addProductImages);
router.delete("/me/products/:id/images/:fileName", protect, removeProductImage);

// Catch-all by id/slug — must stay last so it doesn't shadow the routes above.
router.get("/:idOrSlug", getStore);

export default router;
