/* =========================================================================
   Big Two (4). Card order 3(low)..2(high), suit C<D<H<S. Holder of 3C leads
   and must include it. Play a higher combo of the SAME size (single/pair/triple
   /five-card) or pass. When everyone else passes, the last player leads anew.
   Five-card ranks: straight < flush < full house < four-of-a-kind < straight
   flush (straights use poker order, A high, wheel A-2-3-4-5). First out wins.

   lobby.bigtwo = { phase:'play'|'over', order, turn, hands, current, lastPlayer,
                    passed, firstPlay, log, winner }
   ========================================================================= */
const { makeDeck, shuffle } = require("./poker");
const rankOf = (c) => c.slice(0, -1), suitOf = (c) => c.slice(-1);
const RIDX = { "3": 0, "4": 1, "5": 2, "6": 3, "7": 4, "8": 5, "9": 6, T: 7, J: 8, Q: 9, K: 10, A: 11, "2": 12 };
const SIDX = { C: 0, D: 1, H: 2, S: 3 };
const PVAL = { "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8, "9": 9, T: 10, J: 11, Q: 12, K: 13, A: 14 };
const cardVal = (c) => RIDX[rankOf(c)] * 4 + SIDX[suitOf(c)];
const seated = (lobby) => lobby.order.filter((cid) => { const p = lobby.players.get(cid); return p && p.connected; });
const nameOf = (lobby, cid) => { const p = lobby.players.get(cid); return p ? p.name : "?"; };
function logPush(g, m) { g.log.push(m); if (g.log.length > 6) g.log.shift(); }

function straightTop(cards) {
  const vals = [...new Set(cards.map((c) => PVAL[rankOf(c)]))].sort((a, b) => a - b);
  if (vals.length !== 5) return null;
  if (vals[4] - vals[0] === 4) return vals[4];
  if (vals[0] === 2 && vals[1] === 3 && vals[2] === 4 && vals[3] === 5 && vals[4] === 14) return 5; // wheel
  return null;
}
function topCardOfStraight(cards, top) {
  // the card whose poker value == top (for wheel, top=5)
  return cards.find((c) => PVAL[rankOf(c)] === top);
}
function comboType(cards) {
  const n = cards.length;
  if (n === 1) return { type: "single", len: 1, cat: 0, key: cardVal(cards[0]) };
  if (n === 2) return rankOf(cards[0]) === rankOf(cards[1]) ? { type: "pair", len: 2, cat: 0, key: Math.max(cardVal(cards[0]), cardVal(cards[1])) } : null;
  if (n === 3) return cards.every((c) => rankOf(c) === rankOf(cards[0])) ? { type: "triple", len: 3, cat: 0, key: RIDX[rankOf(cards[0])] } : null;
  if (n === 5) {
    const counts = {}; cards.forEach((c) => counts[rankOf(c)] = (counts[rankOf(c)] || 0) + 1);
    const flush = cards.every((c) => suitOf(c) === suitOf(cards[0]));
    const top = straightTop(cards);
    const sizes = Object.values(counts).sort((a, b) => b - a);
    if (top && flush) { const t = topCardOfStraight(cards, top); return { type: "straightflush", len: 5, cat: 4, key: top * 4 + SIDX[suitOf(t)] }; }
    if (sizes[0] === 4) { const quad = Object.keys(counts).find((r) => counts[r] === 4); return { type: "quads", len: 5, cat: 3, key: RIDX[quad] }; }
    if (sizes[0] === 3 && sizes[1] === 2) { const trip = Object.keys(counts).find((r) => counts[r] === 3); return { type: "fullhouse", len: 5, cat: 2, key: RIDX[trip] }; }
    if (flush) return { type: "flush", len: 5, cat: 1, key: Math.max(...cards.map(cardVal)) };
    if (top) { const t = topCardOfStraight(cards, top); return { type: "straight", len: 5, cat: 0, key: top * 4 + SIDX[suitOf(t)] }; }
    return null;
  }
  return null;
}
function beats(a, b) {
  if (!a) return false;
  if (!b) return true; // leading
  if (a.len !== b.len) return false;
  if (a.len === 5) return a.cat !== b.cat ? a.cat > b.cat : a.key > b.key;
  return a.key > b.key;
}

function startGame(lobby) {
  const seats = seated(lobby);
  if (seats.length !== 4) return { error: "Big Two needs exactly 4 players." };
  const deck = shuffle(makeDeck());
  const g = { phase: "play", order: seats, turn: null, hands: {}, current: null, currentCards: null, lastPlayer: null, passed: 0, firstPlay: true, log: [], winner: null };
  let i = 0; for (const c of seats) { g.hands[c] = deck.slice(i * 13, (i + 1) * 13); i++; }
  g.turn = seats.find((c) => g.hands[c].includes("3C"));
  lobby.bigtwo = g;
  logPush(g, nameOf(lobby, g.turn) + " leads (must include 3\u2663).");
  return { ok: true };
}
function advanceTurn(g) { const i = g.order.indexOf(g.turn); g.turn = g.order[(i + 1) % g.order.length]; }

function play(lobby, cid, cards) {
  const g = lobby.bigtwo; if (!g || g.phase !== "play") return { error: "No game." };
  if (g.turn !== cid) return { error: "Not your turn." };
  cards = Array.isArray(cards) ? cards : [];
  if (!cards.length || !cards.every((c) => g.hands[cid].includes(c))) return { error: "You don't hold those cards." };
  const combo = comboType(cards);
  if (!combo) return { error: "That's not a valid combination." };
  if (g.firstPlay && !cards.includes("3C")) return { error: "Your first play must include 3\u2663." };
  if (g.current && !beats(combo, g.current)) return { error: "That doesn't beat the current play." };
  g.hands[cid] = g.hands[cid].filter((c) => !cards.includes(c));
  g.current = combo; g.currentCards = cards.slice(); g.lastPlayer = cid; g.passed = 0; g.firstPlay = false;
  logPush(g, nameOf(lobby, cid) + " plays " + combo.type + " (" + cards.join(" ") + ").");
  if (g.hands[cid].length === 0) { g.phase = "over"; g.winner = cid; logPush(g, nameOf(lobby, cid) + " is out \u2014 wins!"); return { ok: true }; }
  advanceTurn(g);
  return { ok: true };
}
function pass(lobby, cid) {
  const g = lobby.bigtwo; if (!g || g.phase !== "play") return { error: "No game." };
  if (g.turn !== cid) return { error: "Not your turn." };
  if (!g.current) return { error: "You must lead \u2014 can't pass." };
  g.passed++;
  logPush(g, nameOf(lobby, cid) + " passes.");
  advanceTurn(g);
  if (g.passed >= g.order.length - 1) { g.current = null; g.currentCards = null; g.passed = 0; g.turn = g.lastPlayer; logPush(g, nameOf(lobby, g.lastPlayer) + " takes the lead."); }
  return { ok: true };
}
function removePlayer(lobby, cid) {
  const g = lobby.bigtwo; if (!g || g.phase !== "play") return;
  if (!g.hands[cid]) return;
  delete g.hands[cid];
  const wasTurn = g.turn === cid, idx = g.order.indexOf(cid);
  g.order = g.order.filter((x) => x !== cid);
  if (g.order.length < 2) { g.phase = "over"; g.winner = g.order[0] || null; return; }
  if (g.lastPlayer === cid) { g.current = null; g.currentCards = null; g.passed = 0; g.lastPlayer = g.order[idx % g.order.length]; }
  if (wasTurn) g.turn = g.order[idx % g.order.length];
}
function skipTurn(lobby, cid) {
  const g = lobby.bigtwo; if (!g || g.phase !== "play" || g.turn !== cid) return;
  if (g.current) { g.passed++; advanceTurn(g); if (g.passed >= g.order.length - 1) { g.current = null; g.currentCards = null; g.passed = 0; g.turn = g.lastPlayer; } }
  else advanceTurn(g);
}
module.exports = { startGame, play, pass, removePlayer, skipTurn, comboType, beats };
