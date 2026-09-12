// Drives the real GameRoom (built from src/room.ts) with fake Durable Object
// context, storage and WebSockets. Plain assertions, no test framework.
//
//   node test/run.mjs        (builds first, then runs this with test/ui.mjs)
//   node test/harness.mjs    (needs .test-build/bundle.mjs to exist)
import { GameRoom, identifyCombo, beats } from "../.test-build/bundle.mjs";

const card = (rank, suit) => rank * 4 + suit; // rank 0=3 … 12=2; suit 0=♦ 1=♣ 2=♥ 3=♠

let failures = 0;
function assert(cond, msg) {
  if (!cond) {
    failures++;
    console.log(`  ✗ FAIL: ${msg}`);
  }
}

// ---- Fake Durable Object environment ----
function makeCtx(store = new Map()) {
  const sockets = [];
  return {
    store,
    sockets,
    storage: {
      get: async (k) => store.get(k),
      put: async (k, v) => store.set(k, structuredClone(v)),
      deleteAlarm: async () => {},
      setAlarm: async () => {},
    },
    acceptWebSocket: (ws) => sockets.push(ws),
    getWebSockets: () => sockets,
    blockConcurrencyWhile: (fn) => fn(),
  };
}

class FakeWS {
  constructor() {
    this.att = null;
    this.inbox = [];
  }
  serializeAttachment(a) { this.att = a; }
  deserializeAttachment() { return this.att; }
  send(data) { this.inbox.push(typeof data === "string" ? JSON.parse(data) : data); }
  clear() { this.inbox.length = 0; }
  last(type) {
    for (let i = this.inbox.length - 1; i >= 0; i--) if (this.inbox[i].type === type) return this.inbox[i];
    return null;
  }
}

const settle = () => new Promise((r) => setImmediate(r)); // let the DO "load from storage" finish

async function join(room, ctx, name, token = "") {
  const ws = new FakeWS();
  ctx.acceptWebSocket(ws);
  await room.webSocketMessage(ws, JSON.stringify({ type: "join", name, token }));
  return ws;
}

async function newRoom(names, store) {
  const ctx = makeCtx(store);
  const room = new GameRoom(ctx, {});
  await settle();
  await room.create();
  const socks = [];
  for (const n of names) socks.push(await join(room, ctx, n));
  return { room, ctx, socks };
}

const send = (room, ws, msg) => room.webSocketMessage(ws, JSON.stringify(msg));

async function act(room, ws, msg) {
  ws.clear();
  await send(room, ws, msg);
  return ws.last("error")?.message ?? null;
}
const play = (room, ws, cards) => act(room, ws, { type: "play", cards });
const pass = (room, ws) => act(room, ws, { type: "pass" });

const seatOf = (room, name) => room.state.players.findIndex((p) => p.name === name);
/** Look a socket up by player name — seats are reshuffled when someone leaves. */
const wsOf = (room, socks, name) => {
  const id = room.state.players.find((p) => p.name === name)?.id;
  return socks.find((ws) => ws.att?.playerId === id);
};

/** Force known hands and a known starting seat (skip the dealt cards). */
function rig(room, hands, turnSeat = 0) {
  room.state.requiredCard = null;
  room.state.pile = null;
  room.state.turnSeat = turnSeat;
  room.state.players.forEach((p, i) => {
    p.hand = [...hands[i]].sort((a, b) => a - b);
    p.passed = false;
    p.left = false;
  });
}

/** Simulate a socket dropping: the socket leaves the DO, then close fires. */
async function drop(ctx, room, ws) {
  ctx.sockets.splice(ctx.sockets.indexOf(ws), 1);
  await room.webSocketClose(ws);
}

