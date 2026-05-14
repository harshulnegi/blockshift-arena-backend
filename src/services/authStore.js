import bcrypt from "bcryptjs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomInt, randomUUID } from "node:crypto";
import { getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { OAuth2Client } from "google-auth-library";
import { query } from "../db/pool.js";
import { deletePlayerData, findProfile, upsertProfile } from "./matchStore.js";

const isTestRun = process.env.NODE_ENV === "test" || process.env.npm_lifecycle_event === "test";
const STORAGE_DIR = process.env.BLOCKSHIFT_STORAGE_DIR || (isTestRun ? path.join(os.tmpdir(), "blockshift-arena-tests", String(process.pid)) : path.join(process.cwd(), "storage"));
const ACCOUNT_STORE = path.join(STORAGE_DIR, "accounts.json");
const OTP_TTL_MS = 5 * 60 * 1000;
const HANDLE_MAX = 18;
const BIO_MAX_WORDS = 24;
const memoryAccounts = new Map();
const memoryOtps = new Map();
const googleOAuthClient = new OAuth2Client(process.env.GOOGLE_WEB_CLIENT_ID || undefined);
let memoryAccountsLoaded = false;
let authTablesReady = false;

export function cleanAuthHandle(value) {
  const cleaned = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9_.]/g, "")
    .trim()
    .slice(0, HANDLE_MAX);
  return cleaned || "neonpilot";
}

export function cleanEmail(value) {
  return stripEmoji(String(value || "")).trim().toLowerCase();
}

