import mongoose from "mongoose";
import { User } from "../models/userModel";
import { IMediaFile } from "../models/mediaFile";

// Consultancy/Contractor/Labor/Client profiles have no avatar of their
// own by default — rather than making everyone upload a duplicate photo
// per profile just to avoid a faceless page, a profile falls back to the
// account-level avatar (User.avatar) whenever its own isn't set. Only
// ever called from a single-profile view (getMyProfile/getProfile) when
// the profile's own avatar is already known to be unset — list/search
// results skip this extra lookup entirely; a thumbnail in a results grid
// matters less than the photo on the actual page someone's looking at.
export const getAccountAvatar = async (
  userId: mongoose.Types.ObjectId,
): Promise<IMediaFile | undefined> => {
  const owner = await User.findById(userId).select("avatar");
  return owner?.avatar;
};
