import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { query } from "../db/pool.js";
import { ratingDelta } from "./elo.js";

export const STARTING_TROPHIES = 100;
export const MIN_TROPHIES = 0;
export const MAX_AVATAR_BYTES = 24 * 1024;
export const MAX_BIO_WORDS = 24;
export const MAX_BIO_CHARS = 180;
export const PRESET_AVATARS = new Set(["preset:cyan", "preset:gold", "preset:violet", "preset:emerald"]);

const isTestRun = process.env.NODE_ENV === "test" || process.env.npm_lifecycle_event === "test";
const STORAGE_DIR = process.env.BLOCKSHIFT_STORAGE_DIR || (isTestRun ? path.join(os.tmpdir(), "blockshift-arena-tests", String(process.pid)) : path.join(process.cwd(), "storage"));
const AVATAR_DIR = process.env.AVATAR_DIR || path.join(STORAGE_DIR, "avatars");
const PROFILE_STORE = path.join(STORAGE_DIR, "profiles.json");
const memoryProfiles = new Map();
const memoryMatches = new Map();
const memoryRatedMatches = new Set();
let avatarColumnReady = false;
let memoryProfilesLoaded = false;

export async function upsertProfile(player) {
  const avatarUrl = player.avatarUrl === undefined ? undefined : normalizeAvatarDataUrl(player.avatarUrl);
  const bio = player.bio === undefined ? undefined : normalizeBio(player.bio);
  const name = player.name === undefined ? undefined : normalizeProfileName(player.name);
  if (!process.env.DATABASE_URL) {
    await loadMemoryProfilesOnce();
    if (!memoryProfiles.has(player.id)) {
      memoryProfiles.set(player.id, {
        id: player.id,
        handle: player.handle,
        name: name || player.handle,
        rating: STARTING_TROPHIES,
        wins: 0,
        losses: 0,
        country: player.country || "GLOBAL",
        bio: bio || "",
        avatarUrl: avatarUrl || null,
        createdAt: new Date().toISOString()
      });
    } else {
      const existing = memoryProfiles.get(player.id);
      memoryProfiles.set(player.id, {
        ...existing,
        handle: player.handle || existing.handle,
        name: name === undefined ? existing.name || existing.handle || player.handle : name,
        country: player.country && player.country !== "GLOBAL" ? player.country : existing.country || "GLOBAL",
        bio: bio === undefined ? existing.bio || "" : bio,
        avatarUrl: avatarUrl === undefined ? existing.avatarUrl || null : avatarUrl
      });
    }
    await saveMemoryProfiles();
    return toPublicProfile(memoryProfiles.get(player.id));
  }
  await ensureProfileAvatarColumn();
  const country = player.country || "GLOBAL";
  const dbBio = bio === undefined ? "" : bio;
  const dbName = name === undefined ? null : name;
  const { rows } = await query(
    `insert into players(id, handle, name, country, bio, avatar_url) values($1, $2, $3, $4, $5, $6)
     on conflict(id) do update set handle = excluded.handle, name = coalesce(excluded.name, players.name, excluded.handle), country = coalesce(nullif(excluded.country, 'GLOBAL'), players.country, 'GLOBAL'), bio = coalesce(excluded.bio, players.bio, ''), updated_at = now()
     returning id, handle, name, rating, wins, losses, country, bio, avatar_url, created_at`,
    [player.id, player.handle, dbName, country, dbBio, avatarUrl || null]
  );
  return toPublicProfile(rows[0]);
}