// ---- 1. a pass sits you out for the rest of the trick ----
async function scenarioPassSkips() {
  console.log("\n[1] a passed player stays skipped until the trick is won");
  const { room, socks } = await newRoom(["A", "B", "C", "D"]);
  await send(room, socks[0], { type: "start" });
  rig(room, [
    [card(0, 0), card(4, 0)],   // A: 3♦ 7♦
    [card(0, 1), card(10, 0)],  // B: 3♣ K♦  <- passes, then must stay skipped
    [card(3, 0), card(9, 0)],   // C: 6♦ Q♦
    [card(1, 0), card(11, 0)],  // D: 4♦ A♦
  ]);

  assert((await play(room, socks[0], [card(0, 0)])) === null, "A leads 3♦");
  assert((await pass(room, socks[1])) === null, "B passes");
  assert(room.state.players[1].passed === true, "B is flagged as passed");
  assert((await play(room, socks[2], [card(3, 0)])) === null, "C plays 6♦ over 3♦");
  assert(room.state.players[1].passed === true, "B is still flagged after someone else played");
  assert(room.state.turnSeat === 3, `turn moves to D (got seat ${room.state.turnSeat})`);
  assert((await play(room, socks[3], [card(11, 0)])) === null, "D plays A♦");
  assert((await pass(room, socks[0])) === null, "A cannot beat A♦ and passes");
  assert(room.state.turnSeat === 2, `B (seat 1) is skipped, turn lands on C (got ${room.state.turnSeat})`);

  const err = await play(room, socks[1], [card(10, 0)]);
  assert(err === "It's not your turn", `B cannot move while skipped (got: ${err})`);

  assert((await pass(room, socks[2])) === null, "C passes too");
  assert(room.state.pile === null, "the trick closes when it comes back to its owner");
  assert(room.state.turnSeat === 3, `D leads the next trick (got seat ${room.state.turnSeat})`);
  assert(room.state.players.every((p) => !p.passed), "pass flags reset once the trick is won");
  assert(room.state.log.join("\n").includes("D won the trick and leads"), "the log says who won the trick");
}

// ---- 2. play continues until one player is left holding cards ----
async function scenarioGameContinues() {
  console.log("\n[2] the game keeps going until one player is left holding cards");
  const { room, socks } = await newRoom(["A", "B", "C"]);
  await send(room, socks[0], { type: "start" });
  rig(room, [
    [card(0, 0)],                         // A: 3♦
    [card(2, 0), card(7, 0)],             // B: 5♦ 10♦
    [card(6, 0), card(8, 0), card(9, 0)], // C: 9♦ J♦ Q♦
  ]);

  assert((await play(room, socks[0], [card(0, 0)])) === null, "A plays their last card");
  assert(room.state.phase === "playing", "A running out does NOT end the game");
  assert(room.state.standings[0] === "A", "A is recorded as first out");
  assert(room.state.turnSeat === 1, `B is next (got seat ${room.state.turnSeat})`);
  assert((await play(room, socks[1], [card(2, 0)])) === null, "B plays 5♦");
  assert(room.state.turnSeat === 2, "C is next");
  assert((await play(room, socks[2], [card(6, 0)])) === null, "C plays 9♦");
  assert(room.state.turnSeat === 1, `the turn skips A who is out of cards (got ${room.state.turnSeat})`);
  assert((await play(room, socks[1], [card(7, 0)])) === null, "B plays their last card 10♦");

  assert(room.state.phase === "finished", "the game ends with only one player holding cards");
  assert(
    JSON.stringify(room.state.standings) === JSON.stringify(["A", "B", "C (2 left)"]),
    `standings = [A, B, C (2 left)], got ${JSON.stringify(room.state.standings)}`,
  );
  const log = room.state.log.join("\n");
  assert(log.includes("🏆 A wins!"), "the first player out wins");
  assert(log.includes("❌ C left holding 2 card(s)"), "the loser is reported with their remaining cards");
  assert(room.state.players[2].hand.length === 2 && !room.state.players[2].left, "the loser keeps their cards");
}

// ---- 3. the trick closes when its owner already went out ----
async function scenarioTrickAfterWinnerOut() {
  console.log("\n[3] the trick closes when the pile owner already went out");
  const { room, socks } = await newRoom(["A", "B", "C"]);
  await send(room, socks[0], { type: "start" });
  rig(room, [
    [card(0, 0)],
    [card(2, 0), card(5, 0)],
    [card(4, 0), card(7, 0), card(8, 0)],
  ]);

  await play(room, socks[0], [card(0, 0)]); // A goes out leading
  assert(room.state.pile?.seat === 0, "the pile still belongs to A");
  assert((await pass(room, socks[1])) === null, "B passes");
  assert((await pass(room, socks[2])) === null, "C passes");
  assert(room.state.phase === "playing", "the game is still running");
  assert(room.state.pile === null, "A's trick is closed once everyone else passed");
  assert(room.state.turnSeat === 1, `B leads the next trick (got ${room.state.turnSeat})`);
  assert((await play(room, socks[1], [card(2, 0)])) === null, "B can lead the new trick");
}

