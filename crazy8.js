/* =========================================================================
   Crazy Eights (2-6). Match the top card's rank or the active suit, or play an
   8 (wild) and nominate a suit. Can't play -> draw one, then play it or pass.
   First to empty their hand wins.

   lobby.c8 = { phase:'play'|'over', order, turn, hands:{cid:[]}, stock:[],
                discard:[codes], suit, drew:bool, log:[], winner }
   ========================================================================= */
const { makeDeck, shuffle } = require("./poker");
const rankOf = (c) => c.slice(0, -1);
const suitOf = (c) => c.slice(-1);
const seated = (lobby) => lobby.order.filter((cid) => { const p = lobby.players.get(cid); return p && p.connected; });
const nameOf = (lobby, cid) => { const p = lobby.players.get(cid); return p ? p.name : "?"; };
function logPush(g, m) { g.log.push(m); if (g.log.length > 6) g.log.shift(); }

function startGame(lobby) {
  const seats = seated(lobby);
  if (seats.length < 2) return { error: "Crazy Eights needs at least 2 players." };
  const deck = shuffle(makeDeck());
  const g = { phase: "play", order: seats, turn: seats[0], hands: {}, stock: deck, discard: [], suit: null, drew: false, log: [], winner: null };
  const handSize = seats.length <= 2 ? 7 : 5;
  for (const cid of seats) g.hands[cid] = [];
  for (let i = 0; i < handSize; i++) for (const cid of seats) g.hands[cid].push(g.stock.pop());
  // first non-8 to the discard
  let top = g.stock.pop();
  while (rankOf(top) === "8" && g.stock.length) { g.stock.unshift(top); top = g.stock.pop(); }
  g.discard.push(top); g.suit = suitOf(top);
  lobby.c8 = g;
  logPush(g, "Start card: " + top + ". " + nameOf(lobby, seats[0]) + " to play.");
  return { ok: true };
}

const top = (g) => g.discard[g.discard.length - 1];
function playable(g, card) {
  return rankOf(card) === "8" || suitOf(card) === g.suit || rankOf(card) === rankOf(top(g));
}
function hasPlayable(g, cid) { return g.hands[cid].some((c) => playable(g, c)); }
function reshuffleIfNeeded(g) {
  if (g.stock.length === 0 && g.discard.length > 1) {
    const keep = g.discard.pop();
    g.stock = shuffle(g.discard); g.discard = [keep];
  }
}
function advanceTurn(g) {
  const i = g.order.indexOf(g.turn);
  g.turn = g.order[(i + 1) % g.order.length];
  g.drew = false;
}

function play(lobby, cid, card, chosenSuit) {
  const g = lobby.c8;
  if (!g || g.phase !== "play") return { error: "No game." };
  if (g.turn !== cid) return { error: "Not your turn." };
  const hand = g.hands[cid];
  if (!hand.includes(card)) return { error: "You don't have that card." };
  if (!playable(g, card)) return { error: "That card doesn't match." };
  g.hands[cid] = hand.filter((c) => c !== card);
  g.discard.push(card);
  if (rankOf(card) === "8") {
    const s = String(chosenSuit || "").toUpperCase();
    g.suit = ["S", "H", "D", "C"].includes(s) ? s : suitOf(card);
    logPush(g, nameOf(lobby, cid) + " played an 8 \u2014 suit is now " + g.suit + ".");
  } else {
    g.suit = suitOf(card);
    logPush(g, nameOf(lobby, cid) + " played " + card + ".");
  }
  if (g.hands[cid].length === 0) { g.phase = "over"; g.winner = cid; logPush(g, nameOf(lobby, cid) + " wins!"); return { ok: true }; }
  advanceTurn(g);
  return { ok: true };
}

function draw(lobby, cid) {
  const g = lobby.c8;
  if (!g || g.phase !== "play") return { error: "No game." };
  if (g.turn !== cid) return { error: "Not your turn." };
  if (g.drew) return { error: "You've already drawn \u2014 play or pass." };
  reshuffleIfNeeded(g);
  if (!g.stock.length) { g.drew = true; logPush(g, nameOf(lobby, cid) + " can't draw \u2014 pile empty."); return { ok: true }; }
  const c = g.stock.pop();
  g.hands[cid].push(c);
  g.drew = true;
  logPush(g, nameOf(lobby, cid) + " drew a card.");
  return { ok: true };
}

function pass(lobby, cid) {
  const g = lobby.c8;
  if (!g || g.phase !== "play") return { error: "No game." };
  if (g.turn !== cid) return { error: "Not your turn." };
  if (!g.drew) return { error: "Draw a card before passing." };
  logPush(g, nameOf(lobby, cid) + " passed.");
  advanceTurn(g);
  return { ok: true };
}

function removePlayer(lobby, cid) {
  const g = lobby.c8; if (!g || g.phase !== "play") return;
  if (!g.hands[cid]) return;
  g.stock.push(...g.hands[cid]); g.stock = shuffle(g.stock);
  delete g.hands[cid];
  const wasTurn = g.turn === cid, idx = g.order.indexOf(cid);
  g.order = g.order.filter((x) => x !== cid);
  if (g.order.length < 2) { g.phase = "over"; g.winner = g.order[0] || null; return; }
  if (wasTurn) { g.turn = g.order[idx % g.order.length]; g.drew = false; }
}
function skipTurn(lobby, cid) { const g = lobby.c8; if (g && g.phase === "play" && g.turn === cid) advanceTurn(g); }

module.exports = { startGame, play, draw, pass, removePlayer, skipTurn, playable };