export function cleanDisplayName(value) {
  return stripEmoji(String(value || ""))
    .replace(/[^\p{L}\p{N}_ .'-]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 28) || "Neon Pilot";
}

export async function registerPasswordAccount({ name, username, handle, email, password, country = "GLOBAL" }) {
  const normalizedEmail = assertEmail(email);
  const cleanHandle = assertHandle(username || handle);
  const cleanName = cleanDisplayName(name || cleanHandle);
  assertPassword(password);
  await assertUniqueEmail(normalizedEmail);
  await assertUniqueHandle(cleanHandle);
  const passwordHash = await bcrypt.hash(password, 12);
  const account = await createAccount({
    id: newPlayerId(),
    email: normalizedEmail,
    handle: cleanHandle,
    name: cleanName,
    passwordHash,
    providers: ["password"]
  });
  const profile = await upsertProfile({ id: account.id, handle: account.handle, name: account.name, country });
  return { account, profile };
}

export async function loginPasswordAccount({ email, username, handle, password }) {
  const identifier = stripEmoji(String(email || username || handle || "")).trim();
  const account = identifier.includes("@")
    ? await findAccountByEmail(assertEmail(identifier))
    : await findAccountByHandle(assertHandle(identifier));
  if (!account?.passwordHash || !(await bcrypt.compare(String(password || ""), account.passwordHash))) {
    throw authError(401, "invalid_credentials");
  }
  const profile = (await findProfile(account.id)) || (await upsertProfile({ id: account.id, handle: account.handle, name: account.name }));
  return { account, profile };
}

export async function loginGoogleAccount({ idToken, name, username, handle, country = "GLOBAL" }) {
  const google = await verifyGoogleToken(idToken);
  const email = assertEmail(google.email);
  const existingByGoogle = google.subject ? await findAccountByGoogleSubject(google.subject) : null;
  const existing = existingByGoogle || (await findAccountByEmail(email));
  if (existing) {
    const updated = existing.googleSubject === google.subject && existing.providers.includes("google")
      ? existing
      : await updateAccount(existing.id, {
          googleSubject: google.subject || existing.googleSubject,
          providers: uniqueProviders([...existing.providers, "google"])
        });
    const profile = (await findProfile(updated.id)) || (await upsertProfile({ id: updated.id, handle: updated.handle, name: updated.name, country }));
    return { account: updated, profile };
  }

  const preferredHandle = username?.trim() || handle?.trim() || email.split("@")[0] || "Neon Pilot";
  const accountHandle = await uniqueHandle(cleanAuthHandle(preferredHandle));
  const accountName = cleanDisplayName(name || google.name || accountHandle);
  const account = await createAccount({
    id: newPlayerId(),
    email,
    handle: accountHandle,
    name: accountName,
    googleSubject: google.subject,
    providers: ["google"]
  });
  const profile = await upsertProfile({ id: account.id, handle: account.handle, name: account.name, country });
  return { account, profile };
}

export async function loginGuestAccount({ deviceId, country = "GLOBAL" }) {
  const guestDeviceId = cleanGuestDeviceId(deviceId);
  const guestSubject = `guest:${guestDeviceId}`;
  const existing = await findAccountByGuestSubject(guestSubject);
  if (existing) {
    const profile = (await findProfile(existing.id)) || (await upsertProfile({ id: existing.id, handle: existing.handle, name: existing.name, country }));
    return { account: existing, profile };
  }

  const accountHandle = await uniqueHandle(`guest${randomInt(1000, 9999)}`);
  const accountName = cleanDisplayName(`Guest ${accountHandle.replace(/^guest/i, "") || "Player"}`);
  const account = await createAccount({
    id: newPlayerId(),
    email: guestEmailForDeviceId(guestDeviceId),
    handle: accountHandle,
    name: accountName,
    guestSubject,
    providers: ["guest"]
  });
  const profile = await upsertProfile({ id: account.id, handle: account.handle, name: account.name, country });
  return { account, profile };
}

export async function requestEmailOtp({ email }) {
  const normalizedEmail = assertEmail(email);
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const otpHash = await bcrypt.hash(code, 10);
  const expiresAt = new Date(Date.now() + OTP_TTL_MS).toISOString();
  await saveOtp(normalizedEmail, otpHash, expiresAt);
  return {
    sent: true,
    expiresInSeconds: Math.floor(OTP_TTL_MS / 1000),
    devOtp: shouldExposeDevOtp() ? code : undefined
  };
}

export async function verifyEmailOtp({ email, code, handle, country = "GLOBAL" }) {
  const normalizedEmail = assertEmail(email);
  const record = await findOtp(normalizedEmail);
  if (!record || Date.parse(record.expiresAt) < Date.now()) throw authError(401, "otp_expired");
  if (!(await bcrypt.compare(String(code || "").trim(), record.otpHash))) throw authError(401, "otp_invalid");
  await clearOtp(normalizedEmail);

  const existing = await findAccountByEmail(normalizedEmail);
  if (existing) {
    const updated = existing.providers.includes("otp")
      ? existing
      : await updateAccount(existing.id, { providers: uniqueProviders([...existing.providers, "otp"]) });
    const profile = (await findProfile(updated.id)) || (await upsertProfile({ id: updated.id, handle: updated.handle, name: updated.name, country }));
    return { account: updated, profile };
  }

  const preferredHandle = handle?.trim() || normalizedEmail.split("@")[0] || "Neon Pilot";
  const accountHandle = await uniqueHandle(cleanAuthHandle(preferredHandle));
  const account = await createAccount({
    id: newPlayerId(),
    email: normalizedEmail,
    handle: accountHandle,
    name: accountHandle,
    providers: ["otp"]
  });
  const profile = await upsertProfile({ id: account.id, handle: account.handle, name: account.name, country });
  return { account, profile };
}

export async function sessionProfile(user) {
  if (!user?.id) throw authError(401, "unauthorized");
  const account = await findAccountById(user.id);
  const profile = await findProfile(user.id);
  if (!account || !profile) throw authError(401, "session_expired");
  return { account, profile };
}

export async function deleteAccount({ user, confirmation }) {
  if (String(confirmation || "").trim() !== "CONFIRM") throw authError(400, "confirmation_required");
  if (!user?.id) throw authError(401, "unauthorized");
  const account = await findAccountById(user.id);
  if (!account) throw authError(401, "account_not_found");
  await deletePlayerData(user.id);
  if (!process.env.DATABASE_URL) {
    await loadMemoryAccountsOnce();
    memoryAccounts.delete(user.id);
    memoryOtps.delete(account.email);
    await saveMemoryAccounts();
    return { ok: true };
  }
  await ensureAuthTables();
  await query("delete from auth_otps where email = $1", [account.email]);
  await query("delete from auth_accounts where id = $1", [user.id]);
  return { ok: true };
}

export async function assertProfileHandleAvailable(handle, ownerId) {
  const cleanHandle = assertHandle(handle);
  await assertUniqueHandle(cleanHandle, ownerId);
  return cleanHandle;
}

export async function syncAccountHandle(ownerId, handle, name) {
  const account = await findAccountById(ownerId);
  if (!account) return null;
  return updateAccount(ownerId, { handle: cleanAuthHandle(handle), name: cleanDisplayName(name || account.name || handle) });
}

function assertEmail(email) {
  const normalized = cleanEmail(email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) || normalized.length > 254) {
    throw authError(400, "invalid_email");
  }
  return normalized;
}

function assertHandle(handle) {
  const cleanHandle = cleanAuthHandle(handle);
  if (cleanHandle.length < 3) throw authError(400, "handle_too_short");
  return cleanHandle;
}

function assertPassword(password) {
  const raw = String(password || "");
  if (raw !== stripEmoji(raw)) throw authError(400, "emoji_not_allowed");
  if (raw.length < 8) throw authError(400, "password_too_short");
  if (raw.length > 128) throw authError(400, "password_too_long");
}

async function assertUniqueEmail(email, ownerId = "") {
  const existing = await findAccountByEmail(email);
  if (existing && existing.id !== ownerId) throw authError(409, "email_in_use");
}

async function assertUniqueHandle(handle, ownerId = "") {
  const existingAccount = await findAccountByHandle(handle);
  if (existingAccount && existingAccount.id !== ownerId) throw authError(409, "handle_in_use");
  const existingProfile = await findProfile(handle);
  if (existingProfile && existingProfile.id !== ownerId) throw authError(409, "handle_in_use");
}

async function uniqueHandle(preferred) {
  const base = cleanAuthHandle(preferred).slice(0, HANDLE_MAX - 4).trim() || "Neon Pilot";
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const suffix = attempt === 0 ? "" : String(100 + attempt);
    const candidate = cleanAuthHandle(`${base}${suffix ? ` ${suffix}` : ""}`);
    const existing = await findAccountByHandle(candidate);
    const existingProfile = await findProfile(candidate);
    if (!existing && !existingProfile) return candidate;
  }
  return `Pilot ${randomInt(1000, 9999)}`;
}

