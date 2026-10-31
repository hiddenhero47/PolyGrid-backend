import express from "express";
import {
  getSystemPayouts,
  markSystemPayoutPaid,
  markSystemPayoutFailed,
} from "../controllers/systemPayoutController";
import { secureRole } from "../middleware/authMiddleware";
import { SYSTEM_ROLE } from "../models/userModel";
import { validateBody } from "../validators/validate";
import {
  markSystemPayoutPaidSchema,
  markSystemPayoutFailedSchema,
} from "../validators/systemPayout/systemPayoutValidator";

const router = express.Router();

const adminOnly = secureRole([SYSTEM_ROLE.ADMIN, SYSTEM_ROLE.SUPER_ADMIN]);

router.get("/", adminOnly, getSystemPayouts);
router.patch("/:id/paid", adminOnly, validateBody(markSystemPayoutPaidSchema), markSystemPayoutPaid);
router.patch("/:id/failed", adminOnly, validateBody(markSystemPayoutFailedSchema), markSystemPayoutFailed);

export default router;