// ---- 4. quitting ----
async function scenarioQuit() {
  console.log("\n[4] quitting");
  const { room, socks } = await newRoom(["A", "B", "C"]);
  await send(room, socks[0], { type: "start" });
  rig(room, [
    [card(0, 0), card(1, 0)],
    [card(2, 0), card(3, 0)],
    [card(4, 0), card(5, 0)],
  ]);

  assert((await send(room, socks[1], { type: "quit" })) === undefined, "B quits");
  assert(room.state.phase === "playing", "one quit out of three: the game continues");
  assert(room.state.players[1].left === true, "B is marked as quit");
  assert(room.state.turnSeat !== 1, "the quitter is never on the clock");
  assert(room.state.scores.B === 2, `quitting with 2 cards costs 2 points (got ${room.state.scores.B})`);

  await send(room, socks[2], { type: "quit" });
  assert(room.state.phase === "finished", "only one player left: game over");
  assert(
    JSON.stringify(room.state.standings) === JSON.stringify(["A", "B (quit)", "C (quit)"]),
    `the survivor wins by walkover, got ${JSON.stringify(room.state.standings)}`,
  );
  assert(room.state.log.join("\n").includes("🏆 A wins!"), "A wins the walkover");
}

// ---- 5. two players: first one out wins, the other loses ----
async function scenarioTwoPlayers() {
  console.log("\n[5] two players");
  const { room, socks } = await newRoom(["A", "B"]);
  await send(room, socks[0], { type: "start" });
  rig(room, [[card(0, 0)], [card(3, 0), card(4, 0)]]);
  await play(room, socks[0], [card(0, 0)]);
  assert(room.state.phase === "finished", "the game ends as soon as one player goes out");
  assert(
    JSON.stringify(room.state.standings) === JSON.stringify(["A", "B (2 left)"]),
    `got ${JSON.stringify(room.state.standings)}`,
  );
  assert(room.state.scores.B === 2, `the loser pays for both cards (got ${room.state.scores.B})`);
}

// ---- 6. random full games, invariant checked on every turn ----
function allCombos(hand) {
  const out = [];
  const h = [...hand].sort((a, b) => a - b);
  const pick = (start, size, cur) => {
    if (cur.length === size) {
      const c = identifyCombo(cur);
      if (c) out.push({ combo: c, cards: [...cur] });
      return;
    }
    for (let i = start; i < h.length; i++) {
      cur.push(h[i]);
      pick(i + 1, size, cur);
      cur.pop();
    }
  };
  for (let size = 1; size <= 5; size++) pick(0, size, []);
  return out;
}

