// Runs the real public/app.js against a minimal DOM stub so the render paths
// actually execute (not just parse).
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let failures = 0;
const assert = (cond, msg) => {
  if (!cond) {
    failures++;
    console.log(`  ✗ FAIL: ${msg}`);
  }
};
const card = (rank, suit) => rank * 4 + suit;

const htmlWrites = [];
class FakeEl {
  constructor(id) {
    this.id = id;
    this.style = {};
    this.children = [];
    this.dataset = {};
    this._text = "";
    this.classList = {
      _s: new Set(),
      add: (c) => this.classList._s.add(c),
      remove: (c) => this.classList._s.delete(c),
      contains: (c) => this.classList._s.has(c),
      toggle: (c, on) => (on === undefined ? this.classList._s.has(c) : on ? this.classList._s.add(c) : this.classList._s.delete(c)),
    };
  }
  set innerHTML(v) { this._html = String(v); htmlWrites.push(String(v)); }
  get innerHTML() { return this._html ?? ""; }
  set textContent(v) { this._text = String(v); }
  get textContent() { return this._text; }
  appendChild(c) { this.children.push(c); return c; }
  addEventListener() {}
  remove() {}
  querySelectorAll() { return []; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 10, height: 10 }; }
  close() {}
}

const els = new Map();
const getEl = (id) => {
  if (!els.has(id)) els.set(id, new FakeEl(id));
  return els.get(id);
};

const storage = new Map();
const ctx = {
  console,
  setTimeout,
  clearTimeout,
  setInterval: () => 0,
  requestAnimationFrame: (fn) => fn(),
  localStorage: {
    getItem: (k) => storage.get(k) ?? null,
    setItem: (k, v) => storage.set(k, v),
    removeItem: (k) => storage.delete(k),
  },
  location: { hash: "#ABCD", protocol: "http:", host: "127.0.0.1:8787", origin: "http://127.0.0.1:8787" },
  document: {
    getElementById: getEl,
    createElement: () => new FakeEl(),
    querySelectorAll: () => [],
    querySelector: () => null,
    addEventListener: () => {},
    body: new FakeEl("body"),
  },
  navigator: { clipboard: { writeText: async () => {} } },
  matchMedia: () => ({ matches: true }), // prefer-reduced-motion: skip the deal cinematic
};
ctx.window = ctx;
ctx.globalThis = ctx;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
vm.createContext(ctx);
vm.runInContext(readFileSync(join(root, "public", "app.js"), "utf8"), ctx, { filename: "app.js" });

const setState = (s) => vm.runInContext(`state = ${JSON.stringify(s)}`, ctx);
const run = (expr) => vm.runInContext(expr, ctx);

const table = (over = {}) => ({
  phase: "playing",
  youSeat: 0,
  isHost: true,
  hand: [card(0, 0), card(4, 0)],
  turnSeat: 1,
  turnDeadline: Date.now() + 20000,
  turnMs: 30000,
  requiredCard: null,
  pile: { cards: [card(3, 0)], kind: "single", seat: 1 },
  players: [
    { name: "Host", seat: 0, cardCount: 2, connected: true, passed: false, left: false, isHost: true },
    { name: "Guest", seat: 1, cardCount: 3, connected: true, passed: true, left: false, isHost: false },
    { name: "Third", seat: 2, cardCount: 0, connected: true, passed: false, left: false, isHost: false },
    { name: "Quitter", seat: 3, cardCount: 0, connected: false, passed: true, left: true, isHost: false },
  ],
  finishedOrder: ["Third"],
  standings: [],
  scores: {},
  rounds: 0,
  log: ["Round 1 — Host played 4♦"],
  ...over,
});

// ---- game screen ----
console.log("[ui] game screen");
setState(table());
htmlWrites.length = 0;
run("render()");
const oppHtml = htmlWrites.join("\n");
assert(oppHtml.includes("passed"), "a player who passed is flagged");
assert(oppHtml.includes("🏁 out (1st)"), "a player who went out shows their finishing place");
assert(oppHtml.includes("quit"), "a quitter is flagged as quit");
assert(oppHtml.includes("Waiting for Guest (offline)") === false, "a connected player is not marked offline");
assert(getEl("btn-play").disabled === true, "Play is disabled when it is not my turn");

setState(table({ turnSeat: 0 }));
run("render()");
assert(getEl("btn-play").disabled === false, "Play is live on my turn");
assert(getEl("btn-pass").disabled === false, "Pass is live while a pile is on the table");
assert(htmlWrites.join("\n").includes("Your turn"), "the banner tells me it is my turn");

setState(table({
  turnSeat: 2,
  players: table().players.map((p) => (p.name === "Third" ? { ...p, connected: false, cardCount: 5 } : p)),
}));
run("render()");
assert(htmlWrites.join("\n").includes("Waiting for Third (offline)"), "an offline player on the clock is called out");

