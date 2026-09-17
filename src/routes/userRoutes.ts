import express from "express";
import {
  registerUser,
  loginUser,
  getMe,
  updateUserProfile,
  toggleAccountType,
  logoutAll,
  requestReset,
  resetPassword,
  registerAdmin,
  getUsers,
  changeUserRole,
  updateUserSubscription,
} from "../controllers/userController";
import { protect, secureRole } from "../middleware/authMiddleware";
import { SYSTEM_ROLE } from "../models/userModel";

const router = express.Router();

router.post("/", registerUser);
router.post("/login", loginUser);
router.post("/request-reset", requestReset);
router.post("/reset-password", resetPassword);

router.get("/me", protect, getMe);
router.put("/profile", protect, updateUserProfile);
router.patch("/account-type", protect, toggleAccountType);
router.patch("/invalidate", protect, logoutAll);

router.post(
  "/admin-create",
  secureRole(SYSTEM_ROLE.SUPER_ADMIN),
  registerAdmin,
);
router.get("/", secureRole(SYSTEM_ROLE.SUPER_ADMIN), getUsers);
router.patch(
  "/:id/role",
  secureRole(SYSTEM_ROLE.SUPER_ADMIN),
  changeUserRole,
);
router.patch(
  "/:id/subscription",
  secureRole([SYSTEM_ROLE.ADMIN, SYSTEM_ROLE.SUPER_ADMIN]),
  updateUserSubscription,
);

export default router;
