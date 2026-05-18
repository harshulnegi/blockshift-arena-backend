export const BOARD_SIZE = 9;
export const START_WALLS = 10;
export const START_CLOCK_MS = 300000;
export const FIRST_TURN_GRACE_MS = 20000;
const BALL_SKINS = new Set(["core", "orbit", "blade", "nova"]);

export function createInitialState({ ranked = false, mode = "casual", players }) {
  const [north, south] = players;
  const openingGraceEnabled = !players.some((player) => String(player.id || "").startsWith("bot_"));
  return {
    id: cryptoRandomId(),
    mode,
    ranked,
    size: BOARD_SIZE,
    turn: "south",
    status: "active",
    winner: null,
    endReason: null,
    openingGraceEnabled,
    firstActionDone: {
      south: false,
      north: false
    },
    moveNumber: 0,
    players: {
      south: { id: south.id, handle: south.handle, avatarUrl: south.avatarUrl || null, ballSkin: normalizeBallSkin(south.ballSkin), row: 8, col: 4, walls: START_WALLS, goalRow: 0 },
      north: { id: north.id, handle: north.handle, avatarUrl: north.avatarUrl || null, ballSkin: normalizeBallSkin(north.ballSkin), row: 0, col: 4, walls: START_WALLS, goalRow: 8 }
    },
    walls: [],
    replay: [],
    arenaHive: {
      version: 1,
      receipts: [],
      chains: {
        south: "genesis",
        north: "genesis"
      }
    },
    clocks: {
      southMs: START_CLOCK_MS,
      northMs: START_CLOCK_MS,
      lastTurnAt: Date.now()
    }
  };
}

export function normalizeBallSkin(value) {
  return BALL_SKINS.has(value) ? value : "core";
}

export function legalMoves(state, side = state.turn) {
  const me = state.players[side];
  const other = state.players[opponentOf(side)];
  const moves = [];
  for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
    const next = { row: me.row + dr, col: me.col + dc };
    if (!inBounds(next) || isBlocked(state, me, next)) continue;
    if (next.row !== other.row || next.col !== other.col) {
      moves.push(next);
      continue;
    }
    const jump = { row: other.row + dr, col: other.col + dc };
    if (inBounds(jump) && !isBlocked(state, other, jump)) {
      moves.push(jump);
      continue;
    }
    for (const [sdr, sdc] of perpendicular(dr, dc)) {
      const diag = { row: other.row + sdr, col: other.col + sdc };
      if (inBounds(diag) && !isBlocked(state, other, diag)) moves.push(diag);
    }
  }
  return uniquePositions(moves);
}

export function applyAction(state, side, action, now = Date.now()) {
  if (state.status !== "active") throw new Error("match_not_active");
  const liveState = finishByClockTimeout(state, state.turn, now);
  if (liveState.status !== "active") return liveState;
  if (liveState.turn !== side) throw new Error("not_your_turn");
  const next = structuredClone(liveState);
  debitClock(next, side, now);
  if (action.type === "move") applyMove(next, side, action);
  else if (action.type === "wall") applyWall(next, side, action);
  else throw new Error("unknown_action");
  next.moveNumber += 1;
  next.replay.push({ n: next.moveNumber, side, action, at: now });
  next.firstActionDone = next.firstActionDone || { south: false, north: false };
  next.firstActionDone[side] = true;
  if (next.players[side].row === next.players[side].goalRow) {
    next.status = "finished";
    next.winner = side;
  } else {
    next.turn = opponentOf(side);
    next.clocks.lastTurnAt = now;
  }
  return next;
}

export function remainingClockMs(state, side = state.turn, now = Date.now()) {
  if (state.status !== "active") return 0;
  if (openingGraceActive(state, side)) {
    return Math.max(0, FIRST_TURN_GRACE_MS - Math.max(0, now - state.clocks.lastTurnAt));
  }
  const left = side === "south" ? state.clocks.southMs : state.clocks.northMs;
  if (state.turn !== side) return Math.max(0, left);
  return Math.max(0, left - Math.max(0, now - state.clocks.lastTurnAt));
}

export function finishByClockTimeout(state, side = state.turn, now = Date.now()) {
  if (state.status !== "active") return state;
  if (remainingClockMs(state, side, now) > 0) return state;
  const next = structuredClone(state);
  if (openingGraceActive(next, side)) {
    next.clocks.lastTurnAt = now;
    next.status = "abandoned";
    next.winner = null;
    next.timeoutSide = side;
    next.endReason = "first_turn_no_move";
    next.endedAt = now;
    return next;
  }
  if (side === "south") next.clocks.southMs = 0;
  else next.clocks.northMs = 0;
  next.clocks.lastTurnAt = now;
  next.status = "finished";
  next.winner = opponentOf(side);
  next.timeoutSide = side;
  next.endReason = "timeout";
  next.endedAt = now;
  return next;
}

