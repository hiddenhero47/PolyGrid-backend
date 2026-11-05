import express from "express";
import { getSettings, updateSettings } from "../controllers/systemSettingsController";
import { secureRole } from "../middleware/authMiddleware";
import { SYSTEM_ROLE, REVIEW_ROLES } from "../models/userModel";
import { validateBody } from "../validators/validate";
import { updateSystemSettingsSchema } from "../validators/admin/systemSettingsValidator";

const router = express.Router();

router.get("/", secureRole([...REVIEW_ROLES]), getSettings);
router.patch("/", secureRole([SYSTEM_ROLE.SUPER_ADMIN]), validateBody(updateSystemSettingsSchema), updateSettings);

export default router;
