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
  uploadAvatar,
} from "../controllers/laborProfileController";
import { protect } from "../middleware/authMiddleware";
import { validateBody } from "../validators/validate";
import {
  createLaborProfileSchema,
  updateLaborProfileSchema,
  addPortfolioItemSchema,
} from "../validators/laborProfile/laborProfileValidator";

const router = express.Router();

router.post("/", protect, validateBody(createLaborProfileSchema), createLaborProfile);
router.get("/", searchWorkers);
router.get("/me", protect, getMyLaborProfile);
router.patch("/me", protect, validateBody(updateLaborProfileSchema), updateMyLaborProfile);
router.post("/me/avatar", protect, uploadAvatar);

router.post("/me/portfolio", protect, validateBody(addPortfolioItemSchema), addPortfolioItem);
router.post("/me/portfolio/:itemId/media", protect, addPortfolioMedia);
router.delete("/me/portfolio/:itemId/media/:fileName", protect, removePortfolioMedia);
router.delete("/me/portfolio/:itemId", protect, removePortfolioItem);

// Catch-all by id/slug — must stay last so it doesn't shadow the routes above.
router.get("/:idOrSlug", getWorker);

export default router;
