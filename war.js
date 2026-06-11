/* =========================================================================
   War engine (2 players). Pure chance: each "Flip" resolves one battle.
   On a tie, players go to WAR (3 face-down + 1 face-up); higher face-up takes
   the pile. A player who runs out of cards loses.

   lobby.war = { phase:'play'|'over', order:[a,b], piles:{cid:[codes]},
                 table:{cid:[codes]}, log:[], winner }
   ========================================================================= */
const { makeDeck, shuffle } = require("./poker");
const RANK_VAL = { "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8, "9": 9, T: 10, J: 11, Q: 12, K: 13, A: 14 };
const val = (code) => RANK_VAL[code.slice(0, -1)];
const seated = (lobby) => lobby.order.filter((cid) => { const p = lobby.players.get(cid); return p && p.connected; });
const nameOf = (lobby, cid) => { const p = lobby.players.get(cid); return p ? p.name : "?"; };
function logPush(w, m) { w.log.push(m); if (w.log.length > 6) w.log.shift(); }

function startGame(lobby) {
  const seats = seated(lobby);
  if (seats.length < 2) return { error: "War needs exactly 2 players." };
  const order = seats.slice(0, 2);
  const deck = shuffle(makeDeck());
  const w = { phase: "play", order, piles: {}, lastBattle: null, log: [], winner: null };
  w.piles[order[0]] = deck.slice(0, 26);
  w.piles[order[1]] = deck.slice(26);
  lobby.war = w;
  logPush(w, "War! Tap Flip to battle.");
  return { ok: true };
}

function finalize(lobby, w, winner) {
  w.phase = "over"; w.winner = winner;
  logPush(w, nameOf(lobby, winner) + " wins the war!");
}

// resolve a single battle (including any wars)
function flip(lobby, cid) {
  const w = lobby.war;
  if (!w || w.phase !== "play") return { error: "No game." };
  const [a, b] = w.order;
  const ta = [], tb = [];
  let depth = 0, winner = null;
  while (true) {
    if (!w.piles[a].length) { winner = b; break; }
    if (!w.piles[b].length) { winner = a; break; }
    const ca = w.piles[a].shift(), cb = w.piles[b].shift();
    ta.push(ca); tb.push(cb);
    const va = val(ca), vb = val(cb);
    if (va !== vb) { winner = va > vb ? a : b; break; }
    depth++;
    logPush(w, "Tie on " + ca.slice(0, -1) + " \u2014 WAR!");
    for (let i = 0; i < 3; i++) {
      if (w.piles[a].length > 1) ta.push(w.piles[a].shift());
      if (w.piles[b].length > 1) tb.push(w.piles[b].shift());
    }
    if (!w.piles[a].length) { winner = b; break; }
    if (!w.piles[b].length) { winner = a; break; }
  }
  const spoils = [...ta, ...tb];
  for (const c of shuffle(spoils)) w.piles[winner].push(c);
  w.lastBattle = { a: ta, b: tb, winner, war: depth };
  logPush(w, nameOf(lobby, winner) + " takes " + spoils.length + " card" + (spoils.length === 1 ? "" : "s") + (depth ? " after a war!" : "."));
  if (!w.piles[a].length) finalize(lobby, w, b);
  else if (!w.piles[b].length) finalize(lobby, w, a);
  return { ok: true };
}

function onLeave(lobby, cid) {
  const w = lobby.war; if (!w || w.phase !== "play") return;
  const other = w.order.find((x) => x !== cid);
  if (other) finalize(lobby, w, other);
}

module.exports = { startGame, flip, onLeave };
