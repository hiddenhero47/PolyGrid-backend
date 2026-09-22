import express from "express";
import {
  getMyPayments,
  getPayments,
  createPaymentIntent,
  stripeWebhook,
} from "../controllers/paymentController";
import { protect, secureRole } from "../middleware/authMiddleware";
import { SYSTEM_ROLE } from "../models/userModel";

const router = express.Router();

router.get("/me", protect, getMyPayments);
router.get("/", secureRole([SYSTEM_ROLE.ADMIN, SYSTEM_ROLE.SUPER_ADMIN]), getPayments);
router.post("/intent", protect, createPaymentIntent);
// No `protect` — Stripe calls this directly, authenticated by signature
// (see stripeWebhook). Body must stay raw for signature verification; the
// raw-body scoping for this exact path is registered in app.ts, before the
// global express.json().
router.post("/stripe/webhook", stripeWebhook);

export default router;
