import express from "express";
import { getProduct } from "../controllers/productController";

const router = express.Router();

router.get("/:id", getProduct);

export default router;