export async function updateProfileAvatar(player, avatarDataUrl, publicBaseUrl = "") {
  const avatarUrl = await avatarValueForStorage(player, avatarDataUrl, publicBaseUrl);
  if (!process.env.DATABASE_URL) {
    await loadMemoryProfilesOnce();
    const existing = memoryProfiles.get(player.id) || {
      id: player.id,
      handle: player.handle || "Neon Pilot",
      name: player.name || player.handle || "Neon Pilot",
      rating: STARTING_TROPHIES,
      wins: 0,
      losses: 0,
      country: player.country || "GLOBAL",
      bio: "",
      createdAt: new Date().toISOString()
    };
    const next = {
      ...existing,
      handle: existing.handle || player.handle || "Neon Pilot",
      name: existing.name || player.name || existing.handle || player.handle || "Neon Pilot",
      country: existing.country || player.country || "GLOBAL",
      bio: existing.bio || "",
      avatarUrl
    };
    memoryProfiles.set(player.id, next);
    await saveMemoryProfiles();
    return toPublicProfile(next);
  }
  await ensureProfileAvatarColumn();
  const { rows } = await query(
    `insert into players(id, handle, name, avatar_url) values($1, $2, $3, $4)
     on conflict(id) do update set avatar_url = excluded.avatar_url, updated_at = now()
     returning id, handle, name, rating, wins, losses, country, bio, avatar_url, created_at`,
    [player.id, player.handle || "Neon Pilot", player.name || player.handle || "Neon Pilot", avatarUrl]
  );
  return toPublicProfile(rows[0]);
}

export function normalizeAvatarDataUrl(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") throw avatarValidationError("invalid_avatar");
  if (PRESET_AVATARS.has(value)) return value;
  if (isTrustedAvatarUrl(value)) return value;
  const bytes = decodeAvatarBytes(value);
  return `data:image/jpeg;base64,${bytes.toString("base64")}`;
}

async function avatarValueForStorage(player, value, publicBaseUrl) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") throw avatarValidationError("invalid_avatar");
  if (PRESET_AVATARS.has(value)) return value;
  if (isTrustedAvatarUrl(value)) return value;
  const bytes = decodeAvatarBytes(value);
  if (usesDatabaseAvatarStorage()) return `data:image/jpeg;base64,${bytes.toString("base64")}`;
  await fs.mkdir(AVATAR_DIR, { recursive: true });
  const filename = `${safeAvatarId(player.id)}.jpg`;
  await fs.writeFile(path.join(AVATAR_DIR, filename), bytes);
  const base = String(publicBaseUrl || process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || "").replace(/\/+$/, "");
  return `${base || ""}/avatars/${filename}?v=${Date.now()}`;
}

function usesDatabaseAvatarStorage() {
  const mode = String(process.env.AVATAR_STORAGE || "").trim().toLowerCase();
  return mode === "database" || mode === "db";
}

function decodeAvatarBytes(value) {
  const match = value.match(/^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/);
  if (!match) throw avatarValidationError("avatar_must_be_jpeg_data_url");
  const bytes = Buffer.from(match[1], "base64");
  if (bytes.length <= 0 || bytes.length > MAX_AVATAR_BYTES) throw avatarValidationError("avatar_too_large");
  return bytes;
}

function isTrustedAvatarUrl(value) {
  return /^https?:\/\/[^ ]+\/avatars\/[A-Za-z0-9_.-]+\.jpg(?:\?v=\d+)?$/.test(value) || /^\/avatars\/[A-Za-z0-9_.-]+\.jpg(?:\?v=\d+)?$/.test(value);
}

export function normalizeBio(value) {
  const normalized = stripEmoji(String(value || "")).replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  return normalized.split(" ").slice(0, MAX_BIO_WORDS).join(" ").slice(0, MAX_BIO_CHARS).trim();
}

function safeAvatarId(id) {
  return String(id || "player").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80) || "player";
}

export async function persistMatch(state) {
  if (!process.env.DATABASE_URL) {
    await loadMemoryProfilesOnce();
    let persistedState = state;
    if (state.status === "finished" && state.ranked && !state.trophyDelta && !memoryRatedMatches.has(state.id)) {
      persistedState = applyMemoryRankedResult(state);
      memoryRatedMatches.add(state.id);
      await saveMemoryProfiles();
    }
    memoryMatches.set(persistedState.id, persistedState);
    return persistedState;
  }
  let persistedState = state;
  if (state.status === "finished" && state.ranked && !state.trophyDelta) persistedState = await applyRankedResult(state);
  await query(
    `insert into matches(id, mode, ranked, winner_id, state, replay)
     values($1, $2, $3, $4, $5, $6)
     on conflict(id) do update set winner_id = excluded.winner_id, state = excluded.state, replay = excluded.replay, updated_at = now()`,
    [persistedState.id, persistedState.mode, persistedState.ranked, persistedState.winner ? persistedState.players[persistedState.winner].id : null, persistedState, persistedState.replay]
  );
  return persistedState;
}

