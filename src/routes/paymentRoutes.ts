import express from "express";
import {
  getMyPayments,
  getPayments,
  createPaymentIntent,
  refreshPayment,
  stripeWebhook,
  stripeConnectWebhook,
} from "../controllers/paymentController";
import { protect, secureRole } from "../middleware/authMiddleware";
import { SYSTEM_ROLE } from "../models/userModel";
import { validateBody } from "../validators/validate";
import { createPaymentIntentSchema } from "../validators/payment/paymentValidator";

const router = express.Router();

router.get("/me", protect, getMyPayments);
router.get("/", secureRole([SYSTEM_ROLE.ADMIN, SYSTEM_ROLE.SUPER_ADMIN]), getPayments);
router.post("/intent", protect, validateBody(createPaymentIntentSchema), createPaymentIntent);
router.post("/:id/refresh", protect, refreshPayment);
// No `protect` — Stripe calls this directly, authenticated by signature
// (see stripeWebhook). Body must stay raw for signature verification; the
// raw-body scoping for this exact path is registered in app.ts, before the
// global express.json().
router.post("/stripe/webhook", stripeWebhook);
// Same raw-body/no-`protect` reasoning as /stripe/webhook above, just a
// separate Connect-specific endpoint with its own signing secret — see
// helpers/stripeConnect.ts's constructConnectWebhookEvent.
router.post("/stripe/connect-webhook", stripeConnectWebhook);

export default router;
