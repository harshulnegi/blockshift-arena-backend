import test from "node:test";
import assert from "node:assert/strict";
import { chooseAiAction } from "../src/game/ai.js";
import { applyAction, createInitialState, finishByClockTimeout, FIRST_TURN_GRACE_MS, hasPathToGoal, legalMoves, START_CLOCK_MS } from "../src/game/rules.js";

function state() {
  return createInitialState({ players: [{ id: "n", handle: "North" }, { id: "s", handle: "South" }] });
}

test("players can move and turns alternate", () => {
  const next = applyAction(state(), "south", { type: "move", row: 7, col: 4 });
  assert.equal(next.players.south.row, 7);
  assert.equal(next.turn, "north");
});

test("wall placement keeps both paths open", () => {
  const next = applyAction(state(), "south", { type: "wall", row: 0, col: 4, orientation: "horizontal" });
  assert.equal(next.players.south.walls, 9);
  assert.equal(hasPathToGoal(next, "south"), true);
  assert.equal(hasPathToGoal(next, "north"), true);
});

test("jump and diagonal movement are generated around adjacent opponent", () => {
  let s = state();
  s.players.south.row = 4;
  s.players.south.col = 4;
  s.players.north.row = 5;
  s.players.north.col = 4;
  const moves = legalMoves(s, "south");
  assert.ok(moves.some((m) => m.row === 6 && m.col === 4));
});

test("same-direction walls cannot overlap by one segment", () => {
  const afterFirst = applyAction(state(), "south", { type: "wall", row: 0, col: 4, orientation: "horizontal" });
  assert.throws(
    () => applyAction(afterFirst, "north", { type: "wall", row: 0, col: 5, orientation: "horizontal" }),
    /wall_overlap/
  );
});

test("same-direction walls can touch end-to-end", () => {
  const afterFirst = applyAction(state(), "south", { type: "wall", row: 0, col: 4, orientation: "horizontal" });
  const afterSecond = applyAction(afterFirst, "north", { type: "wall", row: 0, col: 6, orientation: "horizontal" });
  assert.equal(afterSecond.walls.length, 2);
});

test("clock timeout gives the win to the opponent", () => {
  const s = state();
  s.clocks.southMs = 1;
  s.clocks.lastTurnAt = 100;
  s.moveNumber = 1;
  s.replay = [{ n: 1, side: "north", action: { type: "move", row: 1, col: 4 }, at: 50 }];
  s.firstActionDone = { south: true, north: true };
  const timeout = finishByClockTimeout(s, "south", 102);
  assert.equal(timeout.status, "finished");
  assert.equal(timeout.winner, "north");
  assert.equal(timeout.clocks.southMs, 0);
});

test("first turn timeout abandons without winner", () => {
  const s = state();
  s.clocks.lastTurnAt = 100;
  const timeout = finishByClockTimeout(s, "south", 100 + FIRST_TURN_GRACE_MS);
  assert.equal(timeout.status, "abandoned");
  assert.equal(timeout.winner, null);
  assert.equal(timeout.endReason, "first_turn_no_move");
});

test("first move starts clock without spending five minute bank", () => {
  const s = state();
  s.clocks.lastTurnAt = 100;
  const next = applyAction(s, "south", { type: "move", row: 7, col: 4 }, 5000);
  assert.equal(next.clocks.southMs, START_CLOCK_MS);
  assert.equal(next.turn, "north");
  assert.equal(next.firstActionDone.south, true);
  assert.equal(next.firstActionDone.north, false);
});

test("second player also gets first move grace", () => {
  const afterSouth = applyAction(state(), "south", { type: "move", row: 7, col: 4 }, 5000);
  afterSouth.clocks.lastTurnAt = 100;
  const timeout = finishByClockTimeout(afterSouth, "north", 100 + FIRST_TURN_GRACE_MS);
  assert.equal(timeout.status, "abandoned");
  assert.equal(timeout.winner, null);
});

test("bot matches do not use opening grace", () => {
  const s = createInitialState({ players: [{ id: "bot_1", handle: "AI" }, { id: "s", handle: "South" }] });
  s.clocks.lastTurnAt = 100;
  const next = finishByClockTimeout(s, "south", 100 + FIRST_TURN_GRACE_MS);
  assert.equal(next.status, "active");
  assert.equal(next.clocks.southMs, START_CLOCK_MS);
});

test("ai difficulties choose legal actions", () => {
  const afterPlayer = applyAction(state(), "south", { type: "move", row: 7, col: 4 });
  for (const difficulty of ["easy", "medium", "hard"]) {
    const ai = chooseAiAction(afterPlayer, "north", difficulty);
    const afterAi = applyAction(afterPlayer, "north", ai.action);
    assert.equal(afterAi.turn, "south");
  }
});
