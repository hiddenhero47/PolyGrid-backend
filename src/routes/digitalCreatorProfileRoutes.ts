import express from "express";
import {
  createDigitalCreatorProfile,
  getMyDigitalCreatorProfile,
  updateMyDigitalCreatorProfile,
  uploadDigitalCreatorAvatar,
  getDigitalCreatorProfile,
} from "../controllers/digitalCreatorProfileController";
import {
  createDigitalProduct,
  updateDigitalProduct,
  addDigitalProductPreviewImages,
  removeDigitalProductPreviewImage,
  addDigitalProductFiles,
} from "../controllers/digitalProductController";
import { protect } from "../middleware/authMiddleware";

const router = express.Router();

router.post("/", protect, createDigitalCreatorProfile);
router.get("/me", protect, getMyDigitalCreatorProfile);
router.patch("/me", protect, updateMyDigitalCreatorProfile);
router.post("/me/avatar", protect, uploadDigitalCreatorAvatar);

router.post("/me/products", protect, createDigitalProduct);
router.patch("/me/products/:id", protect, updateDigitalProduct);
router.post("/me/products/:id/preview-images", protect, addDigitalProductPreviewImages);
router.delete("/me/products/:id/preview-images/:fileName", protect, removeDigitalProductPreviewImage);
router.post("/me/products/:id/files", protect, addDigitalProductFiles);

// Catch-all by id/slug — must stay last so it doesn't shadow the routes above.
router.get("/:idOrSlug", getDigitalCreatorProfile);

export default router;
