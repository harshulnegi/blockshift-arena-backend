import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import jwt from "jsonwebtoken";
import { io as Client } from "socket.io-client";
import { attachSocketServer } from "../src/socket.js";
import { detectCountryFromRequest } from "../src/services/geo.js";
import { findProfile, leaderboard, persistMatch, toMatchPersistenceParams, updateProfileAvatar, upsertProfile, MAX_AVATAR_BYTES, MAX_BIO_WORDS, MIN_TROPHIES, STARTING_TROPHIES } from "../src/services/matchStore.js";

const JWT_SECRET = process.env.JWT_SECRET || "dev_secret_only";

test("match persistence sends replay as jsonb-safe JSON", () => {
  const state = {
    id: "jsonb_replay_test",
    mode: "ranked",
    ranked: true,
    status: "active",
    winner: null,
    players: {
      south: { id: "south_jsonb", handle: "SouthJson" },
      north: { id: "north_jsonb", handle: "NorthJson" }
    },
    replay: [{ n: 1, side: "south", action: { type: "move", row: 7, col: 4 }, at: 123 }]
  };
  const params = toMatchPersistenceParams(state);
  assert.equal(typeof params[4], "string");
  assert.equal(typeof params[5], "string");
  assert.deepEqual(JSON.parse(params[5]), state.replay);
});

test("new ranked profiles start at 100 trophies and never go below zero", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const fresh = await upsertProfile({ id: `fresh_${suffix}`, handle: "FreshPilot" });
  assert.equal(fresh.rating, STARTING_TROPHIES);
  assert.ok(Date.parse(fresh.joinedAt) > 0);

  const winner = { id: `winner_${suffix}`, handle: "WinnerPilot" };
  const loser = { id: `loser_${suffix}`, handle: "LoserPilot" };
  await upsertProfile(winner);
  await upsertProfile(loser);

  const deltaWinner = { id: `delta_winner_${suffix}`, handle: "DeltaWinner" };
  const deltaLoser = { id: `delta_loser_${suffix}`, handle: "DeltaLoser" };
  await upsertProfile(deltaWinner);
  await upsertProfile(deltaLoser);
  const rankedResult = await persistMatch({
    id: `delta_${suffix}`,
    mode: "ranked",
    ranked: true,
    status: "finished",
    winner: "south",
    players: { south: deltaWinner, north: deltaLoser },
    replay: []
  });
  assert.deepEqual(rankedResult.trophyDelta, { south: 16, north: -16 });
  await persistMatch(rankedResult);
  const deltaRows = await leaderboard(500);
  assert.equal(deltaRows.find((row) => row.id === deltaWinner.id).rating, STARTING_TROPHIES + 16);
  assert.equal(deltaRows.find((row) => row.id === deltaLoser.id).rating, STARTING_TROPHIES - 16);

  for (let index = 0; index < 12; index += 1) {
    await persistMatch({
      id: `floor_${suffix}_${index}`,
      mode: "ranked",
      ranked: true,
      status: "finished",
      winner: "south",
      players: { south: winner, north: loser },
      replay: []
    });
  }

  const rows = await leaderboard(500);
  const loserProfile = rows.find((row) => row.id === loser.id);
  assert.equal(loserProfile.rating, MIN_TROPHIES);
});