function applyMemoryRankedResult(state) {
  const next = structuredClone(state);
  const winner = state.players[state.winner];
  const loser = state.players[state.winner === "south" ? "north" : "south"];
  const winnerProfile = memoryProfiles.get(winner.id) || { id: winner.id, handle: winner.handle, rating: STARTING_TROPHIES, wins: 0, losses: 0, country: "GLOBAL", bio: "", avatarUrl: null };
  const loserProfile = memoryProfiles.get(loser.id) || { id: loser.id, handle: loser.handle, rating: STARTING_TROPHIES, wins: 0, losses: 0, country: "GLOBAL", bio: "", avatarUrl: null };
  const delta = ratingDelta(winnerProfile.rating, loserProfile.rating);
  const loserNextRating = Math.max(MIN_TROPHIES, loserProfile.rating + delta.loserDelta);
  const winnerDelta = delta.winnerDelta;
  const loserDelta = loserNextRating - loserProfile.rating;
  memoryProfiles.set(winner.id, { ...winnerProfile, handle: winner.handle, rating: winnerProfile.rating + delta.winnerDelta, wins: winnerProfile.wins + 1 });
  memoryProfiles.set(loser.id, { ...loserProfile, handle: loser.handle, rating: loserNextRating, losses: loserProfile.losses + 1 });
  next.trophyDelta = {
    south: state.winner === "south" ? winnerDelta : loserDelta,
    north: state.winner === "north" ? winnerDelta : loserDelta
  };
  return next;
}

async function applyRankedResult(state) {
  const next = structuredClone(state);
  const winner = state.players[state.winner];
  const loser = state.players[state.winner === "south" ? "north" : "south"];
  const profiles = await Promise.all([upsertProfile(winner), upsertProfile(loser)]);
  const delta = ratingDelta(profiles[0].rating, profiles[1].rating);
  const loserNextRating = Math.max(MIN_TROPHIES, profiles[1].rating + delta.loserDelta);
  const winnerDelta = delta.winnerDelta;
  const loserDelta = loserNextRating - profiles[1].rating;
  await query("update players set rating = rating + $1, wins = wins + 1 where id = $2", [delta.winnerDelta, winner.id]);
  await query("update players set rating = greatest(0, rating + $1), losses = losses + 1 where id = $2", [delta.loserDelta, loser.id]);
  next.trophyDelta = {
    south: state.winner === "south" ? winnerDelta : loserDelta,
    north: state.winner === "north" ? winnerDelta : loserDelta
  };
  return next;
}

export async function leaderboard(limit = 100) {
  if (!process.env.DATABASE_URL) {
    await loadMemoryProfilesOnce();
    return [...memoryProfiles.values()].filter(includePublicProfile).sort((a, b) => b.rating - a.rating).slice(0, limit).map(toPublicProfile);
  }
  await ensureProfileAvatarColumn();
  const { rows } = await query("select id, handle, name, rating, wins, losses, country, bio, avatar_url, created_at from players order by rating desc limit $1", [limit]);
  return rows.filter(includePublicProfile).map(toPublicProfile);
}

