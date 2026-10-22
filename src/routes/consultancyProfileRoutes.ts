import express from "express";
import {
  createProfile,
  getMyProfile,
  updateMyProfile,
  searchConsultants,
  getProfile,
  addPortfolioItem,
  updatePortfolioItem,
  addPortfolioMedia,
  removePortfolioMedia,
  removePortfolioItem,
  uploadAvatar,
} from "../controllers/consultancyProfileController";
import { protect } from "../middleware/authMiddleware";
import { validateBody } from "../validators/validate";
import {
  createConsultancyProfileSchema,
  updateConsultancyProfileSchema,
  addPortfolioItemSchema,
  updatePortfolioItemSchema,
} from "../validators/consultancyProfile/consultancyProfileValidator";

const router = express.Router();

router.post("/", protect, validateBody(createConsultancyProfileSchema), createProfile);
router.get("/", searchConsultants);
router.get("/me", protect, getMyProfile);
router.patch("/me", protect, validateBody(updateConsultancyProfileSchema), updateMyProfile);
router.post("/me/avatar", protect, uploadAvatar);
router.post("/me/portfolio", protect, validateBody(addPortfolioItemSchema), addPortfolioItem);
router.patch("/me/portfolio/:itemId", protect, validateBody(updatePortfolioItemSchema), updatePortfolioItem);
router.post("/me/portfolio/:itemId/media", protect, addPortfolioMedia);
router.delete("/me/portfolio/:itemId/media/:fileName", protect, removePortfolioMedia);
router.delete("/me/portfolio/:itemId", protect, removePortfolioItem);
// Catch-all by id/slug — must stay last so it doesn't shadow /me above.
router.get("/:idOrSlug", getProfile);

export default router;
