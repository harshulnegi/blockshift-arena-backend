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
const emailAssetDir = path.join(process.cwd(), "public", "email-assets");
const useSocketRedisAdapter = envFlag("SOCKET_REDIS_ADAPTER_ENABLED", false);
const useRedisMatchmaker = envFlag("MATCHMAKER_REDIS_ENABLED", false);
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
app.use("/email-assets", express.static(emailAssetDir, {
  maxAge: "24h",
  setHeaders: (res) => {
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    res.setHeader("Cache-Control", "public, max-age=86400");
  }
}));
app.get("/health", (_req, res) => res.json({ ok: true, service: "blockshift-arena", at: new Date().toISOString() }));
app.use("/api", createApiRouter());

const server = http.createServer(app);
let redis = null;
if (process.env.REDIS_URL) {
  const primary = new Redis(process.env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 2, enableOfflineQueue: false });
  const primaryResult = await Promise.allSettled([primary.connect()]);
  if (primaryResult[0].status === "fulfilled") {
    redis = primary;
    const io = attachSocketServer(server, redis, { matchmakerRedis: useRedisMatchmaker ? redis : null });
    if (useSocketRedisAdapter) {
      const sub = redis.duplicate({ lazyConnect: true, maxRetriesPerRequest: 2, enableOfflineQueue: false });
      const subResult = await Promise.allSettled([sub.connect()]);
      if (subResult[0].status === "fulfilled") {
        io.adapter(createAdapter(redis, sub));
        console.log("Redis active cache, matchmaking, and Socket.IO adapter connected", { matchmakerRedis: useRedisMatchmaker });
      } else {
        await sub.disconnect().catch(() => {});
        console.warn("Socket.IO Redis adapter disabled after subscriber connection failed");
      }
    } else {
      console.log("Redis active match cache connected; Socket.IO adapter disabled for single-instance efficiency", { matchmakerRedis: useRedisMatchmaker });
    }
  } else {
    await primary.disconnect().catch(() => {});
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

function envFlag(name, defaultValue = false) {
  const value = String(process.env[name] ?? "").trim().toLowerCase();
  if (!value) return defaultValue;
  return ["1", "true", "yes", "on"].includes(value);
}
