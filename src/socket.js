import { Server } from "socket.io";
import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { createInitialState, applyAction, finishByClockTimeout, legalMoves, normalizeBallSkin, opponentOf, remainingClockMs } from "./game/rules.js";
import { chooseAiAction } from "./game/ai.js";
import { Matchmaker } from "./services/matchmaker.js";
import { cachedHiveSnapshot, hiveCapabilities, hiveReceiptsForMatch, hiveStats, publicHiveEdge, registerHiveNode, rememberHiveReceipts, unregisterHiveSocket } from "./services/hive.js";
import { findProfile, leaderboard, persistMatch, upsertProfile } from "./services/matchStore.js";

const matches = new Map();
const matchClockTimers = new Map();
const socketsByPlayer = new Map();
const spectatorsByMatch = new Map();
const meshConfigByMatch = new Map();
const meshReceiptsByMatch = new Map();
const meshChainsByMatch = new Map();
const meshFallbackByMatch = new Map();
const customRooms = new Map();
const ROOM_TTL_MS = 15 * 60 * 1000;
const REMATCH_TTL_MS = 60 * 1000;
const rematchOffers = new Map();
const rematchInboxByPlayer = new Map();
const rematchInboxByHandle = new Map();
const queuedTicketsByPlayer = new Map();
const friendRequests = new Map();
const friendships = new Map();
const friendChallenges = new Map();
const friendChallengeTimers = new Map();
const friendChallengeRejectCounts = new Map();
const friendMessages = new Map();
let activeMatchRedis = null;
const ACTIVE_MATCH_TTL_SECONDS = Number(process.env.ACTIVE_MATCH_TTL_SECONDS || 60 * 60 * 6);
const CHALLENGE_RESPONSE_MS = 10 * 1000;
const CHALLENGE_REJECT_COOLDOWN_MS = 5 * 1000;
const CHALLENGE_EXTENDED_RESPONSE_MS = 20 * 1000;
const CHALLENGE_REJECT_THRESHOLD = 3;
const DEFAULT_STUN_URLS = ["stun:stun.l.google.com:19302", "stun:global.stun.twilio.com:3478"];
const SPECTATOR_STATE_INTERVAL_MS = Number(process.env.SPECTATOR_STATE_INTERVAL_MS || 1200);
const ACTIVE_MATCH_CACHE_FLUSH_MS = Math.max(0, Number(process.env.ACTIVE_MATCH_CACHE_FLUSH_MS || 750));
const MESH_RECEIPT_WINDOW = Math.max(8, Math.min(120, Number(process.env.MESH_RECEIPT_WINDOW || 32)));
const spectatorStateLastSentAt = new Map();
const pendingActiveMatchCacheSaves = new Map();
const activeMatchCacheTimers = new Map();