test("profile avatars are stored as tiny capped JPEG data urls", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const avatar = `data:image/jpeg;base64,${Buffer.alloc(256, 7).toString("base64")}`;
  const profile = await updateProfileAvatar({ id: `avatar_${suffix}`, handle: "AvatarPilot" }, avatar, "http://avatars.test");
  assert.match(profile.avatarUrl, new RegExp(`^http://avatars\\.test/avatars/avatar_${suffix}\\.jpg\\?v=\\d+$`));

  const rows = await leaderboard(500);
  assert.equal(rows.find((row) => row.id === profile.id).avatarUrl, profile.avatarUrl);

  const preset = await updateProfileAvatar({ id: `avatar_preset_${suffix}`, handle: "PresetPilot" }, "preset:violet");
  assert.equal(preset.avatarUrl, "preset:violet");
  const presetRows = await leaderboard(500);
  assert.equal(presetRows.find((row) => row.id === preset.id).avatarUrl, "preset:violet");
  assert.equal((await findProfile(preset.id)).avatarUrl, "preset:violet");
  assert.equal((await findProfile("PresetPilot")).avatarUrl, "preset:violet");

  const oversized = `data:image/jpeg;base64,${Buffer.alloc(MAX_AVATAR_BYTES + 1, 1).toString("base64")}`;
  await assert.rejects(
    () => updateProfileAvatar({ id: `avatar_big_${suffix}`, handle: "AvatarPilot" }, oversized),
    /avatar_too_large/
  );

  const cleared = await updateProfileAvatar({ id: profile.id, handle: "AvatarPilot" }, null, "http://avatars.test");
  assert.equal(cleared.avatarUrl, null);
});

test("profile handle, country, and bio updates stay visible after avatar sync", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const id = `profile_${suffix}`;
  await upsertProfile({ id, handle: "OldPilot", country: "US" });
  const longBio = "I race fast walls and study every replay because clean path pressure wins clutch endgames always while learning openings traps timing defense attacks vision patience focus";
  const updated = await upsertProfile({ id, handle: "maut", country: "IN", bio: longBio });
  assert.equal(updated.handle, "maut");
  assert.equal(updated.country, "IN");
  assert.equal(updated.bio.split(/\s+/).length, MAX_BIO_WORDS);
  assert.match(updated.bio, /^I race fast walls/);
  assert.ok(Date.parse(updated.joinedAt) > 0);

  const avatar = `data:image/jpeg;base64,${Buffer.alloc(128, 3).toString("base64")}`;
  const afterAvatar = await updateProfileAvatar({ id, handle: "OldPilot" }, avatar, "http://avatars.test");
  assert.equal(afterAvatar.handle, "maut");
  assert.equal(afterAvatar.country, "IN");
  assert.equal(afterAvatar.bio, updated.bio);
  assert.match(afterAvatar.avatarUrl, new RegExp(`^http://avatars\\.test/avatars/${id}\\.jpg\\?v=\\d+$`));
  assert.equal(afterAvatar.joinedAt, updated.joinedAt);

  const rows = await leaderboard(500);
  const row = rows.find((entry) => entry.id === id);
  assert.equal(row.handle, "maut");
  assert.equal(row.country, "IN");
  assert.equal(row.bio, updated.bio);
  assert.equal(row.avatarUrl, afterAvatar.avatarUrl);
});

test("country detection prefers edge IP country and falls back to device locale", () => {
  const edge = detectCountryFromRequest(
    {
      get: (name) => (name === "cf-ipcountry" ? "IN" : ""),
      ip: "203.0.113.4"
    },
    "US"
  );
  assert.deepEqual(edge, { country: "IN", source: "ip-edge" });

  const local = detectCountryFromRequest(
    {
      get: () => "",
      ip: "127.0.0.1"
    },
    "US"
  );
  assert.deepEqual(local, { country: "US", source: "device-locale" });
});

test("ranked matchmaking waits until another ranked player joins", async () => {
  const server = http.createServer();
  const io = attachSocketServer(server, null);
  await listen(server);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const sockets = [];

  try {
    const player = await connectUser(baseUrl, "ranked_1", "RankedPilot");
    const opponent = await connectUser(baseUrl, "ranked_2", "RankedRival");
    sockets.push(player, opponent);
    const foundEvent = onceAny(player, ["match:found"]);
    const firstAck = await emitAck(player, "matchmaking:join", {
      mode: "ranked",
      rating: 1200,
      fillBot: true,
      ballSkin: "core"
    });
    assert.equal(firstAck.queued, true);
    assert.equal(firstAck.matchId, undefined);
    assert.equal(firstAck.bot, undefined);

    const opponentFoundEvent = onceAny(opponent, ["match:found"]);
    const secondAck = await emitAck(opponent, "matchmaking:join", {
      mode: "ranked",
      rating: 1225,
      fillBot: true,
      ballSkin: "nova"
    });
    const found = await foundEvent;
    const opponentFound = await opponentFoundEvent;

    assert.equal(secondAck.queued, false);
    assert.equal(secondAck.bot, undefined);
    assert.equal(secondAck.state.ranked, true);
    assert.equal(secondAck.state.mode, "ranked");
    assert.equal(found.state.id, secondAck.state.id);
    assert.equal(opponentFound.state.id, secondAck.state.id);
    assert.equal(found.state.players.north.handle, "RankedPilot");
    assert.equal(opponentFound.state.players.south.handle, "RankedRival");
  } finally {
    for (const socket of sockets) socket.close();
    io.close();
    await close(server);
  }
});

