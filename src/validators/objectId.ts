import * as yup from "yup";
import mongoose from "mongoose";

// Shared by every validator that takes a Mongo _id as a plain string body
// field (a counterparty user, a bid id, a source id, ...) — yup has no
// native ObjectId type, so this is one reusable base schema instead of
// the same `.test()` copy-pasted into every file that needs it. Returns
// true for an empty value on purpose — emptiness is `.required()`'s job
// to catch, composed separately, not this test's.
export const objectIdString = (message = "must be a valid id"): yup.StringSchema =>
  yup.string().test("is-object-id", message, (value) => !value || mongoose.Types.ObjectId.isValid(value));
