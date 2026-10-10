import * as yup from "yup";
import { objectIdString } from "../objectId";

// The controller's own `if (userId) {...} else if (email) {...}`
// priority (userId wins when both are sent) is a business choice, not
// a shape rule — it stays in contactController.ts unchanged. This only
// validates each field's own format when present, and that at least
// one of the two was actually sent.
export const addContactSchema = yup
  .object({
    userId: objectIdString("Invalid user id").notRequired(),
    email: yup.string().trim().notRequired(),
  })
  .noUnknown(true)
  .test("has-identifier", "Provide a userId or email", (value) => !!(value?.userId || value?.email));
