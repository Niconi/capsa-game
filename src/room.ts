import { DurableObject } from "cloudflare:workers";
import { identifyCombo, beats, deal, cardName, type Combo } from "./game";
import type { Env } from "./index";

interface Player {
  id: string; // secret token, known only to the owning client
  name: string;
  seat: number;
  hand: number[];
  connected: boolean;
  passed: boolean; // passed on the current trick — sits out until the trick is won
  left: boolean; // quit mid-game: seat stays (indexes must hold) but they are skipped
}

interface RoomState {
  created: boolean;
  phase: "lobby" | "playing" | "finished";
  players: Player[];
  hostId: string | null;
  turnSeat: number;
  pile: { combo: Combo; seat: number } | null;
  requiredCard: number | null; // the first play of a game must include this card
  standings: string[]; // players in the order they emptied their hand (plain names while playing)
  scores: Record<string, number>; // penalty points per player name, carried across rounds
  rounds: number; // rounds completed in this room
  log: string[];
  turnDeadline: number | null; // epoch ms; current player auto-moves at this time
  turnMs: number | null; // length of the current turn (shorter for a disconnected player)
}

const MAX_PLAYERS = 4;
const TURN_MS = 30_000;
const TURN_MS_OFFLINE = 8_000; // a player who dropped off doesn't hold up the table

function freshState(): RoomState {
  return {
    created: false,
    phase: "lobby",
    players: [],
    hostId: null,
    turnSeat: 0,
    pile: null,
    requiredCard: null,
    standings: [],
    scores: {},
    rounds: 0,
    log: [],
    turnDeadline: null,
    turnMs: null,
  };
}

