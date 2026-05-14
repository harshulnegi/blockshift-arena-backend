import { applyAction, BOARD_SIZE, isBlocked, legalMoves, opponentOf } from "./rules.js";

const WALL_LIMITS = {
  easy: 0,
  medium: 8,
  hard: 14,
  master: 16
};
const ROOT_LIMITS = {
  medium: 12,
  hard: 10,
  master: 12
};

export function chooseAiAction(state, side, difficulty = "medium") {
  const level = normalizeDifficulty(difficulty);
  if (level === "easy") {
    const action = chooseEasyMove(state, side);
    return { action, score: evaluateAction(state, side, action) };
  }

  const depth = level === "medium" ? 1 : 3;
  const candidates = candidateActions(state, side, level)
    .sort((a, b) => evaluateAction(state, side, b) - evaluateAction(state, side, a))
    .slice(0, ROOT_LIMITS[level] || ROOT_LIMITS.medium);
  let best = candidates[0] || chooseEasyMove(state, side);
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const action of candidates) {
    const next = tryApply(state, side, action);
    if (!next) continue;
    if (next.winner === side) return { action, score: 100000 };
    const score = minimax(next, depth - 1, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY, false, side, level) + evaluateAction(state, side, action) / 5;
    if (score > bestScore) {
      best = action;
      bestScore = score;
    }
  }
  return { action: best, score: bestScore };
}

function minimax(state, depth, alpha, beta, maximizing, side, difficulty) {
  if (depth === 0 || state.status !== "active") return evaluate(state, side);
  const actor = state.turn;
  const branchLimit = depth >= 2 ? 10 : 7;
  const scored = candidateActions(state, actor, difficulty)
    .map((action) => {
      const next = tryApply(state, actor, action);
      return next ? { action, score: evaluate(next, side) } : null;
    })
    .filter(Boolean)
    .sort((a, b) => maximizing ? b.score - a.score : a.score - b.score)
    .slice(0, branchLimit);
  const actions = scored.map((item) => item.action);
  if (!actions.length) return evaluate(state, side);
  if (maximizing) {
    let value = Number.NEGATIVE_INFINITY;
    for (const action of actions) {
      const next = tryApply(state, actor, action);
      if (!next) continue;
      value = Math.max(value, minimax(next, depth - 1, alpha, beta, false, side, difficulty));
      alpha = Math.max(alpha, value);
      if (value >= beta) break;
    }
    return value;
  }
  let value = Number.POSITIVE_INFINITY;
  for (const action of actions) {
    const next = tryApply(state, actor, action);
    if (!next) continue;
    value = Math.min(value, minimax(next, depth - 1, alpha, beta, true, side, difficulty));
    beta = Math.min(beta, value);
    if (value <= alpha) break;
  }
  return value;
}

function chooseEasyMove(state, side) {
  const me = state.players[side];
  const moves = legalMoves(state, side).sort((a, b) => {
    const goalDelta = Math.abs(me.goalRow - a.row) - Math.abs(me.goalRow - b.row);
    if (goalDelta !== 0) return goalDelta;
    return Math.abs(Math.floor(BOARD_SIZE / 2) - a.col) - Math.abs(Math.floor(BOARD_SIZE / 2) - b.col);
  });
  const index = moves.length > 1 && state.moveNumber % 4 === 2 ? 1 : 0;
  const move = moves[Math.min(index, moves.length - 1)] || { row: me.row, col: me.col };
  return { type: "move", row: move.row, col: move.col };
}

function candidateActions(state, side, difficulty) {
  const moves = legalMoves(state, side).map((m) => ({ type: "move", ...m }));
  const limit = WALL_LIMITS[difficulty] || WALL_LIMITS.medium;
  const played = state.moveNumber || state.replay?.length || 0;
  if (limit <= 0 || played === 0 || state.players[side].walls <= 0) return moves;
  return moves.concat(candidateWalls(state, side, limit));
}

