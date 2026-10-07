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
import { validateBody } from "../validators/validate";
import {
  createContractorProfileSchema,
  updateContractorProfileSchema,
  addPortfolioItemSchema,
} from "../validators/contractorProfile/contractorProfileValidator";

const router = express.Router();

router.post("/", protect, validateBody(createContractorProfileSchema), createContractorProfile);
router.get("/", searchContractors);
router.get("/me", protect, getMyContractorProfile);
router.patch("/me", protect, validateBody(updateContractorProfileSchema), updateMyContractorProfile);

router.post("/me/portfolio", protect, validateBody(addPortfolioItemSchema), addPortfolioItem);
router.post("/me/portfolio/:itemId/media", protect, addPortfolioMedia);
router.delete("/me/portfolio/:itemId/media/:fileName", protect, removePortfolioMedia);
router.delete("/me/portfolio/:itemId", protect, removePortfolioItem);

// Catch-all by id/slug — must stay last so it doesn't shadow the routes above.
router.get("/:idOrSlug", getContractor);

export default router;