async function verifyGoogleToken(idToken) {
  const token = String(idToken || "").trim();
  if (!token) throw authError(400, "google_token_required");
  if (token.startsWith("dev-google:") && process.env.NODE_ENV !== "production" && process.env.ALLOW_DEV_GOOGLE_AUTH !== "false") {
    const email = assertEmail(token.slice("dev-google:".length));
    return { email, subject: `dev-google:${email}`, name: email.split("@")[0] };
  }
  const googleProfile = await verifyGoogleSignInToken(token);
  if (googleProfile) return googleProfile;
  try {
    if (!getApps().length) initializeApp();
    const decoded = await getAuth().verifyIdToken(token);
    return {
      email: decoded.email,
      subject: decoded.uid || decoded.sub,
      name: decoded.name || decoded.email?.split("@")[0]
    };
  } catch {
    throw authError(401, "google_token_invalid");
  }
}

async function verifyGoogleSignInToken(token) {
  try {
    const ticket = await googleOAuthClient.verifyIdToken({
      idToken: token,
      audience: process.env.GOOGLE_WEB_CLIENT_ID || undefined
    });
    const payload = ticket.getPayload();
    const email = assertEmail(payload?.email);
    if (payload?.email_verified === false) throw new Error("email_not_verified");
    return {
      email,
      subject: payload?.sub,
      name: payload?.name || email.split("@")[0]
    };
  } catch {
    return null;
  }
}

async function findAccountById(id) {
  if (!process.env.DATABASE_URL) {
    await loadMemoryAccountsOnce();
    return memoryAccounts.get(String(id || "")) || null;
  }
  await ensureAuthTables();
  const { rows } = await query("select * from auth_accounts where id = $1 limit 1", [id]);
  return rows[0] ? toAccount(rows[0]) : null;
}

async function findAccountByEmail(email) {
  if (!process.env.DATABASE_URL) {
    await loadMemoryAccountsOnce();
    return [...memoryAccounts.values()].find((account) => account.email === email) || null;
  }
  await ensureAuthTables();
  const { rows } = await query("select * from auth_accounts where email = $1 limit 1", [email]);
  return rows[0] ? toAccount(rows[0]) : null;
}

