// Big Two (Capsa Banting) core game logic.
//
// Card encoding: value 0..51, rank = value >> 2, suit = value & 3.
// Ranks: 0=3, 1=4, ... 8=J? no: 0=3,1=4,2=5,3=6,4=7,5=8,6=9,7=10,8=J,9=Q,10=K,11=A,12=2
// Suits: 0=Diamonds, 1=Clubs, 2=Hearts, 3=Spades (Indonesian capsa order, low to high)
// A higher card value always beats a lower one for singles.

export const RANK_NAMES = ["3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A", "2"];
export const SUIT_NAMES = ["♦", "♣", "♥", "♠"];

export const rankOf = (c: number) => c >> 2;
export const suitOf = (c: number) => c & 3;
export const cardName = (c: number) => `${RANK_NAMES[rankOf(c)]}${SUIT_NAMES[suitOf(c)]}`;

export type ComboKind =
  | "single"
  | "pair"
  | "triple"
  | "straight"
  | "flush"
  | "fullhouse"
  | "four"
  | "straightflush";

export interface Combo {
  kind: ComboKind;
  cards: number[]; // sorted ascending
  size: 1 | 2 | 3 | 5;
  category: number; // for 5-card combos: straight 0 < flush 1 < fullhouse 2 < four 3 < straightflush 4
  strength: number; // tie-breaker within the same size+category
}

export function newDeck(): number[] {
  const deck = Array.from({ length: 52 }, (_, i) => i);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

export function deal(numPlayers: number): number[][] {
  const deck = newDeck();
  const hands: number[][] = [];
  for (let p = 0; p < numPlayers; p++) {
    hands.push(deck.slice(p * 13, (p + 1) * 13).sort((a, b) => a - b));
  }
  return hands;
}

/**
 * Identify the combo formed by the given cards, or null if invalid.
 * Straights use ranks 3..A only (no 2s), 5 consecutive ranks.
 */
export function identifyCombo(cardsIn: number[]): Combo | null {
  const cards = [...cardsIn].sort((a, b) => a - b);
  const n = cards.length;
  if (new Set(cards).size !== n) return null;
  if (cards.some((c) => c < 0 || c > 51)) return null;
  const ranks = cards.map(rankOf);
  const top = cards[n - 1];

  if (n === 1) {
    return { kind: "single", cards, size: 1, category: 0, strength: top };
  }
  if (n === 2) {
    if (ranks[0] !== ranks[1]) return null;
    return { kind: "pair", cards, size: 2, category: 0, strength: top };
  }
  if (n === 3) {
    if (ranks[0] !== ranks[1] || ranks[1] !== ranks[2]) return null;
    return { kind: "triple", cards, size: 3, category: 0, strength: ranks[0] };
  }
  if (n !== 5) return null;

  const isFlush = cards.every((c) => suitOf(c) === suitOf(cards[0]));
  const isStraight =
    ranks[4] <= 11 && // no 2s in straights; 10-J-Q-K-A is the highest
    ranks.every((r, i) => (i === 0 ? true : r === ranks[i - 1] + 1));

  // Count ranks for full house / four of a kind
  const counts = new Map<number, number>();
  for (const r of ranks) counts.set(r, (counts.get(r) ?? 0) + 1);
  const countVals = [...counts.values()].sort((a, b) => b - a);

  if (isStraight && isFlush) {
    return { kind: "straightflush", cards, size: 5, category: 4, strength: top };
  }
  if (countVals[0] === 4) {
    const quadRank = [...counts.entries()].find(([, v]) => v === 4)![0];
    return { kind: "four", cards, size: 5, category: 3, strength: quadRank };
  }
  if (countVals[0] === 3 && countVals[1] === 2) {
    const tripleRank = [...counts.entries()].find(([, v]) => v === 3)![0];
    return { kind: "fullhouse", cards, size: 5, category: 2, strength: tripleRank };
  }
  if (isFlush) {
    return { kind: "flush", cards, size: 5, category: 1, strength: top };
  }
  if (isStraight) {
    return { kind: "straight", cards, size: 5, category: 0, strength: top };
  }
  return null;
}

/** True if combo a beats combo b (b is the pile to beat). */
export function beats(a: Combo, b: Combo): boolean {
  if (a.size !== b.size) return false;
  if (a.category !== b.category) return a.category > b.category;
  return a.strength > b.strength;
}