export async function searchProfiles(searchText, limit = 10, excludeId = "") {
  const cleanSearch = normalizeSearchTerm(searchText);
  if (!cleanSearch) return [];
  const cappedLimit = Math.min(Math.max(Number(limit || 10), 1), 20);
  const cleanExcludeId = String(excludeId || "").trim();
  if (!process.env.DATABASE_URL) {
    await loadMemoryProfilesOnce();
    return [...memoryProfiles.values()]
      .filter((profile) => includePublicProfile(profile) && profile.id !== cleanExcludeId)
      .map((profile) => ({ profile, rank: searchRank(profile, cleanSearch) }))
      .filter((row) => row.rank < 100)
      .sort((a, b) => a.rank - b.rank || (b.profile.rating || 0) - (a.profile.rating || 0) || String(a.profile.handle || "").localeCompare(String(b.profile.handle || "")))
      .slice(0, cappedLimit)
      .map((row) => toPublicProfile(row.profile));
  }
  await ensureProfileAvatarColumn();
  const prefix = `${cleanSearch}%`;
  const contains = `%${cleanSearch}%`;
  const { rows } = await query(
    `select id, handle, name, rating, wins, losses, country, bio, avatar_url, created_at
     from players
     where ($4 = '' or id <> $4)
       and (
         lower(handle) like $2
         or lower(coalesce(name, handle)) like $2
         or lower(handle) like $3
         or lower(coalesce(name, handle)) like $3
       )
     order by
       case
         when lower(handle) = $1 then 0
         when lower(handle) like $2 then 1
         when lower(coalesce(name, handle)) like $2 then 2
         when lower(handle) like $3 then 3
         else 4
       end,
       rating desc,
       lower(handle)
     limit $5`,
    [cleanSearch, prefix, contains, cleanExcludeId, cappedLimit]
  );
  return rows.filter(includePublicProfile).map(toPublicProfile);
}

export async function findProfile(lookup) {
  const cleanLookup = String(lookup || "").trim();
  if (!cleanLookup) return null;
  if (!process.env.DATABASE_URL) {
    await loadMemoryProfilesOnce();
    const exact = memoryProfiles.get(cleanLookup);
    if (exact) return toPublicProfile(exact);
    const normalized = cleanLookup.toLowerCase();
    const byHandle = [...memoryProfiles.values()].find((profile) => String(profile.handle || "").toLowerCase() === normalized);
    return byHandle ? toPublicProfile(byHandle) : null;
  }
  await ensureProfileAvatarColumn();
  const { rows } = await query(
    `select id, handle, name, rating, wins, losses, country, bio, avatar_url, created_at
     from players
     where id = $1 or lower(handle) = lower($1)
     order by case when id = $1 then 0 else 1 end
     limit 1`,
    [cleanLookup]
  );
  return rows[0] ? toPublicProfile(rows[0]) : null;
}

export async function deletePlayerData(playerId) {
  const cleanId = String(playerId || "").trim();
  if (!cleanId) return false;
  if (!process.env.DATABASE_URL) {
    await loadMemoryProfilesOnce();
    const existing = memoryProfiles.get(cleanId);
    memoryProfiles.delete(cleanId);
    for (const [matchId, match] of memoryMatches) {
      if (matchIncludesPlayer(match, cleanId)) memoryMatches.delete(matchId);
    }
    memoryRatedMatches.delete(cleanId);
    await deleteAvatarFile(existing?.avatarUrl);
    await saveMemoryProfiles();
    return true;
  }
  await ensureProfileAvatarColumn();
  const existing = await findProfile(cleanId);
  await query(
    `delete from matches
     where winner_id = $1
        or state -> 'players' -> 'south' ->> 'id' = $1
        or state -> 'players' -> 'north' ->> 'id' = $1`,
    [cleanId]
  );
  await query("delete from players where id = $1", [cleanId]);
  await deleteAvatarFile(existing?.avatarUrl);
  return true;
}

async function ensureProfileAvatarColumn() {
  if (avatarColumnReady || !process.env.DATABASE_URL) return;
  await query("alter table players add column if not exists country text default 'GLOBAL'");
  await query("alter table players add column if not exists bio text default ''");
  await query("alter table players add column if not exists name text");
  await query("alter table players add column if not exists avatar_url text");
  await query("alter table players add column if not exists created_at timestamptz default now()");
  await query("alter table players add column if not exists updated_at timestamptz default now()");
  await query("create index if not exists players_handle_lower_idx on players (lower(handle))");
  await query("create index if not exists players_name_lower_idx on players (lower(coalesce(name, handle)))");
  avatarColumnReady = true;
}

