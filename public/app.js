"use strict";

// ---- Card helpers (must match src/game.ts encoding) ----
const RANKS = ["3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A", "2"];
const SUITS = ["♦", "♣", "♥", "♠"];
const isRed = (c) => (c & 3) === 0 || (c & 3) === 2; // diamonds, hearts
const rankOf = (c) => c >> 2;
const suitOf = (c) => c & 3;

// ---- State ----
let ws = null;
let roomCode = null;
let state = null;
let prevMyTurn = false;
let dealAnimation = false; // stagger-deal the hand on the next render only
let cinematicRunning = false; // gather/shuffle/deal overlay in progress
let lastPileKey = null;
let confettiDone = false;
const selected = new Set();

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

// ---- Sound effects (WebAudio, no assets needed) ----
const sound = {
  muted: localStorage.getItem("capsa_muted") === "1",
  ctx: null,
  ensure() {
    if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.ctx.state === "suspended") this.ctx.resume();
    return this.ctx;
  },
  tone(freq, start, dur, { type = "sine", gain = 0.12, attack = 0.01 } = {}) {
    if (this.muted) return;
    try {
      const ctx = this.ensure();
      const t = ctx.currentTime + start;
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(gain, t + attack);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(g).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + dur + 0.05);
    } catch {}
  },
  /** Soft filtered-noise "paper" sound — much gentler than an oscillator beep. */
  noise(start, dur, { cutoff = 1200, gain = 0.03 } = {}) {
    if (this.muted) return;
    try {
      const ctx = this.ensure();
      const t = ctx.currentTime + start;
      const len = Math.ceil(ctx.sampleRate * dur);
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = cutoff;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(gain, t + dur * 0.3);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      src.connect(filter).connect(g).connect(ctx.destination);
      src.start(t);
    } catch {}
  },
  cardPlay() { this.tone(520, 0, 0.06, { type: "triangle", gain: 0.2 }); this.tone(760, 0.05, 0.08, { type: "triangle", gain: 0.15 }); },
  pass() { this.tone(300, 0, 0.12, { type: "sine", gain: 0.1 }); },
  yourTurn() { this.tone(880, 0, 0.15); this.tone(1175, 0.13, 0.2); },
  error() { this.tone(170, 0, 0.2, { type: "sawtooth", gain: 0.08 }); },
  win() { [523, 659, 784, 1047].forEach((f, i) => this.tone(f, i * 0.14, 0.25, { gain: 0.15 })); },
  lose() { this.tone(392, 0, 0.25); this.tone(311, 0.22, 0.35); },
  tick() { this.tone(1000, 0, 0.04, { gain: 0.07 }); },
  gather() { this.noise(0, 0.5, { cutoff: 800, gain: 0.05 }); },
  riffle() { this.noise(0, 0.16, { cutoff: 1500, gain: 0.06 }); this.noise(0.1, 0.2, { cutoff: 900, gain: 0.07 }); },
  dealOne() { this.noise(0, 0.05, { cutoff: 1600, gain: 0.035 }); },
  hover() { this.noise(0, 0.045, { cutoff: 1000, gain: 0.012 }); },
  select() {
    this.noise(0, 0.07, { cutoff: 900, gain: 0.045 });
    this.tone(500, 0, 0.12, { gain: 0.045, attack: 0.02 });
  },
  deselect() {
    this.noise(0, 0.07, { cutoff: 700, gain: 0.035 });
    this.tone(380, 0, 0.12, { gain: 0.035, attack: 0.02 });
  },
};

function toggleMute() {
  sound.muted = !sound.muted;
  localStorage.setItem("capsa_muted", sound.muted ? "1" : "0");
  $("btn-sound").textContent = sound.muted ? "🔇" : "🔊";
}

const $ = (id) => document.getElementById(id);
const screens = ["screen-home", "screen-lobby", "screen-game", "screen-end"];

function show(screenId) {
  for (const s of screens) $(s).classList.toggle("hidden", s !== screenId);
}

function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add("hidden"), 3200);
}