async function findAccountByHandle(handle) {
  const handleLower = cleanAuthHandle(handle).toLowerCase();
  if (!process.env.DATABASE_URL) {
    await loadMemoryAccountsOnce();
    return [...memoryAccounts.values()].find((account) => account.handle.toLowerCase() === handleLower) || null;
  }
  await ensureAuthTables();
  const { rows } = await query("select * from auth_accounts where handle_lower = $1 limit 1", [handleLower]);
  return rows[0] ? toAccount(rows[0]) : null;
}

async function findAccountByGoogleSubject(subject) {
  if (!subject) return null;
  if (!process.env.DATABASE_URL) {
    await loadMemoryAccountsOnce();
    return [...memoryAccounts.values()].find((account) => account.googleSubject === subject) || null;
  }
  await ensureAuthTables();
  const { rows } = await query("select * from auth_accounts where google_subject = $1 limit 1", [subject]);
  return rows[0] ? toAccount(rows[0]) : null;
}

async function findAccountByGuestSubject(subject) {
  if (!subject) return null;
  if (!process.env.DATABASE_URL) {
    await loadMemoryAccountsOnce();
    return [...memoryAccounts.values()].find((account) => account.guestSubject === subject) || null;
  }
  await ensureAuthTables();
  const { rows } = await query("select * from auth_accounts where guest_subject = $1 limit 1", [subject]);
  return rows[0] ? toAccount(rows[0]) : null;
}

async function createAccount(account) {
  const next = normalizeAccount(account);
  if (!process.env.DATABASE_URL) {
    await loadMemoryAccountsOnce();
    if ([...memoryAccounts.values()].some((existing) => existing.email === next.email && existing.id !== next.id)) {
      throw authError(409, "email_in_use");
    }
    if ([...memoryAccounts.values()].some((existing) => existing.handle.toLowerCase() === next.handle.toLowerCase() && existing.id !== next.id)) {
      throw authError(409, "handle_in_use");
    }
    memoryAccounts.set(next.id, next);
    await saveMemoryAccounts();
    return next;
  }
  await ensureAuthTables();
  const { rows } = await query(
    `insert into auth_accounts(id, email, handle, handle_lower, name, password_hash, google_subject, guest_subject, providers)
     values($1, $2, $3, $4, $5, $6, $7, $8, $9)
     returning *`,
    [next.id, next.email, next.handle, next.handle.toLowerCase(), next.name, next.passwordHash || null, next.googleSubject || null, next.guestSubject || null, JSON.stringify(next.providers)]
  );
  return toAccount(rows[0]);
}

async function updateAccount(id, patch) {
  const current = await findAccountById(id);
  if (!current) throw authError(401, "account_not_found");
  const next = normalizeAccount({ ...current, ...patch, updatedAt: new Date().toISOString() });
  if (!process.env.DATABASE_URL) {
    memoryAccounts.set(next.id, next);
    await saveMemoryAccounts();
    return next;
  }
  await ensureAuthTables();
  const { rows } = await query(
    `update auth_accounts
     set handle = $2, handle_lower = $3, name = $4, password_hash = $5, google_subject = $6, guest_subject = $7, providers = $8, updated_at = now()
     where id = $1
     returning *`,
    [next.id, next.handle, next.handle.toLowerCase(), next.name, next.passwordHash || null, next.googleSubject || null, next.guestSubject || null, JSON.stringify(next.providers)]
  );
  return toAccount(rows[0]);
}

async function saveOtp(email, otpHash, expiresAt) {
  if (!process.env.DATABASE_URL) {
    memoryOtps.set(email, { otpHash, expiresAt });
    return;
  }
  await ensureAuthTables();
  await query(
    `insert into auth_otps(email, otp_hash, expires_at) values($1, $2, $3)
     on conflict(email) do update set otp_hash = excluded.otp_hash, expires_at = excluded.expires_at, updated_at = now()`,
    [email, otpHash, expiresAt]
  );
}

