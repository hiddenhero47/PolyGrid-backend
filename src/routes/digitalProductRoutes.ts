import express from "express";
import {
  listDigitalProductFeed,
  getDigitalProduct,
  getDigitalProductDownloadLink,
  setDigitalProductVerification,
} from "../controllers/digitalProductController";
import { protect, secureRole } from "../middleware/authMiddleware";
import { REVIEW_ROLES } from "../models/userModel";
import { validateBody } from "../validators/validate";
import { setDigitalProductVerificationSchema } from "../validators/digitalProduct/digitalProductValidator";

const router = express.Router();

router.get("/feed", listDigitalProductFeed);
router.get("/:id/download", protect, getDigitalProductDownloadLink);
router.patch(
  "/:id/verify",
  secureRole([...REVIEW_ROLES]),
  validateBody(setDigitalProductVerificationSchema),
  setDigitalProductVerification,
);
router.get("/:id", getDigitalProduct);

export default router;
