/* =========================================================================
   Cheat / Bluff (3-6). The whole deck is dealt out. On your turn you place
   1-4 cards face down and CLAIM they are the current rank (ranks ascend
   A,2,3,...,K,A...). You may be lying. Before the next play, anyone else may
   call "Cheat!": the last play is revealed — if it was a lie the player takes
   the pile, otherwise the challenger does. First to empty their hand wins.

   lobby.cheat = { phase:'play'|'over', order, turn, hands:{cid:[codes]},
                   pile:[codes], rankIndex, lastPlay:{cid,cards,claimRank},
                   pendingWinner, reveal, log, winner }
   ========================================================================= */
const { makeDeck, shuffle } = require("./poker");
const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K"];
const RNAME = { A: "Aces", T: "10s", J: "Jacks", Q: "Queens", K: "Kings" };
const rankPlural = (r) => RNAME[r] || r + "s";
const rankOf = (c) => c.slice(0, -1);
const seated = (lobby) => lobby.order.filter((cid) => { const p = lobby.players.get(cid); return p && p.connected; });
const nameOf = (lobby, cid) => { const p = lobby.players.get(cid); return p ? p.name : "?"; };
function logPush(g, m) { g.log.push(m); if (g.log.length > 6) g.log.shift(); }

function startGame(lobby) {
  const seats = seated(lobby);
  if (seats.length < 3) return { error: "Cheat needs at least 3 players." };
  const deck = shuffle(makeDeck());
  const g = { phase: "play", order: seats, turn: seats[0], hands: {}, pile: [], rankIndex: 0, lastPlay: null, pendingWinner: null, reveal: null, log: [], winner: null };
  for (const cid of seats) g.hands[cid] = [];
  let i = 0; for (const c of deck) { g.hands[seats[i % seats.length]].push(c); i++; }
  lobby.cheat = g;
  logPush(g, "Cards dealt. Claim " + rankPlural(RANKS[0]) + " to start.");
  return { ok: true };
}
const reqRank = (g) => RANKS[g.rankIndex % 13];
function advanceTurn(g) { const i = g.order.indexOf(g.turn); g.turn = g.order[(i + 1) % g.order.length]; }

function play(lobby, cid, cards) {
  const g = lobby.cheat;
  if (!g || g.phase !== "play") return { error: "No game." };
  if (g.turn !== cid) return { error: "Not your turn." };
  if (g.pendingWinner) { finalizeWin(lobby, g); return { ok: true }; } // window closed -> previous emptier wins
  cards = Array.isArray(cards) ? cards : [];
  if (cards.length < 1 || cards.length > 4) return { error: "Play 1 to 4 cards." };
  const hand = g.hands[cid];
  if (!cards.every((c) => hand.includes(c))) return { error: "You don't hold those cards." };
  const claim = reqRank(g);
  g.hands[cid] = hand.filter((c) => !cards.includes(c));
  g.pile.push(...cards);
  g.lastPlay = { cid, cards: cards.slice(), claimRank: claim };
  g.reveal = null;
  logPush(g, nameOf(lobby, cid) + " plays " + cards.length + ", claims " + rankPlural(claim) + ".");
  g.rankIndex++;
  if (g.hands[cid].length === 0) g.pendingWinner = cid; // wins if not successfully challenged
  advanceTurn(g);
  return { ok: true };
}

function challenge(lobby, cid) {
  const g = lobby.cheat;
  if (!g || g.phase !== "play") return { error: "No game." };
  if (!g.lastPlay) return { error: "Nothing to challenge." };
  if (g.lastPlay.cid === cid) return { error: "You can't challenge your own play." };
  const lp = g.lastPlay;
  const truthful = lp.cards.every((c) => rankOf(c) === lp.claimRank);
  const loser = truthful ? cid : lp.cid;
  const taken = g.pile.slice();
  g.hands[loser].push(...taken);
  g.reveal = { by: nameOf(lobby, cid), player: nameOf(lobby, lp.cid), cards: lp.cards.slice(), truthful, claim: lp.claimRank, taken: taken.length, loser };
  logPush(g, nameOf(lobby, cid) + " calls Cheat! " + nameOf(lobby, lp.cid) + (truthful ? " was honest \u2014 " + nameOf(lobby, cid) : " was lying \u2014 they") + " take " + taken.length + " cards.");
  g.pile = [];
  if (truthful && g.pendingWinner === lp.cid) { finalizeWin(lobby, g); return { ok: true }; }
  if (loser === lp.cid) g.pendingWinner = null; // they picked up, no longer empty
  g.lastPlay = null;
  // turn continues from where it was (next after the player who just played)
  return { ok: true };
}

function finalizeWin(lobby, g) {
  g.phase = "over"; g.winner = g.pendingWinner;
  logPush(g, nameOf(lobby, g.winner) + " empties their hand \u2014 wins!");
}

function removePlayer(lobby, cid) {
  const g = lobby.cheat; if (!g || g.phase !== "play") return;
  if (!g.hands[cid]) return;
  g.pile.push(...g.hands[cid]); delete g.hands[cid];
  const wasTurn = g.turn === cid, idx = g.order.indexOf(cid);
  if (g.lastPlay && g.lastPlay.cid === cid) g.lastPlay = null;
  if (g.pendingWinner === cid) g.pendingWinner = null;
  g.order = g.order.filter((x) => x !== cid);
  if (g.order.length < 2) { g.phase = "over"; g.winner = g.order[0] || null; return; }
  if (wasTurn) g.turn = g.order[idx % g.order.length];
}
function skipTurn(lobby, cid) { const g = lobby.cheat; if (g && g.phase === "play" && g.turn === cid) advanceTurn(g); }

module.exports = { startGame, play, challenge, removePlayer, skipTurn, reqRank, rankPlural };