export function attachSocketServer(httpServer, redis, options = {}) {
  activeMatchRedis = redis || null;
  const matchmakerRedis = Object.prototype.hasOwnProperty.call(options, "matchmakerRedis")
    ? options.matchmakerRedis
    : redis;
  const io = new Server(httpServer, {
    cors: { origin: process.env.CLIENT_ORIGIN || "*", credentials: true },
    serveClient: false,
    httpCompression: false,
    perMessageDeflate: false,
    pingInterval: 10000,
    pingTimeout: 7000
  });
  const matchmaker = new Matchmaker(matchmakerRedis);

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    try {
      socket.user = jwt.verify(token, process.env.JWT_SECRET || "dev_secret_only", { issuer: "blockshift-arena" });
      next();
    } catch {
      next(new Error("unauthorized"));
    }
  });

  io.on("connection", (socket) => {
    socketsByPlayer.set(socket.user.id, socket.id);
    socket.emit("presence:ready", { playerId: socket.user.id, serverTime: Date.now(), mesh: { version: 1, signaling: true, serverFallback: true }, hive: hiveCapabilities() });
    socket.broadcast.emit("presence:online", { playerId: socket.user.id, handle: socket.user.handle, at: Date.now() });
    deliverPendingRematches(io, socket.user.id, socket.user.handle);
    deliverPendingFriendRequests(io, socket);
    deliverPendingFriendChallenges(io, socket);
    emitSocialSnapshot(io, socket);
    broadcastFriendPresence(io, socket.user.id);
    socket.emit("room:listUpdated", { rooms: publicRoomList() });

    socket.on("matchmaking:join", async (payload = {}, ack) => {
      const profile = await upsertProfile({ id: socket.user.id, handle: socket.user.handle });
      await cancelQueuedTicket(matchmaker, socket.user.id);
      const ticket = {
        player: playerFromSocket(socket, payload, profile),
        rating: normalizedRating(payload.rating),
        region: "global",
        mode: payload.mode || "casual",
        ranked: payload.mode === "ranked"
      };
      const pair = await matchmaker.enqueue(ticket);
      if (pair) {
        queuedTicketsByPlayer.delete(pair[0].player.id);
        queuedTicketsByPlayer.delete(pair[1].player.id);
        const state = startMatch(io, ticket, [pair[0].player, pair[1].player]);
        return ack?.({
          queued: false,
          matchId: state.id,
          side: sideForPlayer(state, socket.user.id),
          state,
          mesh: activeMeshConfig(state.id),
          legalMoves: legalMoves(state, state.turn)
        });
      }
      const allowBotFill = payload.fillBot && ticket.mode !== "ranked";
      if (allowBotFill) {
        await matchmaker.cancel(ticket);
        const bot = { id: `bot_${Math.random().toString(36).slice(2, 8)}`, handle: "AI Opponent", ballSkin: "blade" };
        const state = startMatch(io, ticket, [bot, ticket.player]);
        return ack?.({
          queued: false,
          matchId: state.id,
          bot: true,
          side: sideForPlayer(state, socket.user.id),
          state,
          mesh: activeMeshConfig(state.id),
          legalMoves: legalMoves(state, state.turn)
        });
      }
      queuedTicketsByPlayer.set(socket.user.id, ticket);
      broadcastFriendPresence(io, socket.user.id);
      return ack?.({ queued: true });
    });

    socket.on("matchmaking:cancel", async (_payload = {}, ack) => {
      await cancelQueuedTicket(matchmaker, socket.user.id);
      broadcastFriendPresence(io, socket.user.id);
      ack?.({ ok: true });
    });

    socket.on("room:create", async (payload = {}, ack) => {
      pruneExpiredRooms(io);
      const profile = await upsertProfile({ id: socket.user.id, handle: socket.user.handle });
      removeHostedRooms(io, socket.user.id);
      const code = createRoomCode();
      const room = {
        code,
        createdAt: Date.now(),
        expiresAt: Date.now() + ROOM_TTL_MS,
        ticket: {
          player: playerFromSocket(socket, payload, profile),
          rating: normalizedRating(payload.rating),
          region: "global",
          mode: "custom",
          ranked: false
        }
      };
      customRooms.set(code, room);
      socket.join(`room:${code}`);
      const host = publicPlayer(room.ticket.player);
      socket.emit("room:created", { code, players: 1, expiresAt: room.expiresAt, host });
      broadcastRoomList(io);
      ack?.({ ok: true, code, players: 1, expiresAt: room.expiresAt, host });
    });

    socket.on("room:list", (_payload = {}, ack) => {
      pruneExpiredRooms(io);
      ack?.({ ok: true, rooms: publicRoomList() });
    });

    socket.on("room:join", async (payload = {}, ack) => {
      pruneExpiredRooms(io);
      const code = normalizeRoomCode(payload.code);
      const room = customRooms.get(code);
      if (!room) return ack?.({ error: "room_not_found" });
      if (room.ticket.player.id === socket.user.id) return ack?.({ error: "already_hosting_room", code });
      const profile = await upsertProfile({ id: socket.user.id, handle: socket.user.handle });
      customRooms.delete(code);
      socket.join(`room:${code}`);
      const guest = playerFromSocket(socket, payload, profile);
      const state = startMatch(io, room.ticket, [guest, room.ticket.player]);
      const matchedPayload = { code, matchId: state.id, state, players: state.players, mesh: activeMeshConfig(state.id) };
      console.log("ArenaP2P room matched", { code, matchId: state.id, mesh: redactedMeshConfig(matchedPayload.mesh) });
      io.to(`room:${code}`).emit("room:matched", matchedPayload);
      io.to(`room:${code}`).emit("room:closed", { code, matchId: state.id });
      broadcastRoomList(io);
      ack?.({ ok: true, code, matchId: state.id, side: sideForPlayer(state, socket.user.id), state, players: state.players, mesh: activeMeshConfig(state.id) });
    });

    socket.on("room:cancel", (payload = {}, ack) => {
      const code = normalizeRoomCode(payload.code);
      const room = customRooms.get(code);
      if (!room) return ack?.({ ok: true });
      if (room.ticket.player.id !== socket.user.id) return ack?.({ error: "not_room_host" });
      customRooms.delete(code);
      io.to(`room:${code}`).emit("room:closed", { code, reason: "host_cancelled" });
      broadcastRoomList(io);
      ack?.({ ok: true });
    });

    socket.on("match:join", async ({ matchId, spectator = false }, ack) => {
      const state = await settleClockTimeout(io, matchId) || await loadActiveMatch(matchId);
      if (!state) return ack?.({ error: "match_not_found" });
      removeSpectator(io, socket, socket.data?.spectatingMatchId);
      socket.join(`match:${matchId}`);
      const playerSide = sideForUser(state, socket.user);
      const side = spectator ? null : playerSide;
      const watching = spectator || !side;
      if (watching) {
        spectatorSet(matchId).add(socket.id);
        socket.data.spectatingMatchId = matchId;
        socket.join(spectatorRoom(matchId));
      } else {
        socket.data.spectatingMatchId = "";
        socket.join(playerRoom(matchId));
      }
      const publicState = stateWithSpectators(matchId, state);
      ack?.({ matchId, state: publicState, side, spectator: watching, mesh: activeMeshConfig(matchId), legalMoves: side ? legalMoves(state, side) : [] });
      if (side) socket.to(`match:${matchId}`).emit("match:playerReconnected", { matchId, side, handle: state.players[side].handle, at: Date.now() });
      if (watching) socket.to(`match:${matchId}`).emit("spectator:joined", { handle: socket.user.handle });
      emitSpectatorCount(io, matchId);
    });

    socket.on("connection:ping", (payload = {}, ack) => {
      ack?.({ ok: true, sentAt: payload.sentAt, serverTime: Date.now() });
    });

    socket.on("rematch:inbox", (_payload = {}, ack) => {
      pruneExpiredRematches(io);
      const offers = pendingRematchOffersFor(socket.user.id, socket.user.handle).map(rematchOfferPayload);
      ack?.({ ok: true, offers });
    });

    socket.on("friends:list", async (_payload = {}, ack) => {
      pruneExpiredFriendChallenges(io);
      ack?.({ ok: true, friends: await publicFriendList(socket.user), requests: publicFriendRequestsFor(socket.user) });
    });

    socket.on("friends:request", async (payload = {}, ack) => {
      const lookup = String(payload.targetId || payload.targetHandle || payload.handle || "").trim();
      if (!lookup) return ack?.({ error: "friend_not_found" });
      const target = await findProfile(lookup);
      if (!target) return ack?.({ error: "player_not_found" });
      if (target.id === socket.user.id || sameHandle(target.handle, socket.user.handle)) return ack?.({ error: "cannot_add_self" });
      if (areFriends(socket.user.id, target.id)) return ack?.({ ok: true, alreadyFriends: true, request: null });
      const duplicate = existingFriendRequest(socket.user, target);
      if (duplicate) return ack?.({ ok: true, pending: true, request: publicFriendRequest(duplicate, socket.user) });
      const request = {
        id: `fr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        fromId: socket.user.id,
        fromHandle: socket.user.handle,
        toId: target.id,
        toHandle: target.handle,
        createdAt: Date.now()
      };
      friendRequests.set(request.id, request);
      emitFriendRequest(io, request);
      ack?.({ ok: true, pending: true, request: publicFriendRequest(request, socket.user) });
    });

    socket.on("friends:respond", async (payload = {}, ack) => {
      const request = friendRequests.get(String(payload.requestId || ""));
      if (!request) return ack?.({ error: "friend_request_not_found" });
      if (!sameFriendRecipient(request, socket.user)) return ack?.({ error: "not_friend_request_recipient" });
      friendRequests.delete(request.id);
      if (payload.accepted) {
        friendships.set(friendshipKey(request.fromId, socket.user.id), {
          aId: request.fromId,
          aHandle: request.fromHandle,
          bId: socket.user.id,
          bHandle: socket.user.handle || request.toHandle,
          createdAt: Date.now()
        });
        emitFriendAccepted(io, request, socket.user);
        await emitSocialSnapshotToPlayer(io, request.fromId);
        await emitSocialSnapshotToPlayer(io, socket.user.id);
        return ack?.({ ok: true, accepted: true, friends: await publicFriendList(socket.user), requests: publicFriendRequestsFor(socket.user) });
      }
      emitFriendRejected(io, request, socket.user);
      ack?.({ ok: true, accepted: false, friends: await publicFriendList(socket.user), requests: publicFriendRequestsFor(socket.user) });
    });

    socket.on("friends:remove", async (payload = {}, ack) => {
      const target = await resolveFriendTarget(payload);
      const entry = friendshipEntryForPayload(socket.user, payload, target);
      if (!target && !entry) return ack?.({ error: "friend_not_found" });
      if (!entry) {
        return ack?.({ error: "not_friends" });
      }
      friendships.delete(entry.key);
      await emitSocialSnapshotToPlayer(io, socket.user.id);
      const otherId = otherFriendId(entry.friendship, socket.user);
      if (otherId) await emitSocialSnapshotToPlayer(io, otherId);
      ack?.({
        ok: true,
        removed: true,
        friendId: target?.id || otherId,
        friendHandle: target?.handle || otherFriendHandle(entry.friendship, socket.user),
        friends: await publicFriendList(socket.user),
        requests: publicFriendRequestsFor(socket.user)
      });
    });

    socket.on("friends:messages", async (payload = {}, ack) => {
      const target = await resolveFriendTarget(payload);
      if (!target) return ack?.({ error: "friend_not_found" });
      if (!areFriends(socket.user.id, target.id)) return ack?.({ error: "not_friends" });
      ack?.({ ok: true, friendId: target.id, messages: publicFriendMessages(socket.user.id, target.id) });
    });

    socket.on("friends:message", async (payload = {}, ack) => {
      const target = await resolveFriendTarget(payload);
      if (!target) return ack?.({ error: "friend_not_found" });
      if (!areFriends(socket.user.id, target.id)) return ack?.({ error: "not_friends" });
      const clean = String(payload.message || "").trim().slice(0, 240);
      if (!clean) return ack?.({ error: "empty_message" });
      const message = {
        id: `fm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        fromId: socket.user.id,
        fromHandle: socket.user.handle,
        toId: target.id,
        toHandle: target.handle,
        message: clean,
        createdAt: Date.now()
      };
      appendFriendMessage(message);
      const publicMessage = publicFriendMessage(message);
      socket.emit("friends:message", publicMessage);
      const targetSocketId = socketsByPlayer.get(target.id) || socketIdForHandle(io, target.handle);
      if (targetSocketId) io.to(targetSocketId).emit("friends:message", publicMessage);
      ack?.({ ok: true, message: publicMessage });
    });

    socket.on("friends:challenge", async (payload = {}, ack) => {
      pruneExpiredFriendChallenges(io);
      const friendId = String(payload.friendId || payload.targetId || "").trim();
      if (!friendId) return ack?.({ error: "friend_not_found" });
      if (!areFriends(socket.user.id, friendId)) return ack?.({ error: "not_friends" });
      const targetSocketId = socketsByPlayer.get(friendId);
      if (!targetSocketId) return ack?.({ error: "friend_offline" });
      const requesterProfile = await upsertProfile({ id: socket.user.id, handle: socket.user.handle });
      const targetProfile = await findProfile(friendId);
      const rejectCount = friendChallengeRejectCount(socket.user.id, friendId);
      const responseMs = friendChallengeResponseMs(socket.user.id, friendId);
      const now = Date.now();
      const offer = {
        id: `fc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        fromId: socket.user.id,
        fromHandle: requesterProfile.handle || socket.user.handle,
        toId: friendId,
        toHandle: targetProfile?.handle || payload.friendHandle || "Friend",
        fromBallSkin: normalizeBallSkin(payload.ballSkin),
        rejectCount,
        responseMs,
        expiresAt: now + responseMs
      };
      friendChallenges.set(offer.id, offer);
      scheduleFriendChallengeExpiry(io, offer);
      const publicOffer = publicFriendChallenge(offer);
      io.to(targetSocketId).emit("notification:friendChallenge", publicOffer);
      io.to(targetSocketId).emit("friends:challenge", publicOffer);
      ack?.({ ok: true, pending: true, challenge: publicOffer });
    });

    socket.on("friends:challengeCancel", async (payload = {}, ack) => {
      const challengeId = String(payload.challengeId || "").trim();
      const offer = friendChallenges.get(challengeId);
      if (!offer) return ack?.({ ok: true, cancelled: true });
      if (offer.fromId !== socket.user.id && !sameHandle(offer.fromHandle, socket.user.handle)) return ack?.({ error: "not_challenge_owner" });
      friendChallenges.delete(challengeId);
      clearFriendChallengeTimer(challengeId);
      const targetSocketId = socketsByPlayer.get(offer.toId) || socketIdForHandle(io, offer.toHandle);
      if (targetSocketId) {
        io.to(targetSocketId).emit("friends:challengeCancelled", {
          challengeId,
          fromHandle: offer.fromHandle,
          at: Date.now()
        });
      }
      ack?.({ ok: true, cancelled: true, challengeId });
    });

    socket.on("friends:challengeRespond", async (payload = {}, ack) => {
      pruneExpiredFriendChallenges(io);
      const offer = friendChallenges.get(String(payload.challengeId || ""));
      if (!offer) return ack?.({ error: "challenge_not_found" });
      if (offer.toId !== socket.user.id && !sameHandle(offer.toHandle, socket.user.handle)) return ack?.({ error: "not_challenge_recipient" });
      friendChallenges.delete(offer.id);
      clearFriendChallengeTimer(offer.id);
      const requesterSocketId = socketsByPlayer.get(offer.fromId) || socketIdForHandle(io, offer.fromHandle);
      if (!payload.accepted) {
        const rejectCount = incrementFriendChallengeRejectCount(offer.fromId, offer.toId);
        const nextResponseMs = friendChallengeResponseMs(offer.fromId, offer.toId);
        const cooldownMs = friendChallengeRejectCooldownMs(rejectCount);
        const cooldownUntil = Date.now() + cooldownMs;
        if (requesterSocketId) {
          io.to(requesterSocketId).emit("friends:challengeRejected", {
            challengeId: offer.id,
            friendId: offer.toId,
            friendHandle: socket.user.handle,
            fromHandle: socket.user.handle,
            rejectCount,
            cooldownMs,
            cooldownUntil,
            nextResponseMs,
            at: Date.now()
          });
        }
        return ack?.({ ok: true, accepted: false, rejectCount, cooldownMs, cooldownUntil, nextResponseMs });
      }
      resetFriendChallengeRejectCount(offer.fromId, offer.toId);
      const accepterProfile = await upsertProfile({ id: socket.user.id, handle: socket.user.handle });
      const requesterProfile = await findProfile(offer.fromId);
      const ticket = { mode: "challenge", ranked: false };
      const state = startMatch(io, ticket, [
        {
          id: accepterProfile.id,
          handle: accepterProfile.handle,
          avatarUrl: accepterProfile.avatarUrl || null,
          ballSkin: normalizeBallSkin(payload.ballSkin)
        },
        {
          id: offer.fromId,
          handle: requesterProfile?.handle || offer.fromHandle,
          avatarUrl: requesterProfile?.avatarUrl || null,
          ballSkin: offer.fromBallSkin
        }
      ]);
      const acceptedPayload = { challengeId: offer.id, matchId: state.id, state, mesh: activeMeshConfig(state.id), acceptedBy: socket.user.handle, at: Date.now() };
      if (requesterSocketId) io.to(requesterSocketId).emit("friends:challengeAccepted", acceptedPayload);
      ack?.({ ok: true, accepted: true, matchId: state.id, state, mesh: activeMeshConfig(state.id) });
      await emitSocialSnapshotToPlayer(io, offer.fromId);
      await emitSocialSnapshotToPlayer(io, offer.toId);
    });

    socket.on("match:action", async ({ matchId, clientSeq, action, meshEnvelope }, ack) => {
      const state = await settleClockTimeout(io, matchId) || await loadActiveMatch(matchId);
      if (!state) return ack?.({ error: "match_not_found" });
      if (state.status !== "active") return ack?.({ ok: true, state: stateWithSpectators(matchId, state), legalMoves: [] });
      const side = Object.entries(state.players).find(([, p]) => p.id === socket.user.id)?.[0];
      if (!side) return ack?.({ error: "not_a_player" });
      const meshReceipt = verifyMeshEnvelope(state, side, action, clientSeq, meshEnvelope);
      if (state.ranked && !meshReceipt.verified) {
        socket.emit("antiCheat:rejected", { reason: "invalid_arena_hive_receipt", serverState: state });
        return ack?.({ error: "invalid_arena_hive_receipt" });
      }
      try {
        const next = applyAction(state, side, action);
        const finalState = next.status === "active" && next.players[next.turn].id.startsWith("bot_")
          ? applyAction(next, next.turn, chooseAiAction(next, next.turn, "hard").action)
          : next;
        meshReceipt.serverSeq = finalState.replay.length;
        const proofState = stateWithMeshReceipt(finalState, meshReceipt);
        commitMeshReceipt(matchId, meshReceipt, proofState);
        const storedState = await storeMatchState(proofState);
        scheduleMatchClock(io, matchId);
        const publicState = stateWithSpectators(matchId, storedState);
        emitMatchState(io, matchId, { matchId, state: publicState, mesh: activeMeshConfig(matchId), lastAction: action, clientSeq, meshReceipt }, storedState);
        io.to(`match:${matchId}`).emit("mesh:receipt", meshReceipt);
        ack?.({ ok: true, state: publicState, legalMoves: storedState.status === "active" ? legalMoves(storedState, storedState.turn) : [] });
      } catch (error) {
        ack?.({ error: error.message });
        socket.emit("antiCheat:rejected", { reason: error.message, serverState: state });
      }
    });

    socket.on("mesh:ready", async (payload = {}, ack) => {
      const matchId = String(payload.matchId || "").trim();
      const state = await loadActiveMatch(matchId);
      if (!state) return ack?.({ error: "match_not_found" });
      const side = sideForUser(state, socket.user);
      if (!side) return ack?.({ error: "not_a_player" });
      socket.join(`mesh:${matchId}`);
      socket.data.meshMatchId = matchId;
      const event = {
        matchId,
        playerId: socket.user.id,
        side,
        handle: state.players[side].handle,
        nodeId: cleanId(payload.nodeId, 64),
        capabilities: safeObject(payload.capabilities),
        at: Date.now()
      };
      socket.to(`mesh:${matchId}`).emit("mesh:peerReady", event);
      console.log("ArenaP2P mesh ready", { matchId, playerId: socket.user.id, side, nodeId: event.nodeId });
      ack?.({ ok: true, matchId, mesh: activeMeshConfig(matchId) });
    });

    socket.on("mesh:signal", async (payload = {}, ack) => {
      const matchId = String(payload.matchId || "").trim();
      const state = await loadActiveMatch(matchId);
      if (!state) return ack?.({ error: "match_not_found" });
      const fromSide = sideForUser(state, socket.user);
      if (!fromSide) return ack?.({ error: "not_a_player" });
      const toPlayerId = cleanId(payload.toPlayerId, 128);
      const toSide = sideForPlayer(state, toPlayerId);
      if (!toSide || toSide === fromSide) return ack?.({ error: "invalid_peer" });
      const targetSocketId = socketsByPlayer.get(toPlayerId);
      if (!targetSocketId) return ack?.({ error: "peer_offline" });
      console.log("ArenaP2P signal", {
        matchId,
        fromPlayerId: socket.user.id,
        toPlayerId,
        type: cleanSignalType(payload.type),
        seq: Number(payload.seq) || 0
      });
      io.to(targetSocketId).emit("mesh:signal", {
        matchId,
        fromPlayerId: socket.user.id,
        fromSide,
        type: cleanSignalType(payload.type),
        seq: Number(payload.seq) || 0,
        data: safeObject(payload.data),
        at: Date.now()
      });
      ack?.({ ok: true });
    });

    socket.on("mesh:fallback", async (payload = {}, ack) => {
      const matchId = String(payload.matchId || "").trim();
      const state = await loadActiveMatch(matchId);
      if (!state) return ack?.({ error: "match_not_found" });
      const side = sideForUser(state, socket.user);
      if (!side) return ack?.({ error: "not_a_player" });
      const event = {
        matchId,
        side,
        reason: cleanReason(payload.reason),
        at: Date.now()
      };
      meshFallbackByMatch.set(matchId, event);
      await saveActiveMatch(state);
      io.to(`match:${matchId}`).emit("mesh:fallback", event);
      ack?.({ ok: true });
    });

    socket.on("mesh:receipt", async (payload = {}, ack) => {
      const matchId = String(payload.matchId || "").trim();
      const state = await loadActiveMatch(matchId);
      if (!state) return ack?.({ error: "match_not_found" });
      const side = sideForUser(state, socket.user);
      if (!side) return ack?.({ error: "not_a_player" });
      const receipt = sanitizeMeshReceipt(matchId, side, payload.receipt || payload);
      rememberMeshReceipt(matchId, receipt);
      await saveActiveMatch(state);
      socket.to(`match:${matchId}`).emit("mesh:receipt", receipt);
      ack?.({ ok: true });
    });

    socket.on("hive:ready", (payload = {}, ack) => {
      const node = registerHiveNode({
        socketId: socket.id,
        playerId: socket.user.id,
        handle: socket.user.handle,
        payload
      });
      socket.data.hiveRegion = node.region;
      socket.join(`hive:${node.region}`);
      const edge = publicHiveEdge(node.region);
      socket.emit("hive:edge", { edge, node, stats: hiveStats(), at: Date.now() });
      ack?.({ ok: true, edge, node, stats: hiveStats() });
    });

    socket.on("hive:edgeProbe", (payload = {}, ack) => {
      const region = cleanReason(payload.region || socket.data.hiveRegion || "global").toLowerCase().replace(/\s+/g, "-");
      ack?.({ ok: true, edge: publicHiveEdge(region), stats: hiveStats(), serverTime: Date.now(), clientTime: payload.clientTime || 0 });
    });

    socket.on("hive:snapshot", async (payload = {}, ack) => {
      const limit = Math.min(Math.max(Number(payload.limit || 30), 1), 50);
      const region = cleanReason(payload.region || socket.data.hiveRegion || "global").toLowerCase().replace(/\s+/g, "-");
      const snapshot = await cachedHiveSnapshot(`socket:leaderboard:${region}:${limit}`, async () => ({
        type: "leaderboard",
        region,
        players: await leaderboard(limit),
        rooms: publicRoomList(),
        stats: hiveStats()
      }));
      ack?.({ ok: true, snapshot });
    });

    socket.on("hive:gossip", (payload = {}, ack) => {
      const receipts = Array.isArray(payload.receipts)
        ? payload.receipts
        : payload.receipt
          ? [payload.receipt]
          : [];
      const result = rememberHiveReceipts({
        matchId: payload.matchId,
        fromPlayerId: socket.user.id,
        receipts
      });
      if (result.accepted > 0) {
        io.to(`hive:${socket.data.hiveRegion || "global"}`).emit("hive:gossip", {
          matchId: cleanId(payload.matchId, 128),
          fromPlayerId: socket.user.id,
          receipts: result.receipts,
          at: Date.now()
        });
      }
      ack?.({ ok: true, accepted: result.accepted });
    });

    socket.on("hive:receipts", (payload = {}, ack) => {
      ack?.({ ok: true, matchId: cleanId(payload.matchId, 128), receipts: hiveReceiptsForMatch(payload.matchId, payload.limit) });
    });

    socket.on("match:leave", async ({ matchId } = {}, ack) => {
      const state = await loadActiveMatch(matchId);
      if (!state) return ack?.({ error: "match_not_found" });
      if (socket.data?.spectatingMatchId === String(matchId || "").trim()) {
        removeSpectator(io, socket, matchId);
        return ack?.({ ok: true, spectator: true });
      }
      const side = sideForPlayer(state, socket.user.id);
      if (!side) {
        removeSpectator(io, socket, matchId);
        return ack?.({ ok: true, spectator: true });
      }
      const next = finishByForfeit(state, side);
      const persistedState = await storeMatchState(next);
      clearMatchClock(matchId);
      const publicState = stateWithSpectators(matchId, persistedState);
      socket.to(`match:${matchId}`).emit("match:playerLeft", {
        matchId,
        side,
        handle: state.players[side].handle,
        winner: publicState.winner,
        state: publicState,
        at: Date.now()
      });
      broadcastFriendPresence(io, state.players.south.id);
      broadcastFriendPresence(io, state.players.north.id);
      ack?.({ ok: true, state: publicState });
    });

    socket.on("match:rematchOffer", async ({ matchId } = {}, ack) => {
      pruneExpiredRematches(io);
      const state = await loadActiveMatch(matchId);
      if (!state) return ack?.({ error: "match_not_found" });
      const side = sideForUser(state, socket.user);
      if (!side) return ack?.({ error: "not_a_player" });
      if (state.status !== "finished") return ack?.({ error: "match_not_finished" });
      if (hasBotPlayer(state)) return ack?.({ error: "real_player_required" });
      const existing = rematchOffers.get(matchId);
      if (existing && sameRematchRecipient(existing, socket.user)) {
        try {
          const nextState = await acceptRematch(io, matchId, existing, socket.user);
          return ack?.({ ok: true, accepted: true, newMatchId: nextState.id, state: nextState });
        } catch (error) {
          return ack?.({ error: error.message });
        }
      }
      if (existing && sameRematchRequester(existing, socket.user)) return ack?.({ ok: true, pending: true, expiresAt: existing.expiresAt });
      const toSide = opponentOf(side);
      const offer = {
        matchId,
        fromSide: side,
        toSide,
        fromPlayerId: socket.user.id,
        toPlayerId: state.players[toSide].id,
        fromHandle: socket.user.handle || state.players[side].handle,
        toHandle: state.players[toSide].handle,
        expiresAt: Date.now() + REMATCH_TTL_MS
      };
      rematchOffers.set(matchId, offer);
      saveRematchInboxOffer(offer);
      emitRematchOffer(io, socket, offer);
      ack?.({ ok: true, pending: true, expiresAt: offer.expiresAt });
    });

    socket.on("match:rematchRespond", async ({ matchId, accepted } = {}, ack) => {
      pruneExpiredRematches(io);
      const offer = rematchOffers.get(matchId);
      if (!offer) return ack?.({ error: "rematch_offer_not_found" });
      if (!sameRematchRecipient(offer, socket.user)) return ack?.({ error: "not_rematch_recipient" });
      if (!accepted) {
        rematchOffers.delete(matchId);
        removeRematchInboxOffer(offer);
        const requesterSocketId = socketsByPlayer.get(offer.fromPlayerId);
        if (requesterSocketId) io.to(requesterSocketId).emit("match:rematchRejected", { matchId, byHandle: socket.user.handle, at: Date.now() });
        return ack?.({ ok: true, accepted: false });
      }
      try {
        const nextState = await acceptRematch(io, matchId, offer, socket.user);
        ack?.({ ok: true, accepted: true, newMatchId: nextState.id, state: nextState });
      } catch (error) {
        ack?.({ error: error.message });
      }
    });

    socket.on("chat:send", ({ room = "global", message }, ack) => {
      const clean = String(message || "").slice(0, 240).trim();
      if (!clean) return ack?.({ error: "empty" });
      io.to(room).emit("chat:message", { room, from: socket.user.handle, message: clean, at: Date.now() });
      ack?.({ ok: true });
    });

    socket.on("match:chat", async ({ matchId, message, clientId } = {}, ack) => {
      const normalizedMatchId = String(matchId || "").trim();
      const state = await loadActiveMatch(normalizedMatchId);
      if (!state) return ack?.({ error: "match_not_found" });
      const side = sideForPlayer(state, socket.user.id);
      if (!side) return ack?.({ error: "not_a_player" });
      const clean = String(message || "").replace(/\s+/g, " ").trim().slice(0, 160);
      if (!clean) return ack?.({ error: "empty_message" });
      const safeClientId = cleanId(clientId, 96);
      const payload = {
        id: safeClientId || `mc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        matchId: normalizedMatchId,
        fromId: socket.user.id,
        fromHandle: socket.user.handle || state.players[side].handle,
        side,
        message: clean,
        createdAt: Date.now()
      };
      io.to(`match:${normalizedMatchId}`).emit("match:chat", payload);
      ack?.({ ok: true, message: payload });
    });

    socket.on("disconnect", async () => {
      await cancelQueuedTicket(matchmaker, socket.user.id);
      removeSpectator(io, socket, socket.data?.spectatingMatchId);
      unregisterHiveSocket(socket.id);
      notifyPlayerDisconnected(socket);
      removeHostedRooms(io, socket.user.id);
      if (socketsByPlayer.get(socket.user.id) === socket.id) socketsByPlayer.delete(socket.user.id);
      socket.broadcast.emit("presence:offline", { playerId: socket.user.id, at: Date.now() });
      broadcastFriendPresence(io, socket.user.id);
    });
  });

  return io;
}