// ---- Networking ----

function tokenKey() { return `capsa_token_${roomCode}`; }

function connect(code) {
  roomCode = code.toUpperCase();
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws/${roomCode}`);

  ws.onopen = () => {
    ws.send(JSON.stringify({
      type: "join",
      name: $("name-input").value.trim(),
      token: localStorage.getItem(tokenKey()) || "",
    }));
  };

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === "token") {
      localStorage.setItem(tokenKey(), msg.token);
    } else if (msg.type === "error") {
      toast(msg.message);
      sound.error();
      if (!state) leaveRoom(); // join was rejected
    } else if (msg.type === "state") {
      const prev = state;
      state = msg;
      reactToStateChange(prev);
      render();
    }
  };

  ws.onclose = () => {
    if (roomCode && state) {
      // Try to resume the session after a dropped connection.
      setTimeout(() => { if (roomCode) connect(roomCode); }, 1500);
    }
  };
}

function send(payload) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

function leaveRoom() {
  if (ws) { ws.onclose = null; ws.close(); }
  ws = null;
  roomCode = null;
  state = null;
  selected.clear();
  location.hash = "";
  $("btn-quit").classList.add("hidden");
  document.getElementById("cinematic")?.remove();
  $("screen-game").classList.remove("dealing");
  cinematicRunning = false;
  show("screen-home");
}

// ---- Rendering ----

function cardEl(c, clickable) {
  const el = document.createElement("div");
  el.className = `card ${isRed(c) ? "red" : "black"}`;
  const corner = `${RANKS[rankOf(c)]}<br>${SUITS[suitOf(c)]}`;
  el.innerHTML = `
    <div class="corner">${corner}</div>
    <div class="big-suit">${SUITS[suitOf(c)]}</div>
    <div class="corner bottom">${corner}</div>`;
  if (clickable) {
    if (selected.has(c)) el.classList.add("selected");
    el.onclick = () => {
      if (selected.has(c)) {
        selected.delete(c);
        sound.deselect();
      } else {
        selected.add(c);
        sound.select();
      }
      el.classList.toggle("selected");
    };
    el.onmouseenter = () => sound.hover();
  }
  return el;
}

function render() {
  if (!state) return;
  if (state.phase === "lobby") renderLobby();
  else if (state.phase === "playing") renderGame();
  else if (state.phase === "finished") renderEnd();
}

/** Play sounds and show the guide based on what changed between states. */
function reactToStateChange(prev) {
  // Sounds for new log events (skip the initial backlog when joining)
  if (prev) {
    // The server caps the log at 30 lines, so anchor on the previous last line
    // instead of comparing lengths.
    const lastSeen = prev.log[prev.log.length - 1];
    const idx = lastSeen == null ? -1 : state.log.lastIndexOf(lastSeen);
    const newLines = idx === -1 ? state.log : state.log.slice(idx + 1);
    const myName = state.players.find((p) => p.seat === state.youSeat)?.name;
    for (const line of newLines) {
      if (line.includes("wins!")) {
        myName && line.includes(myName) ? sound.win() : sound.lose();
      } else if (line.includes(" played ")) sound.cardPlay();
      else if (line.includes(" passed")) sound.pass();
    }
  }

  // "Your turn" chime on the transition into my turn
  const myTurn = state.phase === "playing" && state.turnSeat === state.youSeat;
  if (myTurn && !prevMyTurn) sound.yourTurn();
  prevMyTurn = myTurn;
  if (prev?.turnSeat !== state.turnSeat) lastTickSecond = null;

  // Play the gather → shuffle → deal cinematic when a new game begins
  if (state.phase === "playing" && prev?.phase !== "playing") {
    playDealCinematic();
  }
  if (state.phase !== "finished") confettiDone = false;
}

/** Full-screen sequence: card backs fly to the center, get riffle-shuffled, then dealt to each player. */
async function playDealCinematic() {
  if (cinematicRunning) return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    dealAnimation = false;
    finishCinematic();
    return;
  }
  cinematicRunning = true;
  renderGame(); // draw the table with the hand still face-down (hidden)
  $("screen-game").classList.add("dealing"); // fades out the center text/banner underneath

  const layer = document.createElement("div");
  layer.id = "cinematic";
  document.body.appendChild(layer);

  const N = 20;
  const cx = innerWidth / 2 - 29;
  const cy = innerHeight / 2 - 42;
  const stackPos = (i) => `translate(${cx + i * 0.4}px, ${cy - i * 0.7}px) rotate(${i % 2 ? 2 : -2}deg)`;

  // Cards start scattered around the edges of the screen
  const cards = [];
  for (let i = 0; i < N; i++) {
    const el = document.createElement("div");
    el.className = "cardback";
    const angle = (i / N) * Math.PI * 2;
    const sx = cx + Math.cos(angle) * innerWidth * 0.65;
    const sy = cy + Math.sin(angle) * innerHeight * 0.65;
    el.style.transform = `translate(${sx}px, ${sy}px) rotate(${Math.floor(Math.random() * 360)}deg)`;
    el.style.opacity = "0";
    layer.appendChild(el);
    cards.push(el);
  }
  await nextFrame();

  // Phase 1: gather into one stack
  sound.gather();
  cards.forEach((el, i) => {
    el.style.transition = `transform .55s cubic-bezier(.25,.9,.35,1) ${i * 20}ms, opacity .35s ease ${i * 20}ms`;
    el.style.opacity = "1";
    el.style.transform = stackPos(i);
  });
  await wait(550 + N * 20 + 120);

  // Phase 2: riffle shuffle — cut the deck into two halves, then interleave
  // the cards back one by one (twice)
  for (let r = 0; r < 2; r++) {
    sound.riffle();
    cards.forEach((el, i) => {
      const half = i < N / 2 ? -1 : 1;
      el.style.transition = `transform .26s cubic-bezier(.4,.1,.3,1) ${(i % (N / 2)) * 8}ms`;
      el.style.transform =
        `translate(${cx + half * 64}px, ${cy - i * 0.7 + half * 5}px) rotate(${half * 8}deg)`;
    });
    await wait(260 + (N / 2) * 8 + 60);
    cards.forEach((el, i) => {
      el.style.transition = `transform .3s cubic-bezier(.2,.8,.3,1) ${i * 12}ms`;
      el.style.transform = stackPos(i);
    });
    await wait(300 + N * 12 + 60);
  }

  // Phase 3: deal round-robin to every player's spot on the table
  const targets = [];
  const me = document.querySelector("#screen-game .me");
  if (me) {
    const r = me.getBoundingClientRect();
    targets.push({ x: r.left + r.width / 2 - 29, y: r.top + 10 });
  }
  document.querySelectorAll("#opponents .opp").forEach((o) => {
    const r = o.getBoundingClientRect();
    targets.push({ x: r.left + r.width / 2 - 29, y: r.top + r.height / 2 - 42 });
  });
  if (targets.length === 0) targets.push({ x: cx, y: innerHeight - 120 });

  cards.forEach((el, i) => {
    const t = targets[i % targets.length];
    el.style.transition = `transform .45s cubic-bezier(.3,.7,.35,1) ${i * 55}ms, opacity .25s ease ${i * 55 + 250}ms`;
    el.style.transform = `translate(${t.x}px, ${t.y}px) rotate(${Math.floor(Math.random() * 16 - 8)}deg) scale(.72)`;
    el.style.opacity = "0";
    setTimeout(() => sound.dealOne(), i * 55);
  });
  await wait(450 + N * 55 + 150);

  layer.remove();
  cinematicRunning = false;
  dealAnimation = true;
  finishCinematic();
}

function finishCinematic() {
  $("screen-game").classList.remove("dealing"); // center text/banner fades back in
  if (state?.phase === "playing") renderGame();
  if (!localStorage.getItem("capsa_seen_guide")) {
    localStorage.setItem("capsa_seen_guide", "1");
    $("guide").classList.remove("hidden");
  }
}

function throwConfetti() {
  const colors = ["#d9a441", "#e74c3c", "#3498db", "#2ecc71", "#f1c40f", "#9b59b6", "#ffffff"];
  for (let i = 0; i < 90; i++) {
    const piece = document.createElement("div");
    piece.className = "confetti";
    piece.style.left = Math.random() * 100 + "vw";
    piece.style.background = colors[i % colors.length];
    piece.style.animationDuration = 2.4 + Math.random() * 2.2 + "s";
    piece.style.animationDelay = Math.random() * 1.4 + "s";
    piece.style.transform = `scale(${0.6 + Math.random() * 0.8})`;
    document.body.appendChild(piece);
    setTimeout(() => piece.remove(), 6500);
  }
}

// ---- Turn countdown ----
const TURN_MS = 30000; // keep in sync with the server
let lastTickSecond = null;
setInterval(() => {
  if (!state || state.phase !== "playing" || state.turnDeadline == null) return;
  const remainMs = Math.max(0, state.turnDeadline - Date.now());
  const remain = Math.ceil(remainMs / 1000);
  for (const el of document.querySelectorAll(".timer[data-live]")) {
    el.textContent = `⏱ ${remain}s`;
    el.classList.toggle("low", remain <= 10);
  }
  const bar = $("timer-bar");
  bar.style.width = `${(remainMs / TURN_MS) * 100}%`;
  bar.classList.toggle("low", remain <= 10);
  // Soft tick in the last 5 seconds of MY turn
  if (state.turnSeat === state.youSeat && remain <= 5 && remain > 0 && remain !== lastTickSecond) {
    sound.tick();
    lastTickSecond = remain;
  }
}, 250);

function renderLobby() {
  show("screen-lobby");
  $("btn-quit").classList.add("hidden");
  $("lobby-code").textContent = roomCode;
  const list = $("lobby-players");
  list.innerHTML = "";
  for (const p of state.players) {
    const li = document.createElement("li");
    li.innerHTML = `<span>${escapeHtml(p.name)}${p.seat === state.youSeat ? " (you)" : ""}</span>
      <span>${p.isHost ? "👑 host" : ""}${p.connected ? "" : " ⚠️ offline"}</span>`;
    list.appendChild(li);
  }
  $("btn-start").classList.toggle("hidden", !state.isHost);
  $("btn-start").disabled = state.players.length < 2;
  $("lobby-hint").textContent = state.isHost
    ? (state.players.length < 2 ? "Waiting for players… (2–4 can play)" : "Ready when you are!")
    : "Waiting for the host to start…";
}

function renderGame() {
  show("screen-game");
  selectedPrune();

  // Opponents
  const opp = $("opponents");
  opp.innerHTML = "";
  for (const p of state.players) {
    if (p.seat === state.youSeat) continue;
    const div = document.createElement("div");
    div.className = "opp" + (p.seat === state.turnSeat ? " turn" : "") + (p.connected ? "" : " disconnected");
    if (p.left) div.classList.add("quit");
    const isTurn = p.seat === state.turnSeat && !p.left;
    const backs = Array.from({ length: Math.min(p.cardCount, 13) }, () => "<i></i>").join("");
    div.innerHTML = `
      <div class="avatar">${escapeHtml(p.name.charAt(0).toUpperCase())}</div>
      <div class="opp-name">${escapeHtml(p.name)}</div>
      <div class="mini-cards">${backs}<span class="mini-count">${p.cardCount}</span></div>
      ${isTurn ? '<div class="timer" data-live></div>' : ""}
      <div class="opp-flag">${p.left ? "quit" : p.passed ? "passed" : ""}${!p.left && !p.connected ? " · offline" : ""}</div>`;
    opp.appendChild(div);
  }

  // Pile — only replay the pop-in animation when the pile actually changed
  const pile = $("pile");
  const pileKey = state.pile ? state.pile.cards.join(",") : "";
  pile.classList.toggle("fresh", pileKey !== lastPileKey);
  lastPileKey = pileKey;
  pile.innerHTML = "";
  if (state.pile) {
    for (const c of state.pile.cards) pile.appendChild(cardEl(c, false));
  } else {
    pile.innerHTML = `<span class="pile-empty">New trick — play any combination</span>`;
  }

  // Turn banner
  const myTurn = state.turnSeat === state.youSeat;
  const banner = $("turn-banner");
  banner.classList.toggle("yours", myTurn);
  let bannerText;
  if (myTurn) {
    bannerText = state.requiredCard != null
      ? `Your turn — first play must include ${RANKS[rankOf(state.requiredCard)]}${SUITS[suitOf(state.requiredCard)]}`
      : "Your turn";
  } else {
    const cur = state.players.find((p) => p.seat === state.turnSeat);
    bannerText = `Waiting for ${cur ? cur.name : "…"}`;
  }
  banner.innerHTML = `${escapeHtml(bannerText)} <span class="timer" data-live></span>`;

  // Hand — kept hidden while the shuffle cinematic plays, then dealt with a stagger
  const hand = $("hand");
  hand.classList.toggle("dealing", dealAnimation);
  hand.innerHTML = "";
  if (!cinematicRunning) {
    state.hand.forEach((c, i) => {
      const el = cardEl(c, myTurn);
      if (dealAnimation) el.style.animationDelay = `${i * 0.05}s`;
      hand.appendChild(el);
    });
  }
  dealAnimation = false;

  $("btn-play").disabled = !myTurn || cinematicRunning;
  $("btn-pass").disabled = !myTurn || !state.pile || cinematicRunning;
  $("btn-quit").classList.remove("hidden");

  renderLog();
}

function renderEnd() {
  show("screen-end");
  $("btn-quit").classList.remove("hidden");
  if (!confettiDone) {
    confettiDone = true;
    throwConfetti();
  }
  const myName = state.players.find((p) => p.seat === state.youSeat)?.name;
  $("end-title").textContent = myName && state.standings[0] === myName ? "🏆 You Win!" : "Game Over";
  const ol = $("standings");
  ol.innerHTML = "";
  state.standings.forEach((name) => {
    const li = document.createElement("li");
    li.textContent = name;
    ol.appendChild(li);
  });
  $("btn-rematch").classList.toggle("hidden", !state.isHost);
  $("end-hint").textContent = state.isHost ? "" : "Waiting for the host to start a rematch…";
}

function renderLog() {
  const log = $("log");
  log.innerHTML = state.log.map((l) => `<div>${escapeHtml(l)}</div>`).join("");
  log.scrollTop = log.scrollHeight;
}

function selectedPrune() {
  for (const c of [...selected]) if (!state.hand.includes(c)) selected.delete(c);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

// ---- Events ----

$("btn-create").onclick = async () => {
  if (!requireName()) return;
  try {
    const res = await fetch("/api/rooms", { method: "POST" });
    const { code } = await res.json();
    location.hash = code;
    connect(code);
  } catch {
    toast("Could not create room — check your connection");
  }
};

$("btn-join").onclick = () => {
  if (!requireName()) return;
  const code = $("code-input").value.trim().toUpperCase();
  if (code.length < 4) return toast("Enter the 4-letter room code");
  location.hash = code;
  connect(code);
};

$("btn-copy").onclick = () => {
  navigator.clipboard.writeText(`${location.origin}/#${roomCode}`);
  toast("Link copied!");
};

