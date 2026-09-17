import { Request, Response, NextFunction } from "express";

const ALLOWED_ORIGINS = [
  "http://localhost:3000",
  "http://localhost:5173",
  "https://polygrid.com",
  "https://www.polygrid.com",
]; // update to match the deployed frontend origin(s)

const handleCors = (req: Request, res: Response, next: NextFunction): void => {
  const requestOrigin = req.headers.origin;

  // Credentials: 'include' on the frontend requires an exact origin, never "*".
  if (requestOrigin && ALLOWED_ORIGINS.includes(requestOrigin)) {
    res.setHeader("Access-Control-Allow-Origin", requestOrigin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }

  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, PATCH, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Requested-With",
  );
  res.setHeader("Vary", "Origin");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  next();
};

export default handleCors;