function normalizeRoomCode(code) {
  return String(code || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
}

function createRoomCode() {
  let code = "";
  do {
    code = Math.random().toString(36).slice(2, 8).toUpperCase();
  } while (customRooms.has(code));
  return code;
}

function playerFromSocket(socket, payload = {}, profile = {}) {
  return {
    id: socket.user.id,
    handle: profile.handle || socket.user.handle,
    avatarUrl: profile.avatarUrl || null,
    ballSkin: normalizeBallSkin(payload.ballSkin)
  };
}

function normalizedRating(value) {
  const rating = Number(value);
  return Number.isFinite(rating) ? Math.max(0, Math.round(rating)) : 100;
}

async function cancelQueuedTicket(matchmaker, playerId) {
  const ticket = queuedTicketsByPlayer.get(playerId);
  if (!ticket) return;
  queuedTicketsByPlayer.delete(playerId);
  await matchmaker.cancel(ticket);
}

function publicPlayer(player) {
  return {
    id: player.id,
    handle: player.handle,
    avatarUrl: player.avatarUrl || null,
    ballSkin: normalizeBallSkin(player.ballSkin)
  };
}

function installMeshForMatch(state, ticket = {}) {
  const mesh = createMeshConfig(state, ticket);
  meshConfigByMatch.set(state.id, mesh);
  meshReceiptsByMatch.set(state.id, []);
  meshChainsByMatch.set(state.id, { south: "genesis", north: "genesis" });
  meshFallbackByMatch.delete(state.id);
  return mesh;
}

function activeMeshConfig(matchId) {
  const mesh = meshConfigByMatch.get(matchId);
  if (!mesh) return null;
  const fallback = meshFallbackByMatch.get(matchId);
  return {
    ...mesh,
    ...iceCapabilities(matchId),
    fallbackActive: Boolean(fallback),
    fallbackReason: fallback?.reason || "",
    fallbackAt: fallback?.at || 0
  };
}

function activeMatchKey(matchId) {
  return `blockshift:active-match:${String(matchId || "").trim()}`;
}

async function saveActiveMatch(state, options = {}) {
  if (!state?.id) return state;
  matches.set(state.id, state);
  if (!activeMatchRedis) return state;
  const immediate = Boolean(options.immediate) || state.status !== "active" || ACTIVE_MATCH_CACHE_FLUSH_MS <= 0;
  if (!immediate) {
    pendingActiveMatchCacheSaves.set(state.id, state);
    if (!activeMatchCacheTimers.has(state.id)) {
      const timer = setTimeout(() => {
        activeMatchCacheTimers.delete(state.id);
        flushActiveMatchCache(state.id).catch((error) => {
          console.warn("active match cache flush failed", { matchId: state.id, error: error.message });
        });
      }, ACTIVE_MATCH_CACHE_FLUSH_MS);
      timer.unref?.();
      activeMatchCacheTimers.set(state.id, timer);
    }
    return state;
  }
  clearActiveMatchCacheTimer(state.id);
  pendingActiveMatchCacheSaves.delete(state.id);
  await writeActiveMatchCache(state);
  return state;
}

async function flushActiveMatchCache(matchId) {
  const normalized = String(matchId || "").trim();
  if (!normalized || !activeMatchRedis) return null;
  const state = pendingActiveMatchCacheSaves.get(normalized);
  if (!state) return null;
  pendingActiveMatchCacheSaves.delete(normalized);
  await writeActiveMatchCache(state);
  return state;
}

async function writeActiveMatchCache(state) {
  if (!state?.id || !activeMatchRedis) return state;
  const document = {
    state,
    mesh: meshConfigByMatch.get(state.id) || null,
    fallback: meshFallbackByMatch.get(state.id) || null,
    receipts: (meshReceiptsByMatch.get(state.id) || []).slice(-MESH_RECEIPT_WINDOW),
    chains: meshChainsByMatch.get(state.id) || null,
    savedAt: Date.now()
  };
  try {
    await activeMatchRedis.set(activeMatchKey(state.id), JSON.stringify(document), "EX", ACTIVE_MATCH_TTL_SECONDS);
  } catch (error) {
    console.warn("active match cache save failed", { matchId: state.id, error: error.message });
  }
  return state;
}

function clearActiveMatchCacheTimer(matchId) {
  const normalized = String(matchId || "").trim();
  const timer = activeMatchCacheTimers.get(normalized);
  if (timer) clearTimeout(timer);
  activeMatchCacheTimers.delete(normalized);
}

async function storeMatchState(state) {
  if (!state?.id) return state;
  const shouldPersist = state.status && state.status !== "active";
  const storedState = shouldPersist ? await persistMatch(state) : state;
  await saveActiveMatch(storedState, { immediate: shouldPersist });
  if (shouldPersist) spectatorStateLastSentAt.delete(storedState.id);
  return storedState;
}

async function loadActiveMatch(matchId) {
  const normalized = String(matchId || "").trim();
  if (!normalized) return null;
  const memoryState = matches.get(normalized);
  if (memoryState) return memoryState;
  if (!activeMatchRedis) return null;
  try {
    const raw = await activeMatchRedis.get(activeMatchKey(normalized));
    if (!raw) return null;
    const document = JSON.parse(raw);
    const state = document?.state;
    if (!state?.id) return null;
    matches.set(state.id, state);
    if (document.mesh) meshConfigByMatch.set(state.id, document.mesh);
    if (document.fallback) meshFallbackByMatch.set(state.id, document.fallback);
    if (Array.isArray(document.receipts)) meshReceiptsByMatch.set(state.id, document.receipts.slice(-MESH_RECEIPT_WINDOW));
    if (document.chains && typeof document.chains === "object") meshChainsByMatch.set(state.id, document.chains);
    return state;
  } catch (error) {
    console.warn("active match cache load failed", { matchId: normalized, error: error.message });
    return null;
  }
}

function createMeshConfig(state, ticket = {}) {
  const botMatch = hasBotPlayer(state);
  const mode = String(ticket.mode || state.mode || "casual").toLowerCase();
  const enabled = !botMatch && ["ranked", "casual", "custom", "customroom", "challenge", "friendchallenge"].includes(mode);
  const preferred = enabled;
  const matchSeed = sha256(`${state.id}:${state.createdAt || Date.now()}`).slice(0, 24);
  const hostSide = stableHostSide(state);
  const ice = iceCapabilities(state.id);
  return {
    version: 1,
    enabled,
    preferred,
    mode: enabled ? "arenamesh" : "server-authoritative",
    transport: "webrtc-datachannel",
    signaling: true,
    signalingRoom: `mesh:${state.id}`,
    serverFallback: true,
    fallbackActive: false,
    receiptRequired: Boolean(state.ranked),
    quickGameReady: !state.ranked,
    matchSeed,
    hostSide,
    hostPlayerId: state.players[hostSide].id,
    ...ice,
    peers: ["south", "north"].map((side) => ({
      side,
      id: state.players[side].id,
      handle: state.players[side].handle,
      avatarUrl: state.players[side].avatarUrl || null,
      ballSkin: normalizeBallSkin(state.players[side].ballSkin)
    }))
  };
}

function iceCapabilities(matchId = "") {
  const iceServers = buildIceServers(matchId);
  const turnEnabled = iceServers.some((server) => server.urls.some((url) => /^turns?:/i.test(url)));
  const relayOnly = envFlag("P2P_RELAY_ONLY", false) && turnEnabled;
  return {
    iceServers,
    turnEnabled,
    relayOnly,
    iceTransportPolicy: relayOnly ? "relay" : "all",
    relayMode: relayOnly ? "turn-only" : turnEnabled ? "stun-turn" : "stun"
  };
}

function envFlag(name, defaultValue = false) {
  const value = process.env[name];
  if (value == null || value === "") return defaultValue;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function buildIceServers(matchId = "") {
  const stunUrls = splitEnvList(process.env.ICE_STUN_URLS).map(normalizeIceUrl).filter(Boolean);
  const servers = (stunUrls.length ? stunUrls : DEFAULT_STUN_URLS)
    .map((url) => ({ urls: [url] }));
  const turnUrls = splitEnvList(process.env.TURN_URLS).map(normalizeIceUrl).filter(Boolean);
  if (!turnUrls.length) return servers;

  const turnCredentials = buildTurnCredentials(matchId);
  if (turnCredentials || process.env.TURN_ALLOW_ANONYMOUS === "true") {
    servers.push({
      urls: turnUrls,
      ...(turnCredentials || {})
    });
  } else if (process.env.NODE_ENV !== "test") {
    console.warn("TURN_URLS configured without TURN credentials; TURN relay candidates were not advertised");
  }
  return servers;
}

function buildTurnCredentials(matchId = "") {
  const secret = String(process.env.TURN_STATIC_AUTH_SECRET || "").trim();
  if (secret) {
    const ttl = Math.max(300, Number(process.env.TURN_TTL_SECONDS || 3600));
    const expiresAt = Math.floor(Date.now() / 1000) + ttl;
    const matchToken = cleanId(matchId, 48) || "match";
    const username = `${expiresAt}:blockshift-${matchToken}`;
    const credential = crypto.createHmac("sha1", secret).update(username).digest("base64");
    return { username, credential, credentialType: "password", ttlSeconds: ttl };
  }
  const username = String(process.env.TURN_USERNAME || "").trim();
  const credential = String(process.env.TURN_CREDENTIAL || "").trim();
  return username && credential ? { username, credential, credentialType: "password" } : null;
}

function splitEnvList(value) {
  return String(value || "")
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function isAllowedIceUrl(url) {
  return /^(stun|turn|turns):/i.test(String(url || "").trim());
}

function normalizeIceUrl(url) {
  const text = String(url || "").trim();
  if (!isAllowedIceUrl(text)) return "";
  if (/\s/.test(text)) return "";
  if (/(ICE_STUN_URLS|TURN_URLS|TURN_USERNAME|TURN_CREDENTIAL|TURN_STATIC_AUTH_SECRET|TURN_TTL_SECONDS)=/i.test(text)) return "";
  return text;
}

function redactedMeshConfig(mesh) {
  if (!mesh) return mesh;
  return {
    ...mesh,
    iceServers: Array.isArray(mesh.iceServers)
      ? mesh.iceServers.map((server) => ({
          urls: server.urls,
          username: server.username ? "[configured]" : undefined,
          credential: server.credential ? "[redacted]" : undefined
        }))
      : []
  };
}

function stableHostSide(state) {
  const south = state.players.south.id || state.players.south.handle || "south";
  const north = state.players.north.id || state.players.north.handle || "north";
  return south.localeCompare(north) <= 0 ? "south" : "north";
}

function verifyMeshEnvelope(state, side, action, clientSeq, meshEnvelope = {}) {
  const matchId = state.id;
  const envelope = safeObject(meshEnvelope);
  const envelopeProvided = Object.keys(envelope).length > 0;
  const chain = meshChainsByMatch.get(matchId) || { south: "genesis", north: "genesis" };
  const previousHash = cleanHash(envelope.previousHash) || chain[side] || "genesis";
  const expectedActionHash = meshActionHash(matchId, side, clientSeq, action, previousHash);
  const providedActionHash = cleanHash(envelope.actionHash);
  const actionHash = providedActionHash || expectedActionHash;
  const expectedChainHash = sha256(`${previousHash}|${actionHash}|${matchId}|${side}|${state.replay.length + 1}`);
  const providedChainHash = cleanHash(envelope.chainHash);
  const required = Boolean(state.ranked) && !hasBotPlayer(state);
  const verified = envelopeProvided
    ? providedActionHash === expectedActionHash && (!providedChainHash || providedChainHash === expectedChainHash)
    : !required;
  return {
    matchId,
    side,
    playerId: state.players[side].id,
    clientSeq: Number(clientSeq) || 0,
    serverSeq: state.replay.length + 1,
    previousHash,
    actionHash,
    expectedActionHash,
    chainHash: providedChainHash || expectedChainHash,
    stateHash: cleanHash(envelope.stateHash),
    nodeId: cleanId(envelope.nodeId, 96),
    required,
    verified,
    receivedAt: Date.now()
  };
}

function stateWithMeshReceipt(state, receipt) {
  const next = structuredClone(state);
  const existing = next.arenaHive && typeof next.arenaHive === "object" ? next.arenaHive : {};
  const chains = {
    south: existing.chains?.south || "genesis",
    north: existing.chains?.north || "genesis"
  };
  chains[receipt.side] = receipt.chainHash;
  next.arenaHive = {
    version: 1,
    mode: activeMeshConfig(state.id)?.mode || "server-authoritative",
    receipts: [...(Array.isArray(existing.receipts) ? existing.receipts : []), receipt].slice(-MESH_RECEIPT_WINDOW),
    chains,
    lastVerifiedSeq: receipt.verified ? receipt.serverSeq : Number(existing.lastVerifiedSeq || 0),
    updatedAt: Date.now()
  };
  return next;
}

function commitMeshReceipt(matchId, receipt, persistedState) {
  if (!receipt) return;
  receipt.serverSeq = persistedState.replay.length;
  receipt.status = persistedState.status;
  rememberMeshReceipt(matchId, receipt);
  const chain = meshChainsByMatch.get(matchId) || { south: "genesis", north: "genesis" };
  chain[receipt.side] = receipt.chainHash;
  meshChainsByMatch.set(matchId, chain);
}

function sanitizeMeshReceipt(matchId, side, receipt = {}) {
  const clean = safeObject(receipt);
  return {
    matchId,
    side,
    playerId: cleanId(clean.playerId, 128),
    clientSeq: Number(clean.clientSeq) || 0,
    serverSeq: Number(clean.serverSeq) || 0,
    previousHash: cleanHash(clean.previousHash),
    actionHash: cleanHash(clean.actionHash),
    chainHash: cleanHash(clean.chainHash),
    stateHash: cleanHash(clean.stateHash),
    verified: Boolean(clean.verified),
    receivedAt: Number(clean.receivedAt) || Date.now()
  };
}

function rememberMeshReceipt(matchId, receipt) {
  if (!meshReceiptsByMatch.has(matchId)) meshReceiptsByMatch.set(matchId, []);
  const receipts = meshReceiptsByMatch.get(matchId);
  receipts.push(receipt);
  if (receipts.length > MESH_RECEIPT_WINDOW) receipts.splice(0, receipts.length - MESH_RECEIPT_WINDOW);
}

function meshActionHash(matchId, side, clientSeq, action = {}, previousHash = "genesis") {
  const orientation = action.orientation || "";
  return sha256(`${matchId}|${side}|${Number(clientSeq) || 0}|${action.type || ""}|${Number(action.row) || 0}|${Number(action.col) || 0}|${orientation}|${previousHash}`);
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function cleanHash(value) {
  const text = String(value || "").trim().toLowerCase();
  if (text === "genesis") return "genesis";
  return /^[a-f0-9]{64}$/.test(text) ? text : "";
}

function cleanId(value, maxLength = 96) {
  return String(value || "").trim().replace(/[^\w:.-]/g, "").slice(0, maxLength);
}

function cleanReason(value) {
  return String(value || "mesh_fallback").trim().replace(/[^\w .:-]/g, "").slice(0, 120) || "mesh_fallback";
}

function cleanSignalType(value) {
  const type = String(value || "data").trim().toLowerCase();
  return ["offer", "answer", "ice", "hello", "data", "renegotiate"].includes(type) ? type : "data";
}

function safeObject(value, maxLength = 8192) {
  if (!value || typeof value !== "object") return {};
  try {
    return JSON.parse(JSON.stringify(value).slice(0, maxLength));
  } catch {
    return {};
  }
}

function sideForPlayer(state, playerId) {
  return state.players.south.id === playerId ? "south" : state.players.north.id === playerId ? "north" : null;
}

function sideForHandle(state, handle) {
  const normalized = normalizedHandle(handle);
  if (!normalized) return null;
  if (normalizedHandle(state.players.south.handle) === normalized) return "south";
  if (normalizedHandle(state.players.north.handle) === normalized) return "north";
  return null;
}

function sideForUser(state, user) {
  return sideForPlayer(state, user.id) || sideForHandle(state, user.handle);
}

function normalizedHandle(handle) {
  return String(handle || "").trim().toLowerCase();
}

function finishByForfeit(state, side) {
  if (state.status !== "active") return state;
  const next = structuredClone(state);
  next.status = "finished";
  next.winner = opponentOf(side);
  next.leaveReason = "forfeit";
  next.leftSide = side;
  next.endedAt = Date.now();
  return next;
}

function scheduleMatchClock(io, matchId) {
  clearMatchClock(matchId);
  const state = matches.get(matchId);
  if (!state || state.status !== "active") return;
  const delayMs = Math.max(1, remainingClockMs(state, state.turn, Date.now()) + 30);
  const timer = setTimeout(() => {
    settleClockTimeout(io, matchId).catch((error) => {
      console.error("clock timeout failed", error);
    });
  }, delayMs);
  timer.unref?.();
  matchClockTimers.set(matchId, timer);
}

function clearMatchClock(matchId) {
  const timer = matchClockTimers.get(matchId);
  if (timer) clearTimeout(timer);
  matchClockTimers.delete(matchId);
}

async function settleClockTimeout(io, matchId, now = Date.now()) {
  const state = await loadActiveMatch(matchId);
  if (!state || state.status !== "active") return state || null;
  const next = finishByClockTimeout(state, state.turn, now);
  if (next.status === "active") {
    scheduleMatchClock(io, matchId);
    return state;
  }
  const persistedState = await storeMatchState(next);
  clearMatchClock(matchId);
  const publicState = stateWithSpectators(matchId, persistedState);
  io.to(`match:${matchId}`).emit(next.status === "abandoned" ? "match:abandoned" : "match:clockExpired", {
    matchId,
    side: next.timeoutSide,
    winner: next.winner,
    state: publicState,
    at: now
  });
  emitMatchState(io, matchId, { matchId, state: publicState, mesh: activeMeshConfig(matchId), timeout: true }, persistedState, { forceSpectators: true });
  broadcastFriendPresence(io, persistedState.players.south.id);
  broadcastFriendPresence(io, persistedState.players.north.id);
  return persistedState;
}

function notifyPlayerDisconnected(socket) {
  for (const [matchId, state] of matches) {
    if (state.status !== "active") continue;
    const side = sideForPlayer(state, socket.user.id);
    if (!side) continue;
    socket.to(`match:${matchId}`).emit("match:playerDisconnected", {
      matchId,
      side,
      handle: state.players[side].handle,
      at: Date.now()
    });
  }
}

function hasBotPlayer(state) {
  return state.players.south.id.startsWith("bot_") || state.players.north.id.startsWith("bot_");
}

async function acceptRematch(io, matchId, offer, acceptingUser = null) {
  const state = await loadActiveMatch(matchId);
  if (!state) throw new Error("match_not_found");
  rematchOffers.delete(matchId);
  removeRematchInboxOffer(offer);
  const ticket = { mode: state.mode, ranked: state.ranked };
  const playersBySide = {
    north: { ...state.players.north },
    south: { ...state.players.south }
  };
  playersBySide[offer.fromSide] = {
    ...playersBySide[offer.fromSide],
    id: offer.fromPlayerId,
    handle: offer.fromHandle || playersBySide[offer.fromSide].handle
  };
  if (acceptingUser) {
    playersBySide[offer.toSide] = {
      ...playersBySide[offer.toSide],
      id: acceptingUser.id,
      handle: acceptingUser.handle || playersBySide[offer.toSide].handle
    };
  }
  const nextState = startMatch(io, ticket, [playersBySide.north, playersBySide.south]);
  const payload = { matchId, newMatchId: nextState.id, state: nextState, mesh: activeMeshConfig(nextState.id), acceptedBy: offer.toSide, at: Date.now() };
  io.to(`match:${matchId}`).emit("match:rematchAccepted", payload);
  return nextState;
}

function pruneExpiredRematches(io) {
  const now = Date.now();
  for (const [matchId, offer] of rematchOffers) {
    if (offer.expiresAt > now) continue;
    rematchOffers.delete(matchId);
    removeRematchInboxOffer(offer);
    const requesterSocketId = socketsByPlayer.get(offer.fromPlayerId);
    if (requesterSocketId) io.to(requesterSocketId).emit("match:rematchExpired", { matchId, at: now });
  }
}

function saveRematchInboxOffer(offer) {
  saveInboxOffer(rematchInboxByPlayer, offer.toPlayerId, offer);
  saveInboxOffer(rematchInboxByHandle, normalizedHandle(offer.toHandle), offer);
}

function removeRematchInboxOffer(offer) {
  removeInboxOffer(rematchInboxByPlayer, offer.toPlayerId, offer.matchId);
  removeInboxOffer(rematchInboxByHandle, normalizedHandle(offer.toHandle), offer.matchId);
}

function saveInboxOffer(inboxes, key, offer) {
  if (!key) return;
  const inbox = inboxes.get(key) || new Map();
  inbox.set(offer.matchId, offer);
  inboxes.set(key, inbox);
}

function removeInboxOffer(inboxes, key, matchId) {
  if (!key) return;
  const inbox = inboxes.get(key);
  if (!inbox) return;
  inbox.delete(matchId);
  if (inbox.size === 0) inboxes.delete(key);
}

function pendingRematchOffersFor(playerId, handle) {
  const offers = new Map();
  for (const offer of rematchInboxByPlayer.get(playerId)?.values() || []) {
    offers.set(offer.matchId, offer);
  }
  for (const offer of rematchInboxByHandle.get(normalizedHandle(handle))?.values() || []) {
    offers.set(offer.matchId, offer);
  }
  return [...offers.values()];
}

function deliverPendingRematches(io, playerId, handle) {
  const socketId = socketsByPlayer.get(playerId);
  if (!socketId) return;
  for (const offer of pendingRematchOffersFor(playerId, handle)) {
    const payload = rematchOfferPayload(offer);
    io.to(socketId).emit("notification:rematchOffer", payload);
    io.to(socketId).emit("rematch:offer", payload);
  }
}

function emitRematchOffer(io, socket, offer) {
  const payload = rematchOfferPayload(offer);
  socket.to(`match:${offer.matchId}`).emit("match:rematchOffer", payload);
  const targetSocketId = socketIdForRematchRecipient(io, offer);
  const targetSocket = targetSocketId ? io.sockets.sockets.get(targetSocketId) : null;
  if (!targetSocket) return;
  io.to(targetSocketId).emit("notification:rematchOffer", payload);
  io.to(targetSocketId).emit("rematch:offer", payload);
  if (!targetSocket.rooms.has(`match:${offer.matchId}`)) {
    io.to(targetSocketId).emit("match:rematchOffer", payload);
  }
}

function socketIdForRematchRecipient(io, offer) {
  const directSocketId = socketsByPlayer.get(offer.toPlayerId);
  if (directSocketId) return directSocketId;
  const targetHandle = normalizedHandle(offer.toHandle);
  if (!targetHandle) return null;
  for (const socketId of socketsByPlayer.values()) {
    const candidate = io.sockets.sockets.get(socketId);
    if (normalizedHandle(candidate?.user?.handle) === targetHandle) return socketId;
  }
  return null;
}

function sameRematchRequester(offer, user) {
  return offer.fromPlayerId === user.id || sameHandle(offer.fromHandle, user.handle);
}

function sameRematchRecipient(offer, user) {
  return offer.toPlayerId === user.id || sameHandle(offer.toHandle, user.handle);
}

function sameHandle(left, right) {
  const normalizedLeft = normalizedHandle(left);
  return normalizedLeft.length > 0 && normalizedLeft === normalizedHandle(right);
}

function rematchOfferPayload(offer) {
  return {
    matchId: offer.matchId,
    fromSide: offer.fromSide,
    toSide: offer.toSide,
    fromPlayerId: offer.fromPlayerId,
    toPlayerId: offer.toPlayerId,
    fromHandle: offer.fromHandle,
    toHandle: offer.toHandle,
    expiresAt: offer.expiresAt
  };
}

function friendshipKey(leftId, rightId) {
  return [String(leftId || ""), String(rightId || "")].sort().join("|");
}

function areFriends(leftId, rightId) {
  return friendships.has(friendshipKey(leftId, rightId));
}

function existingFriendRequest(user, target) {
  for (const request of friendRequests.values()) {
    const sameDirection = (request.fromId === user.id || sameHandle(request.fromHandle, user.handle)) &&
      (request.toId === target.id || sameHandle(request.toHandle, target.handle));
    const reverseDirection = (request.toId === user.id || sameHandle(request.toHandle, user.handle)) &&
      (request.fromId === target.id || sameHandle(request.fromHandle, target.handle));
    if (sameDirection || reverseDirection) return request;
  }
  return null;
}

function sameFriendRecipient(request, user) {
  return request.toId === user.id || sameHandle(request.toHandle, user.handle);
}

function sameFriendRequester(request, user) {
  return request.fromId === user.id || sameHandle(request.fromHandle, user.handle);
}

function publicFriendRequest(request, user = null) {
  const outgoing = user ? sameFriendRequester(request, user) : false;
  return {
    id: request.id,
    fromId: request.fromId,
    fromHandle: request.fromHandle,
    toId: request.toId,
    toHandle: request.toHandle,
    outgoing,
    direction: outgoing ? "sent" : "incoming",
    createdAt: request.createdAt
  };
}

function publicFriendRequestsFor(user) {
  return [...friendRequests.values()]
    .filter((request) => sameFriendRecipient(request, user) || sameFriendRequester(request, user))
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((request) => publicFriendRequest(request, user));
}

function publicIncomingFriendRequestsFor(user) {
  return [...friendRequests.values()]
    .filter((request) => sameFriendRecipient(request, user))
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((request) => publicFriendRequest(request, user));
}

async function publicFriendList(user) {
  const entries = [...friendships.values()].filter((friendship) => friendshipIncludesUser(friendship, user));
  const friends = await Promise.all(entries.map(async (friendship) => {
    const userIsA = friendship.aId === user.id || sameHandle(friendship.aHandle, user.handle);
    const friendId = userIsA ? friendship.bId : friendship.aId;
    const fallbackHandle = userIsA ? friendship.bHandle : friendship.aHandle;
    const profile = await findProfile(friendId).catch(() => null);
    const matchId = activeMatchIdForPlayer(friendId);
    const matchmaking = queuedTicketsByPlayer.has(friendId);
    const online = socketsByPlayer.has(friendId);
    return {
      id: friendId,
      handle: profile?.handle || fallbackHandle || "Friend",
      rating: profile?.rating ?? 100,
      avatarUrl: profile?.avatarUrl || null,
      country: profile?.country || "GLOBAL",
      online,
      status: matchId ? "In match" : matchmaking ? "Matchmaking" : online ? "Online" : "Offline",
      matchId,
      matchmaking,
      since: friendship.createdAt
    };
  }));
  return friends.sort((a, b) => Number(b.online) - Number(a.online) || a.handle.localeCompare(b.handle));
}

async function resolveFriendTarget(payload = {}) {
  const lookups = [
    payload.friendId,
    payload.targetId,
    payload.toId,
    payload.friendHandle,
    payload.targetHandle,
    payload.handle
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  for (const lookup of [...new Set(lookups)]) {
    const profile = await findProfile(lookup).catch(() => null);
    if (profile) return profile;
  }
  return null;
}

function friendshipIncludesUser(friendship, user) {
  return friendship.aId === user.id || friendship.bId === user.id ||
    sameHandle(friendship.aHandle, user.handle) || sameHandle(friendship.bHandle, user.handle);
}

function friendshipEntryForPayload(user, payload = {}, target = null) {
  const targetIds = new Set(
    [target?.id, payload.friendId, payload.targetId, payload.toId]
      .map((value) => String(value || "").trim())
      .filter(Boolean)
  );
  const targetHandles = [target?.handle, payload.friendHandle, payload.targetHandle, payload.handle]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  for (const [key, friendship] of friendships) {
    if (!friendshipIncludesUser(friendship, user)) continue;
    const idMatch = targetIds.has(friendship.aId) || targetIds.has(friendship.bId);
    const handleMatch = targetHandles.some((handle) => sameHandle(friendship.aHandle, handle) || sameHandle(friendship.bHandle, handle));
    if (idMatch || handleMatch) return { key, friendship };
  }
  return null;
}

function otherFriendId(friendship, user) {
  const userIsA = friendship.aId === user.id || sameHandle(friendship.aHandle, user.handle);
  return userIsA ? friendship.bId : friendship.aId;
}

function otherFriendHandle(friendship, user) {
  const userIsA = friendship.aId === user.id || sameHandle(friendship.aHandle, user.handle);
  return userIsA ? friendship.bHandle : friendship.aHandle;
}

function friendThreadKey(leftId, rightId) {
  return [leftId, rightId].sort().join(":");
}

function appendFriendMessage(message) {
  const key = friendThreadKey(message.fromId, message.toId);
  const messages = friendMessages.get(key) || [];
  messages.push(message);
  friendMessages.set(key, messages.slice(-80));
}

function publicFriendMessages(userId, friendId) {
  const key = friendThreadKey(userId, friendId);
  return (friendMessages.get(key) || []).slice(-50).map(publicFriendMessage);
}

function publicFriendMessage(message) {
  return {
    id: message.id,
    fromId: message.fromId,
    fromHandle: message.fromHandle,
    toId: message.toId,
    toHandle: message.toHandle,
    message: message.message,
    createdAt: message.createdAt
  };
}

async function emitSocialSnapshot(io, socket) {
  socket.emit("friends:updated", {
    friends: await publicFriendList(socket.user),
    requests: publicFriendRequestsFor(socket.user)
  });
}

async function emitSocialSnapshotToPlayer(io, playerId) {
  const socketId = socketsByPlayer.get(playerId);
  if (!socketId) return;
  const socket = io.sockets.sockets.get(socketId);
  if (!socket) return;
  await emitSocialSnapshot(io, socket);
}

async function broadcastFriendPresence(io, playerId) {
  for (const friendship of friendships.values()) {
    if (friendship.aId === playerId) await emitSocialSnapshotToPlayer(io, friendship.bId);
    if (friendship.bId === playerId) await emitSocialSnapshotToPlayer(io, friendship.aId);
  }
}

function emitFriendRequest(io, request) {
  const targetSocketId = socketsByPlayer.get(request.toId) || socketIdForHandle(io, request.toHandle);
  if (!targetSocketId) return;
  const payload = publicFriendRequest(request, { id: request.toId, handle: request.toHandle });
  io.to(targetSocketId).emit("notification:friendRequest", payload);
  io.to(targetSocketId).emit("friends:request", payload);
  emitSocialSnapshotToPlayer(io, request.toId);
}

function socketIdForHandle(io, handle) {
  const targetHandle = normalizedHandle(handle);
  if (!targetHandle) return null;
  for (const socketId of socketsByPlayer.values()) {
    const candidate = io.sockets.sockets.get(socketId);
    if (normalizedHandle(candidate?.user?.handle) === targetHandle) return socketId;
  }
  return null;
}

function emitFriendAccepted(io, request, acceptingUser) {
  const requesterSocketId = socketsByPlayer.get(request.fromId);
  if (requesterSocketId) {
    io.to(requesterSocketId).emit("friends:accepted", {
      requestId: request.id,
      friendId: acceptingUser.id,
      friendHandle: acceptingUser.handle || request.toHandle,
      at: Date.now()
    });
  }
}

function emitFriendRejected(io, request, rejectingUser) {
  const requesterSocketId = socketsByPlayer.get(request.fromId);
  if (requesterSocketId) {
    io.to(requesterSocketId).emit("friends:rejected", {
      requestId: request.id,
      friendId: rejectingUser.id,
      friendHandle: rejectingUser.handle || request.toHandle,
      at: Date.now()
    });
  }
}

function deliverPendingFriendRequests(io, socket) {
  for (const request of publicIncomingFriendRequestsFor(socket.user)) {
    io.to(socket.id).emit("notification:friendRequest", request);
    io.to(socket.id).emit("friends:request", request);
  }
}

function publicFriendChallenge(offer) {
  return {
    id: offer.id,
    fromId: offer.fromId,
    fromHandle: offer.fromHandle,
    toId: offer.toId,
    toHandle: offer.toHandle,
    responseMs: offer.responseMs || Math.max(0, offer.expiresAt - Date.now()),
    rejectCount: offer.rejectCount || 0,
    expiresAt: offer.expiresAt
  };
}

function deliverPendingFriendChallenges(io, socket) {
  pruneExpiredFriendChallenges(io);
  for (const offer of friendChallenges.values()) {
    if (offer.toId !== socket.user.id && !sameHandle(offer.toHandle, socket.user.handle)) continue;
    const payload = publicFriendChallenge(offer);
    io.to(socket.id).emit("notification:friendChallenge", payload);
    io.to(socket.id).emit("friends:challenge", payload);
  }
}

function pruneExpiredFriendChallenges(io) {
  const now = Date.now();
  for (const [id, offer] of friendChallenges) {
    if (offer.expiresAt > now) continue;
    expireFriendChallenge(io, id, now);
  }
}

function scheduleFriendChallengeExpiry(io, offer) {
  clearFriendChallengeTimer(offer.id);
  const delay = Math.max(1, offer.expiresAt - Date.now() + 30);
  const timer = setTimeout(() => expireFriendChallenge(io, offer.id, Date.now()), delay);
  timer.unref?.();
  friendChallengeTimers.set(offer.id, timer);
}

function clearFriendChallengeTimer(challengeId) {
  const timer = friendChallengeTimers.get(challengeId);
  if (timer) clearTimeout(timer);
  friendChallengeTimers.delete(challengeId);
}

function expireFriendChallenge(io, challengeId, now = Date.now()) {
  const offer = friendChallenges.get(challengeId);
  if (!offer || offer.expiresAt > now) return;
  friendChallenges.delete(challengeId);
  clearFriendChallengeTimer(challengeId);
  const payload = {
    challengeId,
    fromHandle: offer.fromHandle,
    toHandle: offer.toHandle,
    at: now
  };
  const requesterSocketId = socketsByPlayer.get(offer.fromId) || socketIdForHandle(io, offer.fromHandle);
  if (requesterSocketId) io.to(requesterSocketId).emit("friends:challengeExpired", payload);
  const recipientSocketId = socketsByPlayer.get(offer.toId) || socketIdForHandle(io, offer.toHandle);
  if (recipientSocketId) io.to(recipientSocketId).emit("friends:challengeExpired", payload);
}

function friendChallengePairKey(fromId, toId) {
  return `${String(fromId || "").trim()}->${String(toId || "").trim()}`;
}

function friendChallengeRejectCount(fromId, toId) {
  return friendChallengeRejectCounts.get(friendChallengePairKey(fromId, toId)) || 0;
}

function incrementFriendChallengeRejectCount(fromId, toId) {
  const key = friendChallengePairKey(fromId, toId);
  const next = (friendChallengeRejectCounts.get(key) || 0) + 1;
  friendChallengeRejectCounts.set(key, next);
  return next;
}

function resetFriendChallengeRejectCount(fromId, toId) {
  friendChallengeRejectCounts.delete(friendChallengePairKey(fromId, toId));
}

function friendChallengeResponseMs(fromId, toId) {
  return friendChallengeRejectCount(fromId, toId) >= CHALLENGE_REJECT_THRESHOLD
    ? CHALLENGE_EXTENDED_RESPONSE_MS
    : CHALLENGE_RESPONSE_MS;
}

function friendChallengeRejectCooldownMs(rejectCount) {
  return rejectCount >= CHALLENGE_REJECT_THRESHOLD
    ? CHALLENGE_EXTENDED_RESPONSE_MS
    : CHALLENGE_REJECT_COOLDOWN_MS;
}

function activeMatchIdForPlayer(playerId) {
  for (const [matchId, state] of matches) {
    if (state.status !== "active") continue;
    if (state.players.south.id === playerId || state.players.north.id === playerId) return matchId;
  }
  return "";
}

function pruneExpiredRooms(io) {
  const now = Date.now();
  let changed = false;
  for (const [code, room] of customRooms) {
    if (room.expiresAt <= now) {
      customRooms.delete(code);
      io.to(`room:${code}`).emit("room:closed", { code, reason: "expired" });
      changed = true;
    }
  }
  if (changed) broadcastRoomList(io);
}

function removeHostedRooms(io, playerId) {
  let changed = false;
  for (const [code, room] of customRooms) {
    if (room.ticket.player.id === playerId) {
      customRooms.delete(code);
      io.to(`room:${code}`).emit("room:closed", { code, reason: "host_left" });
      changed = true;
    }
  }
  if (changed) broadcastRoomList(io);
}

function publicRoomList() {
  return [...customRooms.values()]
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((room) => ({
      code: room.code,
      hostId: room.ticket.player.id,
      hostHandle: room.ticket.player.handle,
      rating: room.ticket.rating,
      expiresAt: room.expiresAt,
      players: 1
    }));
}

function broadcastRoomList(io) {
  io.emit("room:listUpdated", { rooms: publicRoomList() });
}

function startMatch(io, ticket, players) {
  const state = createInitialState({ mode: ticket.mode, ranked: ticket.ranked, players });
  matches.set(state.id, state);
  const mesh = installMeshForMatch(state, ticket);
  void saveActiveMatch(state, { immediate: true });
  scheduleMatchClock(io, state.id);
  const publicState = stateWithSpectators(state.id, state);
  for (const side of ["south", "north"]) {
    const player = state.players[side];
    const socketId = socketsByPlayer.get(player.id);
    if (socketId) {
      const socket = io.sockets.sockets.get(socketId);
      socket?.join(`match:${state.id}`);
      socket?.join(playerRoom(state.id));
      io.to(socketId).emit("match:found", { matchId: state.id, side, state: publicState, mesh, legalMoves: legalMoves(state, side) });
    }
  }
  players.forEach((player) => broadcastFriendPresence(io, player.id));
  return publicState;
}

function spectatorSet(matchId) {
  const normalized = String(matchId || "").trim();
  if (!normalized) return new Set();
  if (!spectatorsByMatch.has(normalized)) spectatorsByMatch.set(normalized, new Set());
  return spectatorsByMatch.get(normalized);
}

function spectatorCount(matchId) {
  return spectatorsByMatch.get(String(matchId || "").trim())?.size || 0;
}

function stateWithSpectators(matchId, state) {
  if (!state) return state;
  return { ...state, spectatorCount: spectatorCount(matchId) };
}

function playerRoom(matchId) {
  return `match:${String(matchId || "").trim()}:players`;
}

function spectatorRoom(matchId) {
  return `match:${String(matchId || "").trim()}:spectators`;
}

function emitMatchState(io, matchId, payload, state, options = {}) {
  const normalized = String(matchId || "").trim();
  if (!normalized) return;
  io.to(playerRoom(normalized)).emit("match:state", payload);
  if (spectatorCount(normalized) <= 0) return;
  const forceSpectators = Boolean(options.forceSpectators) || state?.status !== "active";
  const now = Date.now();
  const lastSentAt = spectatorStateLastSentAt.get(normalized) || 0;
  if (!forceSpectators && now - lastSentAt < SPECTATOR_STATE_INTERVAL_MS) return;
  spectatorStateLastSentAt.set(normalized, now);
  io.to(spectatorRoom(normalized)).emit("match:state", payload);
}

function emitSpectatorCount(io, matchId) {
  const normalized = String(matchId || "").trim();
  if (!normalized) return;
  io.to(`match:${normalized}`).emit("match:spectators", {
    matchId: normalized,
    count: spectatorCount(normalized)
  });
}

function removeSpectator(io, socket, matchId) {
  const normalized = String(matchId || "").trim();
  if (!normalized) return false;
  const set = spectatorsByMatch.get(normalized);
  if (!set) return false;
  const removed = set.delete(socket.id);
  if (set.size === 0) spectatorsByMatch.delete(normalized);
  if (!removed) return false;
  socket.leave(`match:${normalized}`);
  socket.leave(spectatorRoom(normalized));
  if (socket.data?.spectatingMatchId === normalized) socket.data.spectatingMatchId = "";
  emitSpectatorCount(io, normalized);
  return true;
}
