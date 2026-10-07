import express from "express";
import { createOrder, getMyOrders, getStoreOrders } from "../controllers/storeOrderController";
import { protect } from "../middleware/authMiddleware";
import { validateBody } from "../validators/validate";
import { createOrderSchema } from "../validators/storeOrder/storeOrderValidator";

const router = express.Router();

router.post("/", protect, validateBody(createOrderSchema), createOrder);
router.get("/mine", protect, getMyOrders);
router.get("/store", protect, getStoreOrders);

export default router;
