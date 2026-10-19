import { Request, Response, NextFunction } from "express";

// Exported so the Socket.IO server (src/socket/index.ts) can allow the
// same origins for its own handshake — one list, not two to keep in sync.
export const ALLOWED_ORIGINS = [
  "http://localhost:3000",
  // polygrid-frontend's Vite dev server is fixed to :5009 (strictPort,
  // see its vite.config.ts) — plain /api calls are proxied around CORS
  // entirely in dev, but Socket.IO's handshake connects directly to this
  // origin (ALLOWED_ORIGINS is shared with it, see below), so it still
  // needs to be on this list for chat to work locally.
  "http://localhost:5009",
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
