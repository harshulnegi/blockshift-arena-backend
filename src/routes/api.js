import { Router } from "express";
import { chooseAiAction } from "../game/ai.js";
import { createInitialState, applyAction, legalMoves } from "../game/rules.js";
import { requireAuth, signAppToken } from "../middleware/auth.js";
import { detectCountryFromRequest, resolveProfileCountry } from "../services/geo.js";
import { cachedHiveSnapshot, hiveStats, publicHiveEdge } from "../services/hive.js";
import {
  assertProfileHandleAvailable,
  cleanAuthHandle,
  deleteAccount,
  loginGuestAccount,
  loginGoogleAccount,
  loginPasswordAccount,
  requestPasswordResetOtp,
  requestRegistrationOtp,
  registerPasswordAccount,
  requestEmailOtp,
  resetPasswordWithOtp,
  sessionProfile,
  syncAccountHandle,
  verifyRegistrationOtp,
  verifyEmailOtp
} from "../services/authStore.js";
import { findProfile, leaderboard, MAX_AVATAR_BYTES, searchProfiles, updateProfileAvatar, upsertProfile } from "../services/matchStore.js";

export function createApiRouter() {
  const router = Router();

  router.post("/auth/register", async (req, res) => {
    try {
      const country = resolveProfileCountry(req, req.body.country, req.body.localeCountry);
      const { profile } = await registerPasswordAccount({ ...req.body, country });
      sendAuth(res, profile);
    } catch (error) {
      sendAuthError(res, error);
    }
  });

  router.post("/auth/register/request", async (req, res) => {
    try {
      res.json(await requestRegistrationOtp(req.body));
    } catch (error) {
      sendAuthError(res, error);
    }
  });

  router.post("/auth/register/verify", async (req, res) => {
    try {
      const country = resolveProfileCountry(req, req.body.country, req.body.localeCountry);
      const { profile } = await verifyRegistrationOtp({ ...req.body, country });
      sendAuth(res, profile);
    } catch (error) {
      sendAuthError(res, error);
    }
  });

  router.post("/auth/login", async (req, res) => {
    try {
      const { profile } = await loginPasswordAccount(req.body);
      sendAuth(res, profile);
    } catch (error) {
      sendAuthError(res, error);
    }
  });

  router.post("/auth/google", async (req, res) => {
    try {
      const country = resolveProfileCountry(req, req.body.country, req.body.localeCountry);
      const { profile } = await loginGoogleAccount({ ...req.body, country });
      sendAuth(res, profile);
    } catch (error) {
      sendAuthError(res, error);
    }
  });

  router.post("/auth/guest", async (req, res) => {
    try {
      const country = resolveProfileCountry(req, req.body.country, req.body.localeCountry);
      const { profile } = await loginGuestAccount({ ...req.body, country });
      sendAuth(res, profile);
    } catch (error) {
      sendAuthError(res, error);
    }
  });

  router.post("/auth/otp/request", async (req, res) => {
    try {
      res.json(await requestEmailOtp(req.body));
    } catch (error) {
      sendAuthError(res, error);
    }
  });

  router.post("/auth/otp/verify", async (req, res) => {
    try {
      const country = resolveProfileCountry(req, req.body.country, req.body.localeCountry);
      const { profile } = await verifyEmailOtp({ ...req.body, country });
      sendAuth(res, profile);
    } catch (error) {
      sendAuthError(res, error);
    }
  });

  router.post("/auth/password/reset/request", async (req, res) => {
    try {
      res.json(await requestPasswordResetOtp(req.body));
    } catch (error) {
      sendAuthError(res, error);
    }
  });

  router.post("/auth/password/reset/verify", async (req, res) => {
    try {
      const country = resolveProfileCountry(req, req.body.country, req.body.localeCountry);
      const { profile } = await resetPasswordWithOtp({ ...req.body, country });
      sendAuth(res, profile);
    } catch (error) {
      sendAuthError(res, error);
    }
  });

  router.get("/auth/session", requireAuth, async (req, res) => {
    try {
      const { profile } = await sessionProfile(req.user);
      sendAuth(res, profile);
    } catch (error) {
      sendAuthError(res, error);
    }
  });

  router.post("/auth/delete", requireAuth, async (req, res) => {
    try {
      res.json(await deleteAccount({ user: req.user, confirmation: req.body.confirmation }));
    } catch (error) {
      sendAuthError(res, error);
    }
  });

  router.post("/auth/dev", async (req, res) => {
    const id = req.body.id || `dev_${Math.random().toString(36).slice(2, 8)}`;
    const handle = cleanHandle(req.body.handle);
    const country = resolveProfileCountry(req, req.body.country, req.body.localeCountry);
    const profile = await upsertProfile({ id, handle, name: req.body.name || handle, country });
    sendAuth(res, profile);
  });

  router.get("/geo/country", (req, res) => {
    res.json(detectCountryFromRequest(req, req.query.localeCountry || req.get("x-client-country")));
  });

  router.get("/leaderboard", async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit || 100), 1), 100);
    res.json({ players: await leaderboard(limit) });
  });

  router.get("/hive/status", (req, res) => {
    res.json({ edge: publicHiveEdge(resolveProfileCountry(req, req.query.region, req.query.localeCountry)), stats: hiveStats() });
  });

  router.get("/hive/snapshot", async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit || 30), 1), 50);
    const region = resolveProfileCountry(req, req.query.region, req.query.localeCountry).toLowerCase();
    const snapshot = await cachedHiveSnapshot(`leaderboard:${region}:${limit}`, async () => ({
      type: "leaderboard",
      region,
      players: await leaderboard(limit)
    }));
    res.json(snapshot);
  });

  router.get("/profile/public", async (req, res) => {
    const profile = await findProfile(req.query.lookup);
    if (!profile) return res.status(404).json({ error: "profile_not_found" });
    res.json({ profile });
  });

  router.get("/profile/search", requireAuth, async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit || 10), 1), 20);
    res.json({ players: await searchProfiles(req.query.q, limit, req.user.id) });
  });

  router.post("/profile", requireAuth, async (req, res) => {
    try {
      const handle = await assertProfileHandleAvailable(req.body.handle || req.user.handle, req.user.id);
      const country = resolveProfileCountry(req, req.body.country, req.body.localeCountry);
      const profile = await upsertProfile({ id: req.user.id, handle, name: req.body.name, country, bio: req.body.bio });
      await syncAccountHandle(req.user.id, profile.handle, profile.name);
      sendAuth(res, profile);
    } catch (error) {
      sendAuthError(res, error);
    }
  });

  router.post("/profile/avatar", requireAuth, async (req, res) => {
    try {
      const profile = await updateProfileAvatar(
        { id: req.user.id, handle: req.user.handle },
        req.body.avatarDataUrl ?? null,
        publicBaseUrl(req)
      );
      res.json({ profile, maxBytes: MAX_AVATAR_BYTES });
    } catch (error) {
      res.status(error.statusCode || 500).json({ error: error.message || "avatar_upload_failed" });
    }
  });

  router.post("/practice/new", requireAuth, (req, res) => {
    const state = createInitialState({
      mode: "practice",
      players: [{ id: "ai", handle: "AI Opponent", ballSkin: "blade" }, { id: req.user.id, handle: req.user.handle, ballSkin: req.body.ballSkin }]
    });
    res.json({ state, legalMoves: legalMoves(state) });
  });

  router.post("/practice/turn", requireAuth, (req, res) => {
    let state = applyAction(req.body.state, req.body.side, req.body.action);
    if (state.status === "active") {
      const ai = chooseAiAction(state, state.turn, req.body.difficulty || "medium");
      state = applyAction(state, state.turn, ai.action);
    }
    res.json({ state, legalMoves: state.status === "active" ? legalMoves(state) : [] });
  });

  return router;
}

function cleanHandle(value) {
  return cleanAuthHandle(value);
}

function publicBaseUrl(req) {
  return process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || `${req.protocol}://${req.get("host")}`;
}

function sendAuth(res, profile) {
  res.json({ token: signAppToken({ id: profile.id, handle: profile.handle, role: "player" }), profile });
}

function sendAuthError(res, error) {
  res.status(error.statusCode || 500).json({ error: error.message || "auth_failed" });
}