test("match mesh advertises configured TURN relay candidates", async () => {
  const previous = {
    TURN_URLS: process.env.TURN_URLS,
    TURN_USERNAME: process.env.TURN_USERNAME,
    TURN_CREDENTIAL: process.env.TURN_CREDENTIAL,
    TURN_STATIC_AUTH_SECRET: process.env.TURN_STATIC_AUTH_SECRET
  };
  process.env.TURN_URLS = "turn:turn.blockshift.test:3478?transport=udp,turns:turn.blockshift.test:5349?transport=tcp";
  process.env.TURN_USERNAME = "turn_user";
  process.env.TURN_CREDENTIAL = "turn_secret";
  delete process.env.TURN_STATIC_AUTH_SECRET;

  const server = http.createServer();
  const io = attachSocketServer(server, null);
  await listen(server);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const sockets = [];

  try {
    const host = await connectUser(baseUrl, "turn_host", "TurnHost");
    const guest = await connectUser(baseUrl, "turn_guest", "TurnGuest");
    sockets.push(host, guest);

    const room = await emitAck(host, "room:create", { ballSkin: "core" });
    assert.equal(room.ok, true);
    const joined = await emitAck(guest, "room:join", { code: room.code, ballSkin: "nova" });
    assert.equal(joined.ok, true);
    assert.equal(joined.mesh.turnEnabled, true);
    assert.equal(joined.mesh.relayMode, "stun-turn");
    const turnServer = joined.mesh.iceServers.find((server) => server.urls.some((url) => url.startsWith("turn:")));
    assert.ok(turnServer);
    assert.equal(turnServer.username, "turn_user");
    assert.equal(turnServer.credential, "turn_secret");
  } finally {
    for (const socket of sockets) socket.close();
    io.close();
    await close(server);
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("malformed ICE env values do not leak assignment text into candidates", async () => {
  const previous = {
    ICE_STUN_URLS: process.env.ICE_STUN_URLS,
    TURN_URLS: process.env.TURN_URLS,
    TURN_USERNAME: process.env.TURN_USERNAME,
    TURN_CREDENTIAL: process.env.TURN_CREDENTIAL,
    TURN_STATIC_AUTH_SECRET: process.env.TURN_STATIC_AUTH_SECRET
  };
  process.env.ICE_STUN_URLS = "stun:stun.l.google.com:19302TURN_URLS=turn:bad.example:3478";
  process.env.TURN_URLS = "turn:turn.blockshift.test:3478?transport=udp";
  process.env.TURN_USERNAME = "turn_user";
  process.env.TURN_CREDENTIAL = "turn_secret";
  delete process.env.TURN_STATIC_AUTH_SECRET;

  const server = http.createServer();
  const io = attachSocketServer(server, null);
  await listen(server);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const sockets = [];

  try {
    const host = await connectUser(baseUrl, "turn_clean_host", "TurnCleanHost");
    const guest = await connectUser(baseUrl, "turn_clean_guest", "TurnCleanGuest");
    sockets.push(host, guest);

    const room = await emitAck(host, "room:create", { ballSkin: "core" });
    const joined = await emitAck(guest, "room:join", { code: room.code, ballSkin: "nova" });
    const urls = joined.mesh.iceServers.flatMap((server) => server.urls || []);
    assert.ok(urls.includes("turn:turn.blockshift.test:3478?transport=udp"));
    assert.equal(urls.some((url) => url.includes("TURN_URLS=")), false);
  } finally {
    for (const socket of sockets) socket.close();
    io.close();
    await close(server);
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("active match Redis snapshots are coalesced while final state writes immediately", async () => {
  const redis = {
    setCalls: [],
    async set(...args) {
      this.setCalls.push(args);
      return "OK";
    },
    async get() {
      return null;
    }
  };
  const server = http.createServer();
  const io = attachSocketServer(server, redis);
  await listen(server);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const sockets = [];

  try {
    const host = await connectUser(baseUrl, "cache_host", "CacheHost");
    const guest = await connectUser(baseUrl, "cache_guest", "CacheGuest");
    sockets.push(host, guest);

    const room = await emitAck(host, "room:create", { ballSkin: "core" });
    const joined = await emitAck(guest, "room:join", { code: room.code, ballSkin: "nova" });
    assert.equal(joined.ok, true);
    assert.equal(redis.setCalls.length, 1);

    const move = await emitAck(host, "match:action", {
      matchId: joined.matchId,
      clientSeq: 1,
      action: { type: "move", row: 7, col: 4 }
    });
    assert.equal(move.ok, true);
    assert.equal(redis.setCalls.length, 1);

    const left = await emitAck(host, "match:leave", { matchId: joined.matchId });
    assert.equal(left.ok, true);
    assert.equal(left.state.status, "finished");
    assert.ok(redis.setCalls.length >= 2);
  } finally {
    for (const socket of sockets) socket.close();
    io.close();
    await close(server);
  }
});

test("spectator joins are watch only and cannot submit actions", async () => {
  const server = http.createServer();
  const io = attachSocketServer(server, null);
  await listen(server);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const sockets = [];

  try {
    const host = await connectUser(baseUrl, "spectator_host", "SameHandle");
    const guest = await connectUser(baseUrl, "spectator_guest", "GuestPlayer");
    const spectator = await connectUser(baseUrl, "spectator_viewer", "SameHandle");
    sockets.push(host, guest, spectator);

    const room = await emitAck(host, "room:create", { ballSkin: "core" });
    assert.equal(room.ok, true);
    const joined = await emitAck(guest, "room:join", { code: room.code, ballSkin: "nova" });
    assert.equal(joined.ok, true);

    const spectatorJoined = onceAny(host, ["match:spectators"]);
    const watch = await emitAck(spectator, "match:join", { matchId: joined.matchId, spectator: true });
    const joinedCount = await spectatorJoined;
    assert.equal(watch.spectator, true);
    assert.equal(watch.side, null);
    assert.deepEqual(watch.legalMoves, []);
    assert.equal(watch.state.spectatorCount, 1);
    assert.equal(joinedCount.count, 1);

    const chatEvent = onceAny(host, ["match:chat"]);
    const chatAck = await emitAck(guest, "match:chat", { matchId: joined.matchId, message: "Good luck" });
    const deliveredChat = await chatEvent;
    assert.equal(chatAck.ok, true);
    assert.equal(chatAck.message.message, "Good luck");
    assert.equal(deliveredChat.matchId, joined.matchId);
    assert.equal(deliveredChat.message, "Good luck");

    const spectatorChat = await emitAck(spectator, "match:chat", { matchId: joined.matchId, message: "I should not talk" });
    assert.equal(spectatorChat.error, "not_a_player");

    const rejected = await emitAck(spectator, "match:action", {
      matchId: joined.matchId,
      clientSeq: 1,
      action: { type: "move", row: 7, col: 4 }
    });
    assert.equal(rejected.error, "not_a_player");

    const spectatorLeft = onceAny(host, ["match:spectators"]);
    const left = await emitAck(spectator, "match:leave", { matchId: joined.matchId });
    const leftCount = await spectatorLeft;
    assert.equal(left.ok, true);
    assert.equal(left.spectator, true);
    assert.equal(leftCount.count, 0);
  } finally {
    for (const socket of sockets) socket.close();
    io.close();
    await close(server);
  }
});

test("players cannot send friend requests to themselves", async () => {
  const server = http.createServer();
  const io = attachSocketServer(server, null);
  await listen(server);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const sockets = [];

  try {
    await upsertProfile({ id: "friend_self_1", handle: "SelfPilot" });
    const player = await connectUser(baseUrl, "friend_self_1", "SelfPilot");
    sockets.push(player);

    const sameId = await emitAck(player, "friends:request", { targetId: "friend_self_1", targetHandle: "SelfPilot" });
    assert.equal(sameId.error, "cannot_add_self");

    const sameHandle = await emitAck(player, "friends:request", { targetHandle: "selfpilot" });
    assert.equal(sameHandle.error, "cannot_add_self");
  } finally {
    for (const socket of sockets) socket.close();
    io.close();
    await close(server);
  }
});

test("friends can remove each other and disappear from both friend lists", async () => {
  const server = http.createServer();
  const io = attachSocketServer(server, null);
  await listen(server);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const sockets = [];

  try {
    await upsertProfile({ id: "friend_remove_a", handle: "RemoveA" });
    await upsertProfile({ id: "friend_remove_b", handle: "RemoveB" });
    const left = await connectUser(baseUrl, "friend_remove_a", "RemoveA");
    const right = await connectUser(baseUrl, "friend_remove_b", "RemoveB");
    sockets.push(left, right);

    const request = await emitAck(left, "friends:request", { targetId: "friend_remove_b", targetHandle: "RemoveB" });
    assert.equal(request.ok, true);
    const accept = await emitAck(right, "friends:respond", { requestId: request.request.id, accepted: true });
    assert.equal(accept.ok, true);
    assert.equal(accept.accepted, true);

    const beforeLeft = await emitAck(left, "friends:list", {});
    const beforeRight = await emitAck(right, "friends:list", {});
    assert.equal(beforeLeft.friends.length, 1);
    assert.equal(beforeRight.friends.length, 1);

    const removed = await emitAck(left, "friends:remove", { friendId: "friend_remove_b", friendHandle: "RemoveB" });
    assert.equal(removed.ok, true);
    assert.equal(removed.removed, true);

    const afterLeft = await emitAck(left, "friends:list", {});
    const afterRight = await emitAck(right, "friends:list", {});
    assert.equal(afterLeft.friends.length, 0);
    assert.equal(afterRight.friends.length, 0);
  } finally {
    for (const socket of sockets) socket.close();
    io.close();
    await close(server);
  }
});

test("friend challenge recipient timer grows after three rejects", async () => {
  const server = http.createServer();
  const io = attachSocketServer(server, null);
  await listen(server);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const sockets = [];

  try {
    await upsertProfile({ id: "challenge_timer_a", handle: "TimerA" });
    await upsertProfile({ id: "challenge_timer_b", handle: "TimerB" });
    const sender = await connectUser(baseUrl, "challenge_timer_a", "TimerA");
    const recipient = await connectUser(baseUrl, "challenge_timer_b", "TimerB");
    sockets.push(sender, recipient);

    const request = await emitAck(sender, "friends:request", { targetId: "challenge_timer_b", targetHandle: "TimerB" });
    assert.equal(request.ok, true);
    const accept = await emitAck(recipient, "friends:respond", { requestId: request.request.id, accepted: true });
    assert.equal(accept.accepted, true);

    for (let index = 0; index < 3; index += 1) {
      const incoming = onceAny(recipient, ["friends:challenge"]);
      const challenge = await emitAck(sender, "friends:challenge", { friendId: "challenge_timer_b", ballSkin: "core" });
      const offer = await incoming;
      assert.equal(challenge.ok, true);
      assert.equal(challenge.pending, true);
      assert.equal(challenge.challenge.responseMs, 10000);
      assert.equal(offer.responseMs, 10000);
      assert.ok(offer.expiresAt - Date.now() <= 10100);
      const rejectedEvent = onceAny(sender, ["friends:challengeRejected"]);
      const rejected = await emitAck(recipient, "friends:challengeRespond", { challengeId: offer.id, accepted: false });
      const rejectedPayload = await rejectedEvent;
      assert.equal(rejected.ok, true);
      assert.equal(rejected.accepted, false);
      assert.equal(rejected.rejectCount, index + 1);
      assert.equal(rejected.cooldownMs, index + 1 >= 3 ? 20000 : 5000);
      assert.equal(rejectedPayload.cooldownMs, index + 1 >= 3 ? 20000 : 5000);
      assert.equal(rejectedPayload.friendId, "challenge_timer_b");
    }

    const incoming = onceAny(recipient, ["friends:challenge"]);
    const challenge = await emitAck(sender, "friends:challenge", { friendId: "challenge_timer_b", ballSkin: "core" });
    const offer = await incoming;
    assert.equal(challenge.challenge.responseMs, 20000);
    assert.equal(offer.responseMs, 20000);
    assert.ok(offer.expiresAt - Date.now() <= 20100);
    await emitAck(sender, "friends:challengeCancel", { challengeId: offer.id });
  } finally {
    for (const socket of sockets) socket.close();
    io.close();
    await close(server);
  }
});

test("rematch offer reaches a reconnected opponent with the same handle", async () => {
  const server = http.createServer();
  const io = attachSocketServer(server, null);
  await listen(server);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const sockets = [];

  try {
    const host = await connectUser(baseUrl, "host_1", "HostPlayer");
    const guestOld = await connectUser(baseUrl, "guest_old", "GuestPlayer");
    sockets.push(host, guestOld);

    const room = await emitAck(host, "room:create", { ballSkin: "core" });
    assert.equal(room.ok, true);
    const joined = await emitAck(guestOld, "room:join", { code: room.code, ballSkin: "nova" });
    assert.equal(joined.ok, true);
    const matchId = joined.matchId;

    const left = await emitAck(guestOld, "match:leave", { matchId });
    assert.equal(left.ok, true);
    assert.equal(left.state.status, "finished");
    guestOld.close();

    const guestNew = await connectUser(baseUrl, "guest_new", "GuestPlayer");
    sockets.push(guestNew);
    const incomingOffer = onceAny(guestNew, ["notification:rematchOffer", "match:rematchOffer", "rematch:offer"]);

    const offerAck = await emitAck(host, "match:rematchOffer", { matchId });
    assert.equal(offerAck.ok, true);
    assert.equal(offerAck.pending, true);

    const offer = await incomingOffer;
    assert.equal(offer.matchId, matchId);
    assert.equal(offer.toHandle, "GuestPlayer");

    const accepted = await emitAck(guestNew, "match:rematchRespond", { matchId, accepted: true });
    assert.equal(accepted.ok, true);
    assert.equal(accepted.accepted, true);
    assert.equal(accepted.state.players.north.id, "guest_new");
  } finally {
    for (const socket of sockets) socket.close();
    io.close();
    await close(server);
  }
});

function connectUser(baseUrl, id, handle) {
  const token = jwt.sign({ id, handle, role: "player" }, JWT_SECRET, {
    issuer: "blockshift-arena",
    expiresIn: "2h"
  });
  const socket = Client(baseUrl, {
    auth: { token },
    transports: ["websocket"],
    forceNew: true,
    reconnection: false
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`connect_timeout:${id}`)), 3000);
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("connect_error", reject);
  });
}

function emitAck(socket, event, payload) {
  return new Promise((resolve) => {
    socket.emit(event, payload, (response = {}) => resolve(response));
  });
}

function onceAny(socket, events) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      for (const event of events) socket.off(event, handlers.get(event));
    };
    const handlers = new Map(events.map((event) => [event, (payload) => {
      cleanup();
      resolve(payload);
    }]));
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timeout:${events.join("|")}`));
    }, 3000);
    for (const [event, handler] of handlers) socket.on(event, handler);
  });
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
