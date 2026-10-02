import express from "express";
import {
  createLaborProfile,
  getMyLaborProfile,
  updateMyLaborProfile,
  searchWorkers,
  getWorker,
  addPortfolioItem,
  addPortfolioMedia,
  removePortfolioMedia,
  removePortfolioItem,
} from "../controllers/laborProfileController";
import { protect } from "../middleware/authMiddleware";

const router = express.Router();

router.post("/", protect, createLaborProfile);
router.get("/", searchWorkers);
router.get("/me", protect, getMyLaborProfile);
router.patch("/me", protect, updateMyLaborProfile);

router.post("/me/portfolio", protect, addPortfolioItem);
router.post("/me/portfolio/:itemId/media", protect, addPortfolioMedia);
router.delete("/me/portfolio/:itemId/media/:fileName", protect, removePortfolioMedia);
router.delete("/me/portfolio/:itemId", protect, removePortfolioItem);

// Catch-all by id/slug — must stay last so it doesn't shadow the routes above.
router.get("/:idOrSlug", getWorker);

export default router;