$("btn-start").onclick = () => send({ type: "start" });
$("btn-leave").onclick = () => {
  send({ type: "quit" });
  localStorage.removeItem(tokenKey());
  leaveRoom();
};
$("btn-quit").onclick = () => {
  if (state && state.phase === "playing" &&
      !window.confirm("Quit this game? You'll forfeit your seat and the others keep playing.")) {
    return;
  }
  send({ type: "quit" });
  localStorage.removeItem(tokenKey());
  leaveRoom();
};
$("btn-rematch").onclick = () => send({ type: "rematch" });
$("btn-pass").onclick = () => { selected.clear(); send({ type: "pass" }); };

$("btn-play").onclick = () => {
  if (selected.size === 0) return toast("Select cards first");
  send({ type: "play", cards: [...selected].sort((a, b) => a - b) });
  selected.clear();
};

$("btn-sort").onclick = () => { if (state) { state.hand.sort((a, b) => a - b); renderGame(); } };

$("btn-guide").onclick = () => $("guide").classList.remove("hidden");
$("btn-guide-close").onclick = () => $("guide").classList.add("hidden");
$("guide").onclick = (e) => { if (e.target === $("guide")) $("guide").classList.add("hidden"); };
$("btn-sound").onclick = toggleMute;
$("btn-sound").textContent = sound.muted ? "🔇" : "🔊";
// Browsers require a user gesture before audio can start.
document.addEventListener("click", () => { if (!sound.muted) sound.ensure(); }, { once: true });