async function randomGames(games) {
  console.log(`\n[6] ${games} randomised full games (auto-players)`);
  const summary = [];
  for (let g = 0; g < games; g++) {
    const n = 2 + (g % 3);
    const names = ["P0", "P1", "P2", "P3"].slice(0, n);
    const { room, socks } = await newRoom(names);
    await send(room, socks[0], { type: "start" });
    const finishers = [];
    let steps = 0;

    while (room.state.phase === "playing" && steps++ < 3000) {
      const s = room.state;
      const cur = s.players[s.turnSeat];
      assert(cur && cur.hand.length > 0 && !cur.left, `game ${g}: turn given to a player who is out`);
      assert(!cur.passed, `game ${g}: turn given to ${cur?.name} who already passed this trick`);
      assert(
        s.turnMs === (cur.connected ? 30000 : 8000),
        `game ${g}: turn length matches who is on the clock (got ${s.turnMs})`,
      );

      const ws = socks[cur.seat];
      const pile = s.pile?.combo ?? null;
      const pileKey = s.pile ? s.pile.combo.cards.join(",") : null;
      const options = allCombos(cur.hand).filter((o) => {
        if (s.requiredCard !== null && !o.cards.includes(s.requiredCard)) return false;
        if (!pile) return true;
        return o.combo.size === pile.size && beats(o.combo, pile);
      });
      const before = s.log.filter((l) => l.includes("finished —")).length;

      if (pile && (options.length === 0 || Math.random() < 0.25)) {
        const err = await pass(room, ws);
        assert(!err, `game ${g}: pass rejected (${err})`);
        assert(
          room.state.pile === null || room.state.pile.combo.cards.join(",") === pileKey,
          `game ${g}: a pass never replaces the pile`,
        );
      } else {
        const choice = options[Math.floor(Math.random() * options.length)] ?? { cards: [cur.hand[0]] };
        const err = await play(room, ws, choice.cards);
        assert(!err, `game ${g}: play rejected (${err})`);
      }
      for (const l of room.state.log.filter((l) => l.includes("finished —")).slice(before)) {
        finishers.push(l.replace(/^✅ /, "").split(" finished")[0]);
      }
      if (room.state.phase === "playing") {
        assert(room.state.players[room.state.turnSeat].hand.length > 0, `game ${g}: empty-handed player on the clock`);
      }
    }

    const st = room.state.standings;
    assert(room.state.phase === "finished", `game ${g}: the game finished`);
    assert(room.state.rounds === 1, `game ${g}: one round counted`);
    assert(room.state.log.filter((l) => l.includes("🏆")).length === 1, `game ${g}: exactly one winner line`);
    assert(st[0] === finishers[0], `game ${g}: the winner is the first player out`);
    const holders = room.state.players.filter((p) => !p.left && p.hand.length > 0);
    assert(holders.length <= 1, `game ${g}: at most one player still holds cards`);
    const quitters = room.state.players.filter((p) => p.left);
    if (holders.length === 1 && finishers.length > 0) {
      const loser = holders[0];
      assert(st.includes(`${loser.name} (${loser.hand.length} left)`), `game ${g}: the loser is listed with their cards`);
      assert(st[st.length - 1] === `${loser.name} (${loser.hand.length} left)`, `game ${g}: the loser is last`);
      assert(room.state.scores[loser.name] === loser.hand.length, `game ${g}: the loser paid 1 point per card`);
    }
    assert(
      st.length === finishers.length + quitters.length + (holders.length === 1 && finishers.length > 0 ? 1 : 0),
      `game ${g}: the standings add up (${JSON.stringify(st)})`,
    );
    const totalPoints = Object.values(room.state.scores).reduce((a, b) => a + b, 0);
    const expected = (holders.length === 1 && finishers.length > 0 ? holders[0].hand.length : 0) + quitters.reduce((a, p) => a + p.hand.length, 0);
    assert(totalPoints === expected, `game ${g}: points banked match cards left (${totalPoints} vs ${expected})`);
    summary.push(`${names.length}p, ${steps} turns → ${st.join(" > ")}`);
  }
  for (const line of summary.slice(0, 3)) console.log(`    ${line}`);
}

// ---- 7. points carry across rounds ----
async function scenarioScoring() {
  console.log("\n[7] points carry across rounds");
  const { room, socks } = await newRoom(["A", "B"]);
  await send(room, socks[0], { type: "start" });
  assert(room.state.log[0].startsWith("Round 1 —"), `the log opens with the round number (${room.state.log[0]})`);
  rig(room, [[card(0, 0)], [card(3, 0), card(4, 0)]]);
  assert((await play(room, socks[0], [card(0, 0)])) === null, "A goes out");
  assert(room.state.rounds === 1, "round 1 counted");
  assert(room.state.scores.B === 2, `B pays 2 points (got ${JSON.stringify(room.state.scores)})`);

  assert((await act(room, socks[0], { type: "rematch" })) === null, "host starts a rematch");
  assert(room.state.phase === "lobby", "back to the lobby");
  assert(room.state.scores.B === 2, "points survive the rematch");

  await send(room, socks[0], { type: "start" });
  assert(room.state.log[0].startsWith("Round 2 —"), `second round is labelled (${room.state.log[0]})`);
  rig(room, [[card(0, 0)], [card(3, 0)]]);
  assert((await play(room, socks[0], [card(0, 0)])) === null, "A goes out again");
  assert(room.state.scores.B === 3, `B's points accumulate (got ${room.state.scores.B})`);
  assert(room.state.rounds === 2, "round 2 counted");

  const err = await act(room, socks[1], { type: "reset-scores" });
  assert(err === "Only the host can reset the points", `a non-host cannot reset (got: ${err})`);
  assert((await act(room, socks[0], { type: "reset-scores" })) === null, "the host can reset");
  assert(JSON.stringify(room.state.scores) === "{}" && room.state.rounds === 0, "points and rounds are cleared");
}

