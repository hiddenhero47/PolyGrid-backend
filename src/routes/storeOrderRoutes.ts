import express from "express";
import { createOrder, getMyOrders, getStoreOrders } from "../controllers/storeOrderController";
import { protect } from "../middleware/authMiddleware";

const router = express.Router();

router.post("/", protect, createOrder);
router.get("/mine", protect, getMyOrders);
router.get("/store", protect, getStoreOrders);

export default router;
