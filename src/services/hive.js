const HIVE_PHASE = 7;
const NODE_TTL_MS = 90 * 1000;
const SNAPSHOT_TTL_MS = 15 * 1000;
const RECEIPT_GOSSIP_LIMIT = 600;

const nodesBySocket = new Map();
const snapshots = new Map();
const receiptGossipByMatch = new Map();

export function hiveCapabilities() {
  return {
    phase: HIVE_PHASE,
    protocol: "ArenaHiveQuickGame/7",
    edgeRegion: process.env.HIVE_REGION || process.env.RENDER_REGION || "global-free",
    cacheSnapshots: true,
    receiptGossip: true,
    regionalSignaling: true,
    serverFallback: true,
    directP2P: true,
    quickGameBlueprint: true,
    transportLadder: ["webrtc-datachannel", "phone-relay", "turn-relay", "edge-websocket", "authoritative-fallback"],
    roles: ["player", "cache", "relay", "validator", "witness"]
  };
}

export function registerHiveNode({ socketId, playerId, handle, payload = {} }) {
  const now = Date.now();
  const nodeId = cleanId(payload.nodeId) || `hive:${playerId}`;
  const roles = cleanRoles(payload.roles || payload.capabilities?.roles);
  const region = cleanRegion(payload.region || payload.capabilities?.region);
  const node = {
    socketId,
    nodeId,
    playerId: cleanId(playerId, 128),
    handle: String(handle || "Player").slice(0, 40),
    roles,
    region,
    quality: cleanQuality(payload.quality || payload.capabilities?.quality),
    capabilities: safeObject(payload.capabilities),
    updatedAt: now,
    expiresAt: now + NODE_TTL_MS
  };
  nodesBySocket.set(socketId, node);
  return publicNode(node);
}

export function unregisterHiveSocket(socketId) {
  nodesBySocket.delete(socketId);
}

export function pruneHiveNodes(now = Date.now()) {
  for (const [socketId, node] of nodesBySocket) {
    if (node.expiresAt <= now) nodesBySocket.delete(socketId);
  }
}

export function hiveStats() {
  pruneHiveNodes();
  const nodes = [...nodesBySocket.values()];
  const byRole = {};
  const byRegion = {};
  for (const node of nodes) {
    byRegion[node.region] = (byRegion[node.region] || 0) + 1;
    for (const role of node.roles) byRole[role] = (byRole[role] || 0) + 1;
  }
  return {
    ...hiveCapabilities(),
    activeNodes: nodes.length,
    byRole,
    byRegion,
    snapshotKeys: snapshots.size,
    gossipMatches: receiptGossipByMatch.size,
    serverTime: Date.now()
  };
}

export async function cachedHiveSnapshot(key, producer, ttlMs = SNAPSHOT_TTL_MS) {
  const cleanKey = cleanId(key, 80) || "default";
  const now = Date.now();
  const existing = snapshots.get(cleanKey);
  if (existing && existing.expiresAt > now) {
    return { ...existing.payload, cached: true, expiresAt: existing.expiresAt };
  }
  const payload = {
    key: cleanKey,
    phase: HIVE_PHASE,
    generatedAt: now,
    ...(await producer())
  };
  snapshots.set(cleanKey, { payload, expiresAt: now + ttlMs });
  return { ...payload, cached: false, expiresAt: now + ttlMs };
}

export function rememberHiveReceipts({ matchId, fromPlayerId, receipts = [] }) {
  const cleanMatchId = cleanId(matchId, 128);
  if (!cleanMatchId) return { accepted: 0, receipts: [] };
  if (!receiptGossipByMatch.has(cleanMatchId)) receiptGossipByMatch.set(cleanMatchId, []);
  const bucket = receiptGossipByMatch.get(cleanMatchId);
  const accepted = [];
  for (const receipt of receipts.slice(0, 32)) {
    const clean = cleanReceipt(receipt, fromPlayerId);
    if (!clean.chainHash && !clean.actionHash) continue;
    const duplicate = bucket.some((item) =>
      item.chainHash === clean.chainHash &&
      item.serverSeq === clean.serverSeq &&
      item.side === clean.side
    );
    if (duplicate) continue;
    bucket.push(clean);
    accepted.push(clean);
  }
  if (bucket.length > RECEIPT_GOSSIP_LIMIT) bucket.splice(0, bucket.length - RECEIPT_GOSSIP_LIMIT);
  return { accepted: accepted.length, receipts: accepted };
}

export function hiveReceiptsForMatch(matchId, limit = 80) {
  const cleanMatchId = cleanId(matchId, 128);
  const capped = Math.min(Math.max(Number(limit || 80), 1), 200);
  return (receiptGossipByMatch.get(cleanMatchId) || []).slice(-capped);
}

export function publicHiveEdge(region = "global") {
  return {
    ...hiveCapabilities(),
    region: cleanRegion(region),
    nodeTtlMs: NODE_TTL_MS,
    snapshotTtlMs: SNAPSHOT_TTL_MS
  };
}

function publicNode(node) {
  return {
    nodeId: node.nodeId,
    playerId: node.playerId,
    handle: node.handle,
    roles: node.roles,
    region: node.region,
    quality: node.quality,
    updatedAt: node.updatedAt,
    expiresAt: node.expiresAt
  };
}

function cleanReceipt(receipt = {}, fromPlayerId = "") {
  const clean = safeObject(receipt);
  return {
    matchId: cleanId(clean.matchId, 128),
    side: String(clean.side || "").toLowerCase() === "north" ? "north" : "south",
    playerId: cleanId(clean.playerId || fromPlayerId, 128),
    clientSeq: Number(clean.clientSeq) || 0,
    serverSeq: Number(clean.serverSeq) || 0,
    previousHash: cleanHash(clean.previousHash),
    actionHash: cleanHash(clean.actionHash),
    chainHash: cleanHash(clean.chainHash),
    stateHash: cleanHash(clean.stateHash),
    verified: Boolean(clean.verified),
    gossipedAt: Date.now()
  };
}

function cleanRoles(value) {
  const source = Array.isArray(value) ? value : ["player", "cache"];
  const allowed = new Set(["player", "cache", "relay", "validator", "witness"]);
  const roles = source.map((item) => String(item || "").trim().toLowerCase()).filter((item) => allowed.has(item));
  return [...new Set(roles.length ? roles : ["player"])];
}

function cleanQuality(value = {}) {
  const quality = safeObject(value, 1024);
  return {
    pingMs: clampNumber(quality.pingMs, -1, 5000, -1),
    battery: clampNumber(quality.battery, -1, 100, -1),
    charging: Boolean(quality.charging),
    metered: Boolean(quality.metered)
  };
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function cleanRegion(value) {
  return String(value || "global").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 40) || "global";
}

function cleanId(value, maxLength = 96) {
  return String(value || "").trim().replace(/[^\w:.-]/g, "").slice(0, maxLength);
}

function cleanHash(value) {
  const text = String(value || "").trim().toLowerCase();
  if (text === "genesis") return "genesis";
  return /^[a-f0-9]{64}$/.test(text) ? text : "";
}

function safeObject(value, maxLength = 8192) {
  if (!value || typeof value !== "object") return {};
  try {
    return JSON.parse(JSON.stringify(value).slice(0, maxLength));
  } catch {
    return {};
  }
}