function toPublicProfile(row) {
  const joinedAt = normalizeTimestamp(row.joinedAt ?? row.joined_at ?? row.createdAt ?? row.created_at);
  return {
    id: row.id,
    handle: row.handle,
    name: normalizeProfileName(row.name || row.handle),
    rating: row.rating ?? STARTING_TROPHIES,
    wins: row.wins ?? 0,
    losses: row.losses ?? 0,
    country: row.country || "GLOBAL",
    bio: normalizeBio(row.bio || ""),
    avatarUrl: row.avatarUrl ?? row.avatar_url ?? null,
    joinedAt
  };
}

function normalizeProfileName(value) {
  return stripEmoji(String(value || "Neon Pilot")).replace(/\s+/g, " ").trim().slice(0, 28) || "Neon Pilot";
}

function normalizeSearchTerm(value) {
  return stripEmoji(String(value || "")).replace(/^@+/, "").replace(/\s+/g, " ").trim().toLowerCase().slice(0, 32);
}

function stripEmoji(value) {
  return String(value || "").replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}\u{E0020}-\u{E007F}]/gu, "");
}

function searchRank(profile, cleanSearch) {
  const handle = normalizeSearchTerm(profile.handle);
  const name = normalizeSearchTerm(profile.name || profile.handle);
  if (handle === cleanSearch) return 0;
  if (handle.startsWith(cleanSearch)) return 1;
  if (name.startsWith(cleanSearch)) return 2;
  if (handle.includes(cleanSearch)) return 3;
  if (name.includes(cleanSearch)) return 4;
  return 100;
}

function normalizeTimestamp(value) {
  if (!value) return new Date().toISOString();
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function matchIncludesPlayer(match, playerId) {
  return match?.players?.south?.id === playerId ||
    match?.players?.north?.id === playerId ||
    match?.south?.id === playerId ||
    match?.north?.id === playerId ||
    match?.winnerId === playerId;
}

async function deleteAvatarFile(avatarUrl) {
  const match = String(avatarUrl || "").match(/\/avatars\/([A-Za-z0-9_.-]+\.jpg)(?:\?v=\d+)?$/);
  if (!match) return;
  const root = path.resolve(AVATAR_DIR);
  const target = path.resolve(root, match[1]);
  if (target === root || !target.startsWith(`${root}${path.sep}`)) return;
  await fs.rm(target, { force: true }).catch(() => {});
}

async function loadMemoryProfilesOnce() {
  if (memoryProfilesLoaded || process.env.DATABASE_URL) return;
  memoryProfilesLoaded = true;
  const raw = await fs.readFile(PROFILE_STORE, "utf8").catch(() => "");
  if (!raw) return;
  let profiles = [];
  try {
    profiles = JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch {
    profiles = [];
  }
  if (!Array.isArray(profiles)) return;
  profiles.forEach((profile) => {
    if (profile?.id && includePublicProfile(profile)) memoryProfiles.set(profile.id, profile);
  });
}

async function saveMemoryProfiles() {
  if (process.env.DATABASE_URL) return;
  await fs.mkdir(STORAGE_DIR, { recursive: true });
  await fs.writeFile(PROFILE_STORE, JSON.stringify([...memoryProfiles.values()].filter(includePublicProfile), null, 2));
}

function avatarValidationError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function includePublicProfile(profile) {
  if (isTestRun) return true;
  const id = String(profile?.id || "").toLowerCase();
  const handle = String(profile?.handle || "").trim().toLowerCase();
  return ![
      "ai_",
      "bot_",
      "challenge_",
      "fresh_",
      "friend_",
      "winner_",
      "loser_",
      "delta_",
      "avatar_",
      "avatar_preset_",
      "profile_",
      "ranked_",
      "rematch_",
      "spectator_",
      "test_",
      "verify_",
      "host_",
      "guest_",
      "upload_route_check"
    ].some((prefix) => id.startsWith(prefix)) &&
    !["ai", "bot", "local", "local-north", "local-south", "local-ai"].includes(id) &&
    ![
      "ai opponent",
      "arena bot",
      "shift-ai",
      "freshpilot",
      "winnerpilot",
      "loserpilot",
      "deltawinner",
      "deltaloser",
      "avatarpilot",
      "presetpilot",
      "rankedpilot",
      "rankedrival",
      "hostplayer",
      "guestplayer",
      "uploadcheck"
    ].includes(handle);
}
