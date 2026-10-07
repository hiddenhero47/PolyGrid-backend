import express from "express";
import { addContact, getContacts, removeContact } from "../controllers/contactController";
import { protect } from "../middleware/authMiddleware";
import { validateBody } from "../validators/validate";
import { addContactSchema } from "../validators/contact/contactValidator";

const router = express.Router();

router.use(protect);

router.post("/", validateBody(addContactSchema), addContact);
router.get("/", getContacts);
router.delete("/:userId", removeContact);

export default router;
