// End-to-end against a running dev server (workerd + Durable Object + WebSockets).
//
//   npx wrangler dev --port 8787        # in one shell
//   npm run test:e2e                    # in another
//
// Skips (exit 0) when nothing is listening, so it never breaks a plain `npm test`.
import { identifyCombo, beats } from "../.test-build/bundle.mjs";

const BASE = process.env.BASE ?? "http://127.0.0.1:8787";
let failures = 0;
const assert = (cond, msg) => {
  if (!cond) {
    failures++;
    console.log(`  ✗ FAIL: ${msg}`);
  }
};

try {
  await fetch(`${BASE}/api/rooms`, { method: "POST" });
} catch {
  console.log(`\n[s] no server on ${BASE} — start one with: npx wrangler dev --port 8787`);
  process.exit(0);
}

const waitFor = (fn, ms = 5000) =>
  new Promise((res, rej) => {
    const t0 = Date.now();
    const tick = () => (fn() ? res() : Date.now() - t0 > ms ? rej(new Error("timeout")) : setTimeout(tick, 20));
    tick();
  });

class Client {
  constructor(name) {
    this.name = name;
    this.state = null;
    this.errors = [];
    this.seq = 0;
  }
  async connect(code) {
    this.ws = new WebSocket(`${BASE.replace(/^http/, "ws")}/ws/${code}`);
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      this.seq++;
      if (msg.type === "state") this.state = msg;
      if (msg.type === "error") this.errors.push(msg.message);
    };
    await new Promise((res, rej) => {
      this.ws.onopen = res;
      this.ws.onerror = rej;
    });
    this.ws.send(JSON.stringify({ type: "join", name: this.name }));
    await waitFor(() => this.state);
  }
  send(m) { this.ws.send(JSON.stringify(m)); }
  get seat() { return this.state.youSeat; }
  hand() { return [...this.state.hand].sort((a, b) => a - b); }
}

function allCombos(hand) {
  const out = [];
  const h = [...hand];
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

const { code } = await (await fetch(`${BASE}/api/rooms`, { method: "POST" })).json();
console.log(`\n[e2e] room ${code} on ${BASE}`);

const clients = [new Client("Ana"), new Client("Budi"), new Client("Cici")];
for (const c of clients) await c.connect(code);

/** Plays one whole game with auto-players and returns the final state. */
async function playRound() {
  let plays = 0;
  let passes = 0;
  let continuedAfterSomeoneWentOut = false;
  let finishedCount = 0;

  for (let step = 0; step < 600; step++) {
    const st = clients[0].state;
    if (st.phase !== "playing") break;
    const cur = st.players[st.turnSeat];

    assert(!!cur, "the turn points at a real player");
    assert(!cur.passed, `the turn never lands on ${cur?.name}, who passed this trick`);
    assert(cur.cardCount > 0, `the turn never lands on ${cur?.name}, who is out of cards`);
    assert(!cur.left, "the turn never lands on a quitter");
    assert(st.turnMs === 30000 || st.turnMs === 8000, `turn length is one of the two known values (got ${st.turnMs})`);

    if (st.finishedOrder.length > finishedCount) {
      finishedCount = st.finishedOrder.length;
      continuedAfterSomeoneWentOut = st.phase === "playing";
    }

    const actor = clients.find((c) => c.seat === st.turnSeat);
    const pileCombo = st.pile ? identifyCombo(st.pile.cards) : null;
    const options = allCombos(actor.hand()).filter((o) => {
      if (st.requiredCard !== null && !o.cards.includes(st.requiredCard)) return false;
      if (!pileCombo) return true;
      return o.combo.size === pileCombo.size && beats(o.combo, pileCombo);
    });

    const seq = clients[0].seq;
    if (pileCombo && (options.length === 0 || Math.random() < 0.3)) {
      passes++;
      actor.send({ type: "pass" });
    } else {
      plays++;
      actor.send({ type: "play", cards: options[Math.floor(Math.random() * options.length)].cards });
    }
    await waitFor(() => clients[0].seq > seq, 5000).catch(() => {});
  }

  return { state: clients[0].state, plays, passes, continuedAfterSomeoneWentOut, finishedCount };
}

assert(clients[0].state.players.length === 3, "three players joined");
clients[0].send({ type: "start" });
await waitFor(() => clients.every((c) => c.state.phase === "playing"));

const round1 = await playRound();
const end = round1.state;
console.log(`[e2e] round 1: ${round1.plays} plays / ${round1.passes} passes → ${end.phase}`);
console.log(`[e2e] standings: ${JSON.stringify(end.standings)}`);
console.log(`[e2e] points: ${JSON.stringify(end.scores)} after ${end.rounds} round(s)`);
console.log(`[e2e] tail: ${end.log.slice(-3).join(" | ")}`);

assert(end.phase === "finished", "the game reached the finished phase");
assert(round1.finishedCount >= 1, "at least one player emptied their hand");
assert(round1.continuedAfterSomeoneWentOut, "play continued after the first player went out");
assert(end.rounds === 1, "one round was banked");
const holders = end.players.filter((p) => !p.left && p.cardCount > 0);
assert(holders.length === 1, `exactly one player still holds cards (got ${holders.length})`);
if (holders.length === 1) {
  const loser = holders[0];
  assert(end.standings[0] !== loser.name, "the player holding cards did not win");
  assert(end.standings.at(-1).startsWith(loser.name), "the loser is bottom of the standings");
  assert(end.scores[loser.name] === loser.cardCount, `the loser banked one point per card (got ${end.scores[loser.name]})`);
}
assert(end.log.filter((l) => l.includes("🏆")).length === 1, "exactly one winner line");
for (const c of clients) assert(c.errors.length === 0, `${c.name} saw no server errors (${c.errors})`);

const round1Points = { ...end.scores };
const round1Total = Object.values(round1Points).reduce((a, b) => a + b, 0);
const round1LoserCards = Number(/\((\d+) left\)/.exec(end.standings.at(-1))?.[1] ?? 0);

// ---- second round: the points must carry over ----
clients[0].send({ type: "rematch" });
await waitFor(() => clients[0].state.phase === "lobby");
assert(clients[0].state.phase === "lobby", "the host sent everyone back to the lobby");
clients[0].send({ type: "start" });
await waitFor(() => clients[0].state.phase === "playing");
assert(clients[0].state.log.join("\n").includes("Round 2 —"), "the log labels the second round");

const round2 = await playRound();
const end2 = round2.state;
console.log(`[e2e] round 2: ${round2.plays} plays / ${round2.passes} passes → ${end2.phase}`);
console.log(`[e2e] points: ${JSON.stringify(end2.scores)} after ${end2.rounds} round(s)`);

assert(end2.phase === "finished", "the second game finished");
assert(end2.rounds === 2, `two rounds banked (got ${end2.rounds})`);
const round2Total = Object.values(end2.scores).reduce((a, b) => a + b, 0);
const round2LoserCards = Number(/\((\d+) left\)/.exec(end2.standings.at(-1))?.[1] ?? 0);
assert(
  round2Total === round1LoserCards + round2LoserCards,
  `points from both rounds added up (${round2Total} = ${round1LoserCards} + ${round2LoserCards})`,
);
for (const [name, pts] of Object.entries(round1Points)) {
  assert((end2.scores[name] ?? 0) >= pts, `${name}'s points were kept (${pts} → ${end2.scores[name]})`);
}

for (const c of clients) c.ws.close();
console.log(failures === 0 ? "\n✅ end-to-end checks passed" : `\n❌ ${failures} end-to-end check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