export class GameRoom extends DurableObject<Env> {
  private state: RoomState = freshState();
  private loaded = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const saved = await ctx.storage.get<RoomState>("state");
      // Spread over a fresh state so a room stored by an older build picks up
      // any fields added since (scores, rounds, …) instead of seeing undefined.
      if (saved) this.state = { ...freshState(), ...saved };
      this.loaded = true;
    });
  }

  private async save() {
    await this.ctx.storage.put("state", this.state);
  }

  /** Called by the Worker when a room is created via POST /api/rooms. */
  async create(): Promise<void> {
    this.state.created = true;
    await this.save();
  }

  async exists(): Promise<boolean> {
    return this.state.created;
  }

  // ---- WebSocket lifecycle (hibernation API) ----

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }
    if (!this.state.created) {
      return new Response("Room not found", { status: 404 });
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    let msg: any;
    try {
      msg = JSON.parse(raw as string);
    } catch {
      return;
    }
    try {
      switch (msg.type) {
        case "join":
          await this.handleJoin(ws, msg);
          break;
        case "start":
          await this.handleStart(ws);
          break;
        case "play":
          await this.handlePlay(ws, msg);
          break;
        case "pass":
          await this.handlePass(ws);
          break;
        case "rematch":
          await this.handleRematch(ws);
          break;
        case "reset-scores":
          await this.handleResetScores(ws);
          break;
        case "quit":
          await this.handleQuit(ws);
          break;
      }
    } catch (err) {
      this.sendError(ws, err instanceof Error ? err.message : "Something went wrong");
    }
  }

  async webSocketClose(ws: WebSocket) {
    const player = this.playerOf(ws);
    if (player) {
      player.connected = this.socketsOf(player.id).length > 1;
      if (!player.connected) {
        // The host walked off: hand the room to whoever is still here, otherwise
        // nobody can start a game and the room is dead until they come back.
        if (player.id === this.state.hostId) this.reassignHost();
        // A departing non-host frees up their seat in the lobby (the old host is
        // a non-host now if we just moved the crown).
        if (this.state.phase === "lobby" && player.id !== this.state.hostId) {
          this.state.players = this.state.players.filter((p) => p.id !== player.id);
          this.reseat();
          this.state.log.push(`${player.name} left`);
        }
      }
      await this.save();
      this.broadcast();
    }
  }

  // ---- Message handlers ----

  private async handleJoin(ws: WebSocket, msg: { name?: string; token?: string }) {
    const token = typeof msg.token === "string" ? msg.token : "";
    const existing = this.state.players.find((p) => p.id === token && token !== "");

    if (existing) {
      // Reconnect: reattach this socket to the player.
      ws.serializeAttachment({ playerId: existing.id });
      existing.connected = true;
      if (msg.name && this.state.phase === "lobby") existing.name = sanitizeName(msg.name);
      // Back before their clock ran out: give them a full turn again.
      if (this.state.phase === "playing" && this.state.players[this.state.turnSeat]?.id === existing.id) {
        await this.armTurnTimer();
      }
      await this.save();
      this.broadcast();
      return;
    }

    if (this.state.phase !== "lobby") throw new Error("Game already in progress");
    if (this.state.players.length >= MAX_PLAYERS) throw new Error("Room is full");
    const name = sanitizeName(msg.name ?? "");
    if (!name) throw new Error("Please enter a name");
    if (this.state.players.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
      throw new Error("That name is already taken in this room");
    }

    const player: Player = {
      id: crypto.randomUUID(),
      name,
      seat: this.state.players.length,
      hand: [],
      connected: true,
      passed: false,
      left: false,
    };
    this.state.players.push(player);
    if (!this.state.hostId) this.state.hostId = player.id;
    ws.serializeAttachment({ playerId: player.id });
    ws.send(JSON.stringify({ type: "token", token: player.id }));
    this.state.log.push(`${player.name} joined`);
    await this.save();
    this.broadcast();
  }

  private async handleStart(ws: WebSocket) {
    const player = this.requirePlayer(ws);
    if (player.id !== this.state.hostId) throw new Error("Only the host can start the game");
    if (this.state.phase === "playing") throw new Error("Game already started");
    if (this.state.players.length < 2) throw new Error("Need at least 2 players");

    const hands = deal(this.state.players.length);
    let lowest = 52;
    let startSeat = 0;
    this.state.players.forEach((p, i) => {
      p.hand = hands[i];
      p.passed = false;
      if (hands[i][0] < lowest) {
        lowest = hands[i][0];
        startSeat = i;
      }
    });
    this.state.phase = "playing";
    this.state.pile = null;
    this.state.standings = [];
    this.state.requiredCard = lowest;
    this.state.turnSeat = startSeat;
    this.state.log = [
      `Round ${this.state.rounds + 1} — ${this.state.players[startSeat].name} leads with a combo containing ${cardName(lowest)}`,
    ];
    await this.armTurnTimer();
    await this.save();
    this.broadcast();
  }

  private async handlePlay(ws: WebSocket, msg: { cards?: number[] }) {
    const player = this.requirePlayer(ws);
    this.requireTurn(player);
    const cards: number[] = Array.isArray(msg.cards) ? msg.cards : [];
    await this.playCards(player, cards);
  }

  private async playCards(player: Player, cards: number[]) {
    if (!cards.every((c) => player.hand.includes(c))) {
      throw new Error("You can only play cards from your own hand");
    }
    const combo = identifyCombo(cards);
    if (!combo) throw new Error("Not a valid combination");

    if (this.state.requiredCard !== null && !cards.includes(this.state.requiredCard)) {
      throw new Error(`The first play must include ${cardName(this.state.requiredCard)}`);
    }
    if (this.state.pile) {
      if (combo.size !== this.state.pile.combo.size) {
        throw new Error(`You must play ${this.state.pile.combo.size} card(s) to beat the pile`);
      }
      if (!beats(combo, this.state.pile.combo)) {
        throw new Error("That doesn't beat the current pile");
      }
    }

    player.hand = player.hand.filter((c) => !cards.includes(c));
    this.state.requiredCard = null;
    this.state.pile = { combo, seat: player.seat };
    // Passes are NOT cleared here: a player who passed sits out the rest of the
    // trick, otherwise they could jump back in as soon as someone else plays.
    // advanceTurn() clears the flags when the trick is won.
    this.state.log.push(`${player.name} played ${combo.cards.map(cardName).join(" ")}`);

    if (player.hand.length === 0) {
      // Out of cards — out of the game. The rest keep playing for places, and
      // whoever is still holding cards when the dust settles loses.
      this.state.standings.push(player.name);
      this.state.log.push(
        `✅ ${player.name} finished — ${ordinal(this.state.standings.length)} out`,
      );
    }

    if (this.playersInPlay().length <= 1) {
      await this.finishGame();
    } else {
      this.advanceTurn();
      await this.armTurnTimer();
    }
    await this.save();
    this.broadcast();
  }

  private async handlePass(ws: WebSocket) {
    const player = this.requirePlayer(ws);
    this.requireTurn(player);
    if (!this.state.pile) throw new Error("You lead this trick — you must play");
    await this.passTurn(player);
  }

  private async passTurn(player: Player) {
    player.passed = true;
    this.state.log.push(`${player.name} passed`);
    this.advanceTurn();
    await this.armTurnTimer();
    await this.save();
    this.broadcast();
  }

  private async handleRematch(ws: WebSocket) {
    const player = this.requirePlayer(ws);
    if (this.state.phase !== "finished") throw new Error("Game is not finished");
    if (player.id !== this.state.hostId) throw new Error("Only the host can start a rematch");
    this.state.phase = "lobby";
    this.state.players = this.state.players.filter((p) => !p.left);
    this.reseat();
    this.state.players.forEach((p) => {
      p.hand = [];
      p.passed = false;
    });
    this.state.pile = null;
    this.state.standings = [];
    this.state.turnDeadline = null;
    this.state.turnMs = null;
    await this.ctx.storage.deleteAlarm();
    this.state.log.push("Back to lobby for a rematch");
    await this.save();
    this.broadcast();
  }

  private async handleResetScores(ws: WebSocket) {
    const player = this.requirePlayer(ws);
    if (player.id !== this.state.hostId) throw new Error("Only the host can reset the points");
    this.state.scores = {};
    this.state.rounds = 0;
    this.state.log.push("🧮 Points reset");
    await this.save();
    this.broadcast();
  }

  private async handleQuit(ws: WebSocket) {
    const player = this.requirePlayer(ws);
    if (this.state.phase !== "playing") {
      // Lobby / finished: free the seat entirely (host role is reassigned if needed)
      this.state.players = this.state.players.filter((p) => p.id !== player.id);
      this.reseat();
      this.state.log.push(`${player.name} left`);
    } else if (!player.left) {
      player.left = true;
      player.passed = true;
      // If the game hadn't started yet and they held the required opening card,
      // the next leader may open with anything.
      if (this.state.requiredCard !== null && player.hand.includes(this.state.requiredCard)) {
        this.state.requiredCard = null;
      }
      const abandoned = player.hand.length;
      player.hand = [];
      if (abandoned > 0) {
        this.addPenalty(player.name, abandoned);
        this.state.log.push(`🚪 ${player.name} quit with ${abandoned} card(s) left`);
      } else {
        this.state.log.push(`🚪 ${player.name} quit the game`);
      }

      if (this.playersInPlay().length <= 1) {
        await this.finishGame();
      } else if (this.state.players[this.state.turnSeat]?.id === player.id) {
        this.advanceTurn();
        await this.armTurnTimer();
      }
    }
    await this.save();
    this.broadcast();
  }

  // ---- Turn timer ----

  private async armTurnTimer() {
    // A player who dropped off gets a much shorter clock so one broken
    // connection can't stall the table for 30s every single turn.
    const current = this.state.players[this.state.turnSeat];
    const ms = current && !current.connected ? TURN_MS_OFFLINE : TURN_MS;
    this.state.turnMs = ms;
    this.state.turnDeadline = Date.now() + ms;
    await this.ctx.storage.setAlarm(this.state.turnDeadline);
  }

  /** Fires when the current player's time runs out: auto-pass, or auto-play the lowest card when leading. */
  async alarm(): Promise<void> {
    const s = this.state;
    if (s.phase !== "playing" || s.turnDeadline === null || Date.now() < s.turnDeadline) return;
    const player = s.players[s.turnSeat];
    if (!player || !this.inPlay(player)) {
      // Whoever is on the clock already left or went out — hand it to the next live seat.
      const next = this.seatInPlayAfter(s.turnSeat);
      if (next === null) return;
      s.turnSeat = next;
      await this.armTurnTimer();
      await this.save();
      this.broadcast();
      return;
    }
    s.log.push(`⏰ ${player.name} ran out of time`);
    if (s.pile) {
      await this.passTurn(player);
    } else {
      // Leading, so a pass is not allowed: play the lowest single
      // (when the required-card rule applies, its holder leads, so hand[0] satisfies it).
      await this.playCards(player, [player.hand[0]]);
    }
  }

  // ---- Game flow helpers ----

  /** A player is still in the game while they hold cards and haven't quit. */
  private inPlay(p: Player): boolean {
    return !p.left && p.hand.length > 0;
  }

  private playersInPlay(): Player[] {
    return this.state.players.filter((p) => this.inPlay(p));
  }

  /** Next seat after `from` whose player is still holding cards, or null. */
  private seatInPlayAfter(from: number): number | null {
    const n = this.state.players.length;
    for (let i = 1; i <= n; i++) {
      const idx = (from + i) % n;
      if (this.inPlay(this.state.players[idx])) return idx;
    }
    return null;
  }

  private advanceTurn() {
    const s = this.state;
    const n = s.players.length;
    // Next seat that still holds cards and hasn't passed on this trick.
    let next: number | null = null;
    for (let i = 1; i <= n; i++) {
      const idx = (s.turnSeat + i) % n;
      const p = s.players[idx];
      if (this.inPlay(p) && !p.passed) {
        next = idx;
        break;
      }
    }

    // The trick is won when play comes back around to the player who set the
    // pile — or when nobody still able to beat it is left (everyone else passed
    // or went out).
    if (s.pile && (next === null || next === s.pile.seat)) {
      const ownerSeat = s.pile.seat;
      const owner = s.players[ownerSeat];
      s.pile = null;
      s.players.forEach((p) => (p.passed = false));
      next = this.inPlay(owner) ? ownerSeat : this.seatInPlayAfter(ownerSeat);
      if (next !== null) {
        s.log.push(
          this.inPlay(owner)
            ? `${owner.name} won the trick and leads`
            : `${s.players[next].name} leads the next trick`,
        );
      }
    }

    // Nobody can act (everyone else is out): fall back to whoever still holds cards.
    if (next === null) next = this.seatInPlayAfter(s.turnSeat);
    if (next === null) return; // game over — finishGame() decides the loser
    s.turnSeat = next;
  }

  private async finishGame() {
    const s = this.state;
    s.phase = "finished";
    s.turnDeadline = null;
    s.pile = null;
    await this.ctx.storage.deleteAlarm();

    const finishers = [...s.standings]; // who went out, in order (winner is [0])
    const inPlay = this.playersInPlay();
    const quitters = s.players.filter((p) => p.left);
    const tail: string[] = [];

    if (inPlay.length === 1) {
      const last = inPlay[0];
      if (finishers.length === 0) {
        // Everyone else quit: the one still at the table takes the win.
        finishers.push(last.name);
      } else {
        // Last player left holding cards loses, and pays for every card left.
        tail.push(`${last.name} (${last.hand.length} left)`);
        this.addPenalty(last.name, last.hand.length);
        s.log.push(`❌ ${last.name} left holding ${last.hand.length} card(s)`);
      }
    }

    s.rounds += 1;
    s.standings = [...finishers, ...tail, ...quitters.map((p) => `${p.name} (quit)`)];
    if (finishers.length > 0) s.log.push(`🏆 ${finishers[0]} wins!`);
  }

  /** Capa scoring: every card still in hand when a round ends costs a point. */
  private addPenalty(name: string, points: number) {
    if (points <= 0) return;
    this.state.scores[name] = (this.state.scores[name] ?? 0) + points;
  }

  /** Move the host crown to a connected player (or any other player). */
  private reassignHost() {
    const others = this.state.players.filter((p) => p.id !== this.state.hostId);
    const next = others.find((p) => p.connected) ?? others[0];
    if (!next) return; // nobody else is here — keep the crown where it is
    const prev = this.state.players.find((p) => p.id === this.state.hostId);
    this.state.hostId = next.id;
    this.state.log.push(`👑 ${next.name} is now the host${prev ? ` — ${prev.name} disconnected` : ""}`);
  }

  private reseat() {
    this.state.players.forEach((p, i) => (p.seat = i));
    if (!this.state.players.some((p) => p.id === this.state.hostId)) {
      this.state.hostId = this.state.players[0]?.id ?? null;
    }
  }

  // ---- Plumbing ----

  private playerOf(ws: WebSocket): Player | undefined {
    const att = ws.deserializeAttachment() as { playerId?: string } | null;
    if (!att?.playerId) return undefined;
    return this.state.players.find((p) => p.id === att.playerId);
  }

  private requirePlayer(ws: WebSocket): Player {
    const p = this.playerOf(ws);
    if (!p) throw new Error("Join the room first");
    return p;
  }

  private requireTurn(player: Player) {
    if (this.state.phase !== "playing") throw new Error("The game hasn't started");
    if (this.state.players[this.state.turnSeat]?.id !== player.id) {
      throw new Error("It's not your turn");
    }
  }

  private socketsOf(playerId: string): WebSocket[] {
    return this.ctx.getWebSockets().filter((ws) => {
      const att = ws.deserializeAttachment() as { playerId?: string } | null;
      return att?.playerId === playerId;
    });
  }

  private sendError(ws: WebSocket, message: string) {
    try {
      ws.send(JSON.stringify({ type: "error", message }));
    } catch {}
  }

  /** Send each connected client a state view personalized to its player. */
  private broadcast() {
    const s = this.state;
    for (const ws of this.ctx.getWebSockets()) {
      const me = this.playerOf(ws);
      const view = {
        type: "state",
        phase: s.phase,
        youSeat: me?.seat ?? null,
        isHost: me != null && me.id === s.hostId,
        hand: me?.hand ?? [],
        turnSeat: s.turnSeat,
        turnDeadline: s.turnDeadline,
        turnMs: s.turnMs,
        requiredCard: s.requiredCard,
        pile: s.pile ? { cards: s.pile.combo.cards, kind: s.pile.combo.kind, seat: s.pile.seat } : null,
        players: s.players.map((p) => ({
          name: p.name,
          seat: p.seat,
          cardCount: p.hand.length,
          connected: p.connected,
          passed: p.passed,
          left: p.left,
          isHost: p.id === s.hostId,
        })),
        standings: s.standings,
        // During play: names of the players who already went out, in order.
        finishedOrder: s.phase === "playing" ? [...s.standings] : [],
        scores: s.scores,
        rounds: s.rounds,
        log: s.log.slice(-30),
      };
      try {
        ws.send(JSON.stringify(view));
      } catch {}
    }
  }
}

function ordinal(n: number): string {
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th";
  return `${n}${suffix}`;
}

function sanitizeName(raw: string): string {
  return raw.trim().slice(0, 20).replace(/[<>]/g, "");
}
