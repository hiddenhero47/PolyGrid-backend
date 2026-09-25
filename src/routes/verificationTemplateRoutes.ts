import express from "express";
import { createTemplate, getTemplates, lookupTemplate } from "../controllers/verificationTemplateController";
import { protect, secureRole } from "../middleware/authMiddleware";
import { SYSTEM_ROLE } from "../models/userModel";
import { validateBody } from "../validators/validate";
import { createTemplateSchema } from "../validators/verificationTemplateValidator";

const router = express.Router();

router.post(
  "/",
  secureRole([SYSTEM_ROLE.ADMIN, SYSTEM_ROLE.SUPER_ADMIN]),
  validateBody(createTemplateSchema),
  createTemplate,
);
router.get("/", secureRole([SYSTEM_ROLE.ADMIN, SYSTEM_ROLE.SUPER_ADMIN]), getTemplates);
// A named path, not a param — so it can never collide with a future
// GET /:id if one gets added later.
router.get("/lookup", protect, lookupTemplate);

export default router;
