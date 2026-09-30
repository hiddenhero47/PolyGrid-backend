import express from "express";
import {
  listCountries,
  listStates,
  listCities,
  listCurrencies,
} from "../controllers/referenceController";

const router = express.Router();

router.get("/countries", listCountries);
router.get("/countries/:countryCode/states", listStates);
router.get("/countries/:countryCode/cities", listCities);
router.get("/currencies", listCurrencies);

export default router;
