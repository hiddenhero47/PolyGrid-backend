import express from "express";
import { listPlans, getPlan, createPlan, updatePlan } from "../controllers/planController";
import { secureRole } from "../middleware/authMiddleware";
import { SYSTEM_ROLE } from "../models/userModel";
import { validateBody } from "../validators/validate";
import { createPlanSchema, updatePlanSchema } from "../validators/plan/planValidator";

const router = express.Router();

router.get("/", listPlans);
router.get("/:id", getPlan);
router.post("/", secureRole(SYSTEM_ROLE.SUPER_ADMIN), validateBody(createPlanSchema), createPlan);
router.put("/:id", secureRole(SYSTEM_ROLE.SUPER_ADMIN), validateBody(updatePlanSchema), updatePlan);

export default router;