// ---- 8. the host role moves when the host walks off ----
async function scenarioHostTransfer() {
  console.log("\n[8] host handover");
  const { room, ctx, socks } = await newRoom(["A", "B", "C"]);
  assert(room.state.hostId === room.state.players[0].id, "A starts as host");

  await drop(ctx, room, socks[0]);
  assert(room.state.hostId === room.state.players.find((p) => p.name === "B").id, "the crown moves to B");
  assert(!room.state.players.some((p) => p.name === "A"), "a disconnected host frees their lobby seat");
  assert(room.state.log.join("\n").includes("is now the host"), "the log says who took over");
  assert((await act(room, wsOf(room, socks, "B"), { type: "start" })) === null, "B can now start the game");
  assert(room.state.phase === "playing", "the game started for the new host");

  // Mid-game: the crown moves but the seat stays (they may come back)
  const { room: r2, ctx: c2, socks: s2 } = await newRoom(["X", "Y", "Z"]);
  await send(r2, s2[0], { type: "start" });
  await drop(c2, r2, s2[0]);
  assert(r2.state.hostId === r2.state.players[1].id, "mid-game the crown moves to a connected player");
  assert(r2.state.players.length === 3, "mid-game seats are kept for a reconnect");
  assert(r2.state.phase === "playing", "the game keeps running");
}

// ---- 9. disconnected players get a short clock ----
async function scenarioOfflineClock() {
  console.log("\n[9] short clock for a player who dropped off");
  const { room, ctx, socks } = await newRoom(["A", "B", "C"]);
  await send(room, socks[0], { type: "start" });
  rig(room, [[card(0, 0)], [card(3, 0), card(4, 0)], [card(6, 0), card(7, 0)]], 0);

  await drop(ctx, room, socks[1]);
  assert(room.state.players[1].connected === false, "B shows as disconnected");
  assert((await play(room, socks[0], [card(0, 0)])) === null, "A plays; the turn passes to B");
  assert(room.state.turnSeat === 1, `B is on the clock (got ${room.state.turnSeat})`);
  assert(room.state.turnMs === 8000, `B gets the short clock (got ${room.state.turnMs})`);
  const remain = room.state.turnDeadline - Date.now();
  assert(remain <= 8000 && remain > 4000, `the deadline matches the short clock (${remain}ms)`);

  // Timeout on the short clock: B auto-passes instead of stalling the table
  const realNow = Date.now;
  Date.now = () => realNow() + 9000;
  try {
    await room.alarm();
  } finally {
    Date.now = realNow;
  }
  assert(room.state.players[1].passed === true, "the timeout auto-passed B");
  assert(room.state.turnSeat !== 1, "the turn moved on without waiting 30s");

  // Reconnecting restores a full turn
  const wsB = new FakeWS();
  ctx.acceptWebSocket(wsB);
  await room.webSocketMessage(wsB, JSON.stringify({ type: "join", name: "B", token: room.state.players[1].id }));
  assert(room.state.players[1].connected === true, "B is back");
  assert(room.state.turnMs === 30000, `a reconnected player gets the full clock (got ${room.state.turnMs})`);
}

// ---- 10. stored state from an older build keeps working ----
async function scenarioPersistence() {
  console.log("\n[10] state survives a restart, including state written by an older build");
  const store = new Map();
  const { room, socks } = await newRoom(["A", "B"], store);
  await send(room, socks[0], { type: "start" });
  rig(room, [[card(0, 0), card(1, 0), card(2, 0)], [card(3, 0), card(4, 0), card(5, 0)]]);
  await play(room, socks[0], [card(0, 0)]);

  const room2 = new GameRoom(makeCtx(store), {});
  await settle();
  assert(room2.state.phase === "playing", "phase restored");
  assert(room2.state.players[0].hand.length === 2, "hands restored");
  assert(room2.state.turnSeat === 1, "turn restored");

  const legacy = new Map();
  legacy.set("state", {
    created: true,
    phase: "lobby",
    players: [{ id: "p1", name: "Old", seat: 0, hand: [], connected: true, passed: false, left: false }],
    hostId: "p1",
    turnSeat: 0,
    pile: null,
    requiredCard: null,
    standings: [],
    log: [],
    turnDeadline: null,
  });
  const room3 = new GameRoom(makeCtx(legacy), {});
  await settle();
  assert(room3.state.players.length === 1 && room3.state.players[0].name === "Old", "old players survive");
  assert(room3.state.rounds === 0, "a missing rounds field defaults to 0");
  assert(JSON.stringify(room3.state.scores) === "{}", "a missing scores field defaults to {}");
  assert(room3.state.turnMs === null, "a missing turnMs field defaults to null");
}

await scenarioPassSkips();
await scenarioGameContinues();
await scenarioTrickAfterWinnerOut();
await scenarioQuit();
await scenarioTwoPlayers();
await randomGames(30);
await scenarioScoring();
await scenarioHostTransfer();
await scenarioOfflineClock();
await scenarioPersistence();

console.log(failures === 0 ? "\n✅ game-room checks passed" : `\n❌ ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