async function findOtp(email) {
  if (!process.env.DATABASE_URL) return memoryOtps.get(email) || null;
  await ensureAuthTables();
  const { rows } = await query("select otp_hash, expires_at from auth_otps where email = $1 limit 1", [email]);
  return rows[0] ? { otpHash: rows[0].otp_hash, expiresAt: rows[0].expires_at instanceof Date ? rows[0].expires_at.toISOString() : rows[0].expires_at } : null;
}

async function clearOtp(email) {
  if (!process.env.DATABASE_URL) {
    memoryOtps.delete(email);
    return;
  }
  await ensureAuthTables();
  await query("delete from auth_otps where email = $1", [email]);
}

async function ensureAuthTables() {
  if (authTablesReady || !process.env.DATABASE_URL) return;
  await query(
    `create table if not exists auth_accounts(
      id text primary key,
      email text not null unique,
      handle text not null,
      handle_lower text not null unique,
      name text not null default 'Neon Pilot',
      password_hash text,
      google_subject text unique,
      guest_subject text unique,
      providers jsonb not null default '[]'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )`
  );
  await query("alter table auth_accounts add column if not exists name text not null default 'Neon Pilot'");
  await query("alter table auth_accounts add column if not exists guest_subject text");
  await query("create unique index if not exists auth_accounts_guest_subject_idx on auth_accounts(guest_subject) where guest_subject is not null");
  await query(
    `create table if not exists auth_otps(
      email text primary key,
      otp_hash text not null,
      expires_at timestamptz not null,
      updated_at timestamptz not null default now()
    )`
  );
  authTablesReady = true;
}

async function loadMemoryAccountsOnce() {
  if (memoryAccountsLoaded || process.env.DATABASE_URL) return;
  memoryAccountsLoaded = true;
  const raw = await fs.readFile(ACCOUNT_STORE, "utf8").catch(() => "");
  if (!raw) return;
  let accounts = [];
  try {
    accounts = JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch {
    accounts = [];
  }
  if (!Array.isArray(accounts)) return;
  accounts.forEach((account) => {
    if (account?.id && account?.email) memoryAccounts.set(account.id, normalizeAccount(account));
  });
}

async function saveMemoryAccounts() {
  if (process.env.DATABASE_URL) return;
  await fs.mkdir(STORAGE_DIR, { recursive: true });
  await fs.writeFile(ACCOUNT_STORE, JSON.stringify([...memoryAccounts.values()], null, 2));
}

function normalizeAccount(account) {
  return {
    id: String(account.id),
    email: cleanEmail(account.email),
    handle: cleanAuthHandle(account.handle),
    name: cleanDisplayName(account.name || account.displayName || account.handle),
    passwordHash: account.passwordHash || account.password_hash || null,
    googleSubject: account.googleSubject || account.google_subject || null,
    guestSubject: account.guestSubject || account.guest_subject || null,
    providers: uniqueProviders(account.providers || []),
    createdAt: account.createdAt || account.created_at || new Date().toISOString(),
    updatedAt: account.updatedAt || account.updated_at || new Date().toISOString()
  };
}

function toAccount(row) {
  return normalizeAccount({
    id: row.id,
    email: row.email,
    handle: row.handle,
    name: row.name,
    passwordHash: row.password_hash,
    googleSubject: row.google_subject,
    guestSubject: row.guest_subject,
    providers: row.providers,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });
}

function uniqueProviders(providers) {
  const list = Array.isArray(providers) ? providers : [];
  return [...new Set(list.map((provider) => String(provider || "").trim()).filter(Boolean))];
}

function newPlayerId() {
  return `usr_${randomUUID().replace(/-/g, "").slice(0, 14)}`;
}

function cleanGuestDeviceId(value) {
  const cleaned = stripEmoji(String(value || ""))
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(0, 64);
  return cleaned || randomUUID().replace(/-/g, "");
}

function guestEmailForDeviceId(deviceId) {
  const mailbox = cleanGuestDeviceId(deviceId).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 64);
  return `guest+${mailbox}@guest.blockshift.local`;
}

function shouldExposeDevOtp() {
  return process.env.NODE_ENV !== "production" && process.env.EXPOSE_DEV_OTP !== "false";
}

function authError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function stripEmoji(value) {
  return String(value || "").replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}\u{E0020}-\u{E007F}]/gu, "");
}
