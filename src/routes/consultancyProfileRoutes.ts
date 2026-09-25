import express from "express";
import {
  createProfile,
  getMyProfile,
  updateMyProfile,
  searchConsultants,
  getProfile,
  addPortfolioItem,
  addPortfolioMedia,
  removePortfolioMedia,
  removePortfolioItem,
} from "../controllers/consultancyProfileController";
import { protect } from "../middleware/authMiddleware";

const router = express.Router();

router.post("/", protect, createProfile);
router.get("/", searchConsultants);
router.get("/me", protect, getMyProfile);
router.patch("/me", protect, updateMyProfile);
router.post("/me/portfolio", protect, addPortfolioItem);
router.post("/me/portfolio/:itemId/media", protect, addPortfolioMedia);
router.delete("/me/portfolio/:itemId/media/:fileName", protect, removePortfolioMedia);
router.delete("/me/portfolio/:itemId", protect, removePortfolioItem);
// Catch-all by id/slug — must stay last so it doesn't shadow /me above.
router.get("/:idOrSlug", getProfile);

export default router;