export function validateAction(state, side, action) {
  applyAction(state, side, action);
  return true;
}

function applyMove(state, side, action) {
  const target = { row: action.row, col: action.col };
  if (!legalMoves(state, side).some((m) => samePosition(m, target))) throw new Error("illegal_move");
  state.players[side].row = target.row;
  state.players[side].col = target.col;
}

function applyWall(state, side, action) {
  const wall = { row: action.row, col: action.col, orientation: action.orientation };
  if (state.players[side].walls <= 0) throw new Error("no_walls_remaining");
  if (!isWallShapeValid(wall)) throw new Error("wall_out_of_bounds");
  const conflict = state.walls.find((w) => wallsConflict(w, wall));
  if (conflict) throw new Error(conflict.orientation === wall.orientation ? "wall_overlap" : "wall_crossing");
  state.walls.push(wall);
  if (!hasPathToGoal(state, "south") || !hasPathToGoal(state, "north")) {
    state.walls.pop();
    throw new Error("wall_blocks_all_paths");
  }
  state.players[side].walls -= 1;
}

export function hasPathToGoal(state, side) {
  const start = state.players[side];
  const seen = new Set([key(start)]);
  const queue = [{ row: start.row, col: start.col }];
  while (queue.length) {
    const cur = queue.shift();
    if (cur.row === start.goalRow) return true;
    for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const next = { row: cur.row + dr, col: cur.col + dc };
      if (!inBounds(next) || seen.has(key(next)) || isBlocked(state, cur, next)) continue;
      seen.add(key(next));
      queue.push(next);
    }
  }
  return false;
}

export function isBlocked(state, from, to) {
  if (from.row === to.row) {
    const c = Math.min(from.col, to.col);
    return state.walls.some((w) => w.orientation === "vertical" && w.col === c && (w.row === from.row || w.row + 1 === from.row));
  }
  if (from.col === to.col) {
    const r = Math.min(from.row, to.row);
    return state.walls.some((w) => w.orientation === "horizontal" && w.row === r && (w.col === from.col || w.col + 1 === from.col));
  }
  return false;
}

export function opponentOf(side) {
  return side === "south" ? "north" : "south";
}

function debitClock(state, side, now) {
  if (openingGraceActive(state, side)) {
    state.clocks.lastTurnAt = now;
    return;
  }
  const elapsed = Math.max(0, now - state.clocks.lastTurnAt);
  if (side === "south") state.clocks.southMs = Math.max(0, state.clocks.southMs - elapsed);
  else state.clocks.northMs = Math.max(0, state.clocks.northMs - elapsed);
}

function openingGraceActive(state, side = state.turn) {
  return Boolean(state.openingGraceEnabled) &&
    state.status === "active" &&
    state.turn === side &&
    !Boolean(state.firstActionDone?.[side]);
}

function isWallShapeValid(wall) {
  return Number.isInteger(wall.row) && Number.isInteger(wall.col) &&
    wall.row >= 0 && wall.col >= 0 && wall.row < BOARD_SIZE - 1 && wall.col < BOARD_SIZE - 1 &&
    ["horizontal", "vertical"].includes(wall.orientation);
}

function crossesWall(a, b) {
  return a.row === b.row && a.col === b.col && a.orientation !== b.orientation;
}

function sameWall(a, b) {
  return a.row === b.row && a.col === b.col && a.orientation === b.orientation;
}

function wallsConflict(a, b) {
  if (a.orientation !== b.orientation) return crossesWall(a, b);
  if (a.orientation === "horizontal") return a.row === b.row && Math.abs(a.col - b.col) < 2;
  return a.col === b.col && Math.abs(a.row - b.row) < 2;
}

function samePosition(a, b) {
  return a.row === b.row && a.col === b.col;
}

function inBounds(pos) {
  return pos.row >= 0 && pos.col >= 0 && pos.row < BOARD_SIZE && pos.col < BOARD_SIZE;
}

function perpendicular(dr, dc) {
  return dr === 0 ? [[-1, 0], [1, 0]] : [[0, -1], [0, 1]];
}

function uniquePositions(values) {
  return [...new Map(values.map((v) => [key(v), v])).values()];
}

function key(pos) {
  return `${pos.row}:${pos.col}`;
}

function cryptoRandomId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
