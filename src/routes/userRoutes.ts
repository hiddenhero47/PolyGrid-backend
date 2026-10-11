import express from "express";
import {
  registerUser,
  loginUser,
  googleLogin,
  appleLogin,
  getMe,
  updateUserProfile,
  toggleAccountType,
  updatePayoutAccount,
  setupTwoFactor,
  verifyTwoFactor,
  toggleTwoFactor,
  logoutAll,
  requestReset,
  resetPassword,
  registerAdmin,
  getUsers,
  changeUserRole,
  setAccountStatus,
} from "../controllers/userController";
import { protect, secureRole } from "../middleware/authMiddleware";
import { verifyIdentity } from "../middleware/verifyIdentityMiddleware";
import { SYSTEM_ROLE } from "../models/userModel";
import { validateBody } from "../validators/validate";
import {
  registerUserSchema,
  loginUserSchema,
  googleLoginSchema,
  appleLoginSchema,
  updateUserProfileSchema,
  toggleAccountTypeSchema,
  updatePayoutAccountSchema,
  setupTwoFactorSchema,
  verifyTwoFactorSchema,
  toggleTwoFactorSchema,
  requestResetSchema,
  resetPasswordSchema,
  registerAdminSchema,
  changeUserRoleSchema,
  setAccountStatusSchema,
} from "../validators/user/userValidator";

const router = express.Router();

router.post("/", validateBody(registerUserSchema), registerUser);
router.post("/login", validateBody(loginUserSchema), loginUser);
router.post("/social/google", validateBody(googleLoginSchema), googleLogin);
router.post("/social/apple", validateBody(appleLoginSchema), appleLogin);
router.post("/request-reset", validateBody(requestResetSchema), requestReset);
router.post("/reset-password", validateBody(resetPasswordSchema), resetPassword);

router.get("/me", protect, getMe);
router.put("/profile", protect, validateBody(updateUserProfileSchema), updateUserProfile);
router.patch("/account-type", protect, validateBody(toggleAccountTypeSchema), toggleAccountType);
router.put(
  "/payout-account",
  protect,
  verifyIdentity,
  validateBody(updatePayoutAccountSchema),
  updatePayoutAccount,
);

router.post(
  "/2fa/setup",
  protect,
  verifyIdentity,
  validateBody(setupTwoFactorSchema),
  setupTwoFactor,
);
router.post("/2fa/verify", protect, validateBody(verifyTwoFactorSchema), verifyTwoFactor);
router.put(
  "/2fa/toggle",
  protect,
  verifyIdentity,
  validateBody(toggleTwoFactorSchema),
  toggleTwoFactor,
);

router.patch("/invalidate", protect, logoutAll);

router.post(
  "/admin-create",
  secureRole(SYSTEM_ROLE.SUPER_ADMIN),
  validateBody(registerAdminSchema),
  registerAdmin,
);
router.get("/", secureRole(SYSTEM_ROLE.SUPER_ADMIN), getUsers);
router.patch(
  "/:id/role",
  secureRole(SYSTEM_ROLE.SUPER_ADMIN),
  validateBody(changeUserRoleSchema),
  changeUserRole,
);
router.patch(
  "/:id/account-status",
  secureRole(SYSTEM_ROLE.SUPER_ADMIN),
  validateBody(setAccountStatusSchema),
  setAccountStatus,
);

export default router;
