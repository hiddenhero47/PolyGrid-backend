import express from "express";
import {
  createContractorProfile,
  getMyContractorProfile,
  updateMyContractorProfile,
  searchContractors,
  getContractor,
  addPortfolioItem,
  addPortfolioMedia,
  removePortfolioMedia,
  removePortfolioItem,
} from "../controllers/contractorProfileController";
import { protect } from "../middleware/authMiddleware";

const router = express.Router();

router.post("/", protect, createContractorProfile);
router.get("/", searchContractors);
router.get("/me", protect, getMyContractorProfile);
router.patch("/me", protect, updateMyContractorProfile);

router.post("/me/portfolio", protect, addPortfolioItem);
router.post("/me/portfolio/:itemId/media", protect, addPortfolioMedia);
router.delete("/me/portfolio/:itemId/media/:fileName", protect, removePortfolioMedia);
router.delete("/me/portfolio/:itemId", protect, removePortfolioItem);

// Catch-all by id/slug — must stay last so it doesn't shadow the routes above.
router.get("/:idOrSlug", getContractor);

export default router;
