import express from "express";
import {
  createClientProfile,
  getMyClientProfile,
  updateMyClientProfile,
  getClientProfile,
  uploadAvatar,
} from "../controllers/clientProfileController";
import { protect } from "../middleware/authMiddleware";
import { validateBody } from "../validators/validate";
import {
  createClientProfileSchema,
  updateClientProfileSchema,
} from "../validators/clientProfile/clientProfileValidator";

const router = express.Router();

router.post("/", protect, validateBody(createClientProfileSchema), createClientProfile);
router.get("/me", protect, getMyClientProfile);
router.patch("/me", protect, validateBody(updateClientProfileSchema), updateMyClientProfile);
router.post("/me/avatar", protect, uploadAvatar);

// Catch-all by id — must stay last so it doesn't shadow /me.
router.get("/:id", getClientProfile);

export default router;