function requireName() {
  const name = $("name-input").value.trim();
  if (!name) { toast("Please enter your name first"); return false; }
  localStorage.setItem("capsa_name", name);
  return true;
}

// ---- Guide content (built once, uses real mini-card graphics) ----

function miniCardHtml(rank, suit) {
  const color = suit === 0 || suit === 2 ? "red" : "black";
  return `<span class="mini-card ${color}"><span>${rank}</span><span class="ms">${SUITS[suit]}</span></span>`;
}

function buildGuide() {
  $("guide-ranks").innerHTML =
    RANKS.map((r, i) => `<span class="rank-chip" style="--p:${(i / 12).toFixed(2)}">${r}</span>`).join("") +
    '<span class="arrow">low → high</span>';

  $("guide-suits").innerHTML = [0, 1, 2, 3]
    .map((s) => `<span class="suit-chip ${s === 0 || s === 2 ? "red" : "black"}">${SUITS[s]}</span>`)
    .join('<span class="suit-lt">&lt;</span>');

  const combos = [
    ["Single", "Any one card", [["7", 2]]],
    ["Pair", "Two cards of the same rank", [["9", 1], ["9", 3]]],
    ["Triple", "Three cards of the same rank", [["J", 0], ["J", 2], ["J", 3]]],
    "divider",
    ["Straight", "5 ranks in a row — no 2s allowed", [["4", 0], ["5", 1], ["6", 2], ["7", 3], ["8", 0]], 1],
    ["Flush", "5 cards of the same suit", [["3", 2], ["6", 2], ["9", 2], ["Q", 2], ["A", 2]], 2],
    ["Full House", "Triple + pair — the triple decides strength", [["8", 0], ["8", 1], ["8", 2], ["K", 0], ["K", 3]], 3],
    ["Four of a Kind", "Four of the same rank + any card", [["10", 0], ["10", 1], ["10", 2], ["10", 3], ["3", 0]], 4],
    ["Straight Flush", "A straight in a single suit — the boss", [["5", 3], ["6", 3], ["7", 3], ["8", 3], ["9", 3]], 5],
  ];

  $("guide-combos").innerHTML = combos
    .map((c) => {
      if (c === "divider") return '<div class="combo-divider">Five-card hands · weakest → strongest</div>';
      const [name, desc, cards, strength] = c;
      const badge = strength
        ? `<span class="strength" style="--p:${((strength - 1) / 4).toFixed(2)}">${strength}</span>`
        : "";
      return `<div class="combo-row">
        <div class="combo-name">${badge}${name}</div>
        <div class="combo-desc">${desc}</div>
        <div class="combo-cards">${cards.map(([r, s]) => miniCardHtml(r, s)).join("")}</div>
      </div>`;
    })
    .join("");
}
buildGuide();

// ---- Init ----

$("name-input").value = localStorage.getItem("capsa_name") || "";
const hashCode = location.hash.replace("#", "").trim();
if (hashCode.length >= 4) {
  $("code-input").value = hashCode.toUpperCase();
  if ($("name-input").value) connect(hashCode);
}