// ---- end screen ----
console.log("[ui] end screen");
const endState = (over) => ({
  phase: "finished",
  youSeat: 0,
  isHost: true,
  hand: [],
  turnSeat: 0,
  turnDeadline: null,
  turnMs: null,
  requiredCard: null,
  pile: null,
  finishedOrder: [],
  players: [
    { name: "Host", seat: 0, cardCount: 0, connected: true, passed: false, left: false, isHost: true },
    { name: "Guest", seat: 1, cardCount: 0, connected: true, passed: false, left: false, isHost: false },
  ],
  standings: [],
  scores: {},
  rounds: 1,
  log: ["🏆 Guest wins!"],
  ...over,
});

setState(endState({ standings: ["Host", "Guest (4 left)"], scores: { Host: 4, Guest: 7 } }));
run("render()");
assert(getEl("end-title").textContent === "🏆 You Win!", `the winner sees You Win (got "${getEl("end-title").textContent}")`);
assert(getEl("end-sub").textContent === "You played out first.", "the winner gets a subtitle");
assert(getEl("scoreboard").classList.contains("hidden") === false, "the points table shows once points exist");
assert(getEl("score-rounds").textContent === "after 1 round", `round count labelled (got "${getEl("score-rounds").textContent}")`);
assert(getEl("scores").children.length === 2, "every player gets a points row");
assert(getEl("scores").children[0].innerHTML.includes("Host"), `the lowest total is listed first (${getEl("scores").children[0].innerHTML})`);
assert(getEl("scores").children[0].innerHTML.includes("👑"), "the leader is crowned");
assert(getEl("scores").children[1].innerHTML.includes("Guest"), "the player carrying more points is below");
assert(getEl("btn-reset-scores").classList.contains("hidden") === false, "the host can reset the points");

setState(endState({ standings: ["Guest", "Host (4 left)"], scores: { Host: 4, Guest: 0 } }));
run("render()");
assert(getEl("end-title").textContent === "😵 You Lose", `the loser sees You Lose (got "${getEl("end-title").textContent}")`);
assert(getEl("end-sub").textContent === "You were the last one holding cards.", "the loser gets a subtitle");

setState(endState({ standings: ["Guest", "Host (quit)"], scores: { Host: 6 } }));
run("render()");
assert(getEl("end-title").textContent === "🚪 You Quit", `a quitter sees You Quit (got "${getEl("end-title").textContent}")`);

setState(endState({ standings: ["Host", "Guest (2 left)"], isHost: false, scores: {} }));
run("render()");
assert(getEl("scoreboard").classList.contains("hidden") === true, "no table before anyone has points");
assert(getEl("btn-reset-scores").classList.contains("hidden") === true, "only the host gets the reset button");
assert(getEl("btn-rematch").classList.contains("hidden") === true, "only the host gets the rematch button");

// ---- lobby ----
console.log("[ui] lobby");
setState({
  phase: "lobby",
  youSeat: 0,
  isHost: true,
  hand: [],
  turnSeat: 0,
  turnDeadline: null,
  turnMs: null,
  requiredCard: null,
  pile: null,
  players: [
    { name: "Host", seat: 0, cardCount: 0, connected: true, passed: false, left: false, isHost: true },
    { name: "Guest", seat: 1, cardCount: 0, connected: true, passed: false, left: false, isHost: false },
  ],
  standings: [],
  finishedOrder: [],
  scores: { Guest: 5, Host: 2 },
  rounds: 3,
  log: [],
});
run("render()");
assert(getEl("btn-start").disabled === false, "Start is enabled with 2 players");
assert(getEl("btn-start").classList.contains("hidden") === false, "the host sees the Start button");
assert(getEl("lobby-scores").classList.contains("hidden") === false, "running points show in the lobby");
assert(getEl("lobby-scores").textContent === "After 3 rounds: Host 2 · Guest 5", `points summary (got "${getEl("lobby-scores").textContent}")`);

setState({
  phase: "lobby", youSeat: 1, isHost: false, hand: [], turnSeat: 0, turnDeadline: null, turnMs: null,
  requiredCard: null, pile: null,
  players: [
    { name: "Host", seat: 0, cardCount: 0, connected: true, passed: false, left: false, isHost: true },
    { name: "Guest", seat: 1, cardCount: 0, connected: true, passed: false, left: false, isHost: false },
  ],
  standings: [], finishedOrder: [], scores: {}, rounds: 0, log: [],
});
run("render()");
assert(getEl("btn-start").classList.contains("hidden") === true, "a guest does not see the Start button");
assert(getEl("lobby-scores").classList.contains("hidden") === true, "no points line before anyone scores");

console.log(failures === 0 ? "\n✅ client checks passed" : `\n❌ ${failures} client check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