function candidateWalls(state, side, limit) {
  const me = state.players[side];
  const enemy = state.players[opponentOf(side)];
  const rows = uniqueNumbers([enemy.row, enemy.row - 1, enemy.row + 1, me.row, me.row - 1, Math.floor((enemy.row + me.row) / 2)])
    .map((row) => clamp(row, 0, BOARD_SIZE - 2));
  const cols = uniqueNumbers([enemy.col, enemy.col - 1, enemy.col + 1, me.col, me.col - 1, Math.floor(BOARD_SIZE / 2)])
    .map((col) => clamp(col, 0, BOARD_SIZE - 2));
  const walls = [];
  for (const row of uniqueNumbers(rows)) {
    for (const col of uniqueNumbers(cols)) {
      for (const orientation of ["horizontal", "vertical"]) {
        const action = { type: "wall", row, col, orientation };
        if (tryApply(state, side, action)) walls.push({ action, score: wallCandidateScore(state, side, action) });
      }
    }
  }
  return walls
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((item) => item.action);
}

function evaluateAction(state, side, action) {
  const next = tryApply(state, side, action);
  if (!next) return Number.NEGATIVE_INFINITY;
  if (next.winner === side) return 100000;
  if (action.type !== "wall") return evaluate(next, side) + 16;
  const enemySlowdown = shortestPathDistance(next, opponentOf(side)) - shortestPathDistance(state, opponentOf(side));
  const selfSlowdown = shortestPathDistance(next, side) - shortestPathDistance(state, side);
  const urgentBlock = shortestPathDistance(state, opponentOf(side)) <= 2 && enemySlowdown > 0 ? 190 : 0;
  const pressure = enemySlowdown <= 0 ? -75 : enemySlowdown * 145;
  return evaluate(next, side) + pressure + urgentBlock - selfSlowdown * 60;
}

function wallCandidateScore(state, side, action) {
  const next = tryApply(state, side, action);
  if (!next) return Number.NEGATIVE_INFINITY;
  const enemy = state.players[opponentOf(side)];
  const enemySlowdown = shortestPathDistance(next, opponentOf(side)) - shortestPathDistance(state, opponentOf(side));
  const selfSlowdown = shortestPathDistance(next, side) - shortestPathDistance(state, side);
  const proximity = 12 - Math.abs(action.row - enemy.row) - Math.abs(action.col - enemy.col);
  const emergency = shortestPathDistance(state, opponentOf(side)) <= 2 && enemySlowdown > 0 ? 220 : 0;
  return enemySlowdown * 170 - selfSlowdown * 65 + proximity + emergency;
}

function evaluate(state, side) {
  if (state.winner === side) return 100000;
  if (state.winner && state.winner !== side) return -100000;
  const me = state.players[side];
  const other = state.players[opponentOf(side)];
  const myDistance = shortestPathDistance(state, side);
  const theirDistance = shortestPathDistance(state, opponentOf(side));
  const centerBonus = Math.floor(BOARD_SIZE / 2) - Math.abs(Math.floor(BOARD_SIZE / 2) - me.col);
  const goalThreat =
    myDistance <= 1 ? 850 :
    myDistance <= 2 ? 420 :
    theirDistance <= 1 ? -1050 :
    theirDistance <= 2 ? -520 :
    0;
  const turnTempo = state.turn === side ? 18 : -18;
  return (theirDistance - myDistance) * 155 + (me.walls - other.walls) * 12 + centerBonus * 6 + turnTempo + goalThreat;
}

function shortestPathDistance(state, side) {
  const start = state.players[side];
  const queue = [{ row: start.row, col: start.col, distance: 0 }];
  const seen = new Set([key(start)]);
  let cursor = 0;
  while (cursor < queue.length) {
    const cur = queue[cursor++];
    if (cur.row === start.goalRow) return cur.distance;
    for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const next = { row: cur.row + dr, col: cur.col + dc };
      if (!inBounds(next) || seen.has(key(next)) || isBlocked(state, cur, next)) continue;
      seen.add(key(next));
      queue.push({ ...next, distance: cur.distance + 1 });
    }
  }
  return 99;
}

function tryApply(state, side, action) {
  try {
    return applyAction(state, side, action, Date.now());
  } catch {
    return null;
  }
}

function normalizeDifficulty(difficulty) {
  const level = String(difficulty || "medium").toLowerCase();
  return ["easy", "medium", "hard", "master"].includes(level) ? level : "medium";
}

function uniqueNumbers(values) {
  return [...new Set(values)];
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function inBounds(pos) {
  return pos.row >= 0 && pos.col >= 0 && pos.row < BOARD_SIZE && pos.col < BOARD_SIZE;
}

function key(pos) {
  return `${pos.row}:${pos.col}`;
}
