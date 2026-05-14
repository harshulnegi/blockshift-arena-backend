import "dotenv/config";
import http from "node:http";
import path from "node:path";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import Redis from "ioredis";
import { createAdapter } from "@socket.io/redis-adapter";
import { attachSocketServer } from "./socket.js";
import { createApiRouter } from "./routes/api.js";

const app = express();
const storageDir = process.env.BLOCKSHIFT_STORAGE_DIR || path.join(process.cwd(), "storage");
const avatarDir = process.env.AVATAR_DIR || path.join(storageDir, "avatars");
app.set("trust proxy", 1);
app.use(helmet());
app.use(cors({ origin: process.env.CLIENT_ORIGIN || "*", credentials: true }));
app.use(express.json({ limit: "1mb" }));
app.use(rateLimit({ windowMs: 60000, limit: 240 }));
app.use("/avatars", express.static(avatarDir, {
  maxAge: "1h",
  setHeaders: (res) => {
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    res.setHeader("Cache-Control", "public, max-age=3600");
  }
}));
app.get("/health", (_req, res) => res.json({ ok: true, service: "blockshift-arena", at: new Date().toISOString() }));
app.use("/api", createApiRouter());

const server = http.createServer(app);
let redis = null;
if (process.env.REDIS_URL) {
  const pub = new Redis(process.env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 2 });
  const sub = pub.duplicate();
  const results = await Promise.allSettled([pub.connect(), sub.connect()]);
  if (results.every((result) => result.status === "fulfilled")) {
    redis = pub;
    const io = attachSocketServer(server, redis);
    io.adapter(createAdapter(pub, sub));
    console.log("Redis matchmaking and Socket.IO adapter connected");
  } else {
    await Promise.allSettled([pub.disconnect(), sub.disconnect()]);
    console.warn("Redis connection failed; falling back to single-node in-memory matchmaking");
    attachSocketServer(server, null);
  }
} else {
  attachSocketServer(server, null);
}

const port = Number(process.env.PORT || 8080);
server.listen(port, () => {
  console.log(`BlockShift Arena backend listening on :${port}`);
});
