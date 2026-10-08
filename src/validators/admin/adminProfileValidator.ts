import * as yup from "yup";
import { PROFILE_STATUS } from "../../constants/profileStatus";

// Admin can only ever set 'active' (unban/reactivate) or 'banned' here —
// never 'inactive', which is self-service only, set through each
// profile's own update endpoint instead (see validators/common.ts's
// selfServiceProfileStatus).
export const setProfileStatusSchema = yup
  .object({
    status: yup
      .string()
      .oneOf([PROFILE_STATUS.ACTIVE, PROFILE_STATUS.BANNED], "status must be 'active' or 'banned'")
      .required("status must be 'active' or 'banned'"),
  })
  .noUnknown(true);
