/* =========================================================================
   Spades (exactly 4, partnerships: seats 0&2 vs 1&3). Bid tricks (0 = nil),
   spades are trump, follow suit, spades can't be led until broken. Score to 500.
   Make your contract: +10/bid trick, +1 bag per overtrick; 10 bags -> -100.
   Miss it: -10/bid trick. Nil: +100 if you take none, -100 if you take any.

   lobby.spades = { phase:'bid'|'play'|'handover'|'over', order, hands, bids,
                    bidTurn, tricksWon, trick, leader, turn, spadesBroken, trickNo,
                    scores:{A,B}, bags:{A,B}, handNo, lastHand, locked, log, results }
   ========================================================================= */
const { makeDeck, shuffle } = require("./poker");
const RVAL = { "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8, "9": 9, T: 10, J: 11, Q: 12, K: 13, A: 14 };
const rankOf = (c) => c.slice(0, -1), suitOf = (c) => c.slice(-1);
const TRICK_MS = Number(process.env.SPADES_TRICK_MS) >= 0 ? Number(process.env.SPADES_TRICK_MS) : 1600;
const notify = (l) => { if (typeof l.notify === "function") l.notify(); };
const seated = (lobby) => lobby.order.filter((cid) => { const p = lobby.players.get(cid); return p && p.connected; });
const nameOf = (lobby, cid) => { const p = lobby.players.get(cid); return p ? p.name : "?"; };
function logPush(s, m) { s.log.push(m); if (s.log.length > 6) s.log.shift(); }

function startGame(lobby) {
  const seats = seated(lobby);
  if (seats.length !== 4) return { error: "Spades needs exactly 4 players." };
  const s = { phase: null, order: seats, hands: {}, bids: {}, bidTurn: null, tricksWon: {}, trick: [], leader: null, turn: null, spadesBroken: false, trickNo: 0, scores: { A: 0, B: 0 }, bags: { A: 0, B: 0 }, handNo: 0, lastHand: null, locked: false, _pending: null, log: [], results: null };
  lobby.spades = s;
  startHand(lobby, s);
  return { ok: true };
}
const teamOf = (s, cid) => (s.order.indexOf(cid) % 2 === 0 ? "A" : "B");
const teamName = (s, lobby, key) => s.order.filter((c) => teamOf(s, c) === key).map((c) => nameOf(lobby, c)).join(" & ");

function startHand(lobby, s) {
  const deck = shuffle(makeDeck());
  s.hands = {}; s.bids = {}; s.tricksWon = {}; s.trick = []; s.spadesBroken = false; s.trickNo = 0; s.locked = false; s._pending = null;
  let i = 0; for (const c of s.order) { s.hands[c] = deck.slice(i * 13, (i + 1) * 13); s.tricksWon[c] = 0; i++; }
  s.phase = "bid";
  s.bidTurn = s.order[(s.handNo + 1) % 4]; // left of dealer
  logPush(s, "Bidding \u2014 " + nameOf(lobby, s.bidTurn) + " starts.");
}
function bid(lobby, cid, n) {
  const s = lobby.spades; if (!s || s.phase !== "bid") return { error: "Not bidding." };
  if (s.bidTurn !== cid) return { error: "Not your turn to bid." };
  n = Math.max(0, Math.min(13, parseInt(n, 10)));
  if (Number.isNaN(n)) return { error: "Bad bid." };
  s.bids[cid] = n;
  logPush(s, nameOf(lobby, cid) + " bids " + (n === 0 ? "Nil" : n) + ".");
  const idx = s.order.indexOf(cid);
  const next = s.order[(idx + 1) % 4];
  if (Object.keys(s.bids).length === 4) beginPlay(lobby, s);
  else s.bidTurn = next;
  return { ok: true };
}
function beginPlay(lobby, s) {
  s.phase = "play"; s.trick = []; s.trickNo = 0;
  s.leader = s.order[(s.handNo + 1) % 4]; s.turn = s.leader;
  logPush(s, nameOf(lobby, s.leader) + " leads.");
}
function legalPlays(s, cid) {
  const hand = s.hands[cid];
  if (s.trick.length === 0) {
    if (!s.spadesBroken) { const non = hand.filter((c) => suitOf(c) !== "S"); if (non.length) return non; }
    return hand;
  }
  const led = suitOf(s.trick[0].card);
  const inSuit = hand.filter((c) => suitOf(c) === led);
  return inSuit.length ? inSuit : hand;
}
function playCard(lobby, cid, card) {
  const s = lobby.spades; if (!s || s.phase !== "play") return { error: "Not in play." };
  if (s.locked) return { error: "Hold on\u2026" };
  if (s.turn !== cid) return { error: "Not your turn." };
  if (!legalPlays(s, cid).includes(card)) return { error: "You can't play that card." };
  s.hands[cid] = s.hands[cid].filter((c) => c !== card);
  s.trick.push({ cid, card });
  if (suitOf(card) === "S") s.spadesBroken = true;
  if (s.trick.length < 4) { const i = s.order.indexOf(cid); s.turn = s.order[(i + 1) % 4]; return { ok: true }; }
  const led = suitOf(s.trick[0].card);
  const hasSpade = s.trick.some((t) => suitOf(t.card) === "S");
  const suit = hasSpade ? "S" : led;
  let win = s.trick.find((t) => suitOf(t.card) === suit);
  for (const t of s.trick) if (suitOf(t.card) === suit && RVAL[rankOf(t.card)] > RVAL[rankOf(win.card)]) win = t;
  const winner = win.cid;
  s._pending = { winner };
  logPush(s, nameOf(lobby, winner) + " wins the trick.");
  const finish = () => {
    s.tricksWon[winner]++; s.trick = []; s.leader = winner; s.turn = winner; s.trickNo++; s._pending = null; s.locked = false;
    if (s.trickNo === 13) endHand(lobby, s);
  };
  if (typeof lobby.notify === "function") { s.locked = true; setTimeout(() => { if (lobby.spades === s) { finish(); notify(lobby); } }, TRICK_MS); }
  else finish();
  return { ok: true };
}
function endHand(lobby, s) {
  const summary = [];
  for (const key of ["A", "B"]) {
    const members = s.order.filter((c) => teamOf(s, c) === key);
    const teamTricks = members.reduce((a, c) => a + s.tricksWon[c], 0);
    const nonNilBid = members.reduce((a, c) => a + (s.bids[c] > 0 ? s.bids[c] : 0), 0);
    let delta = 0;
    // nil bonuses
    for (const c of members) if (s.bids[c] === 0) delta += (s.tricksWon[c] === 0 ? 100 : -100);
    if (teamTricks >= nonNilBid) {
      const over = teamTricks - nonNilBid;
      delta += nonNilBid * 10 + over;
      s.bags[key] += over;
      if (s.bags[key] >= 10) { delta -= 100; s.bags[key] -= 10; }
    } else {
      delta -= nonNilBid * 10;
    }
    s.scores[key] += delta;
    summary.push({ key, name: teamName(s, lobby, key), bid: nonNilBid, tricks: teamTricks, delta, total: s.scores[key], bags: s.bags[key] });
  }
  s.handNo++;
  s.lastHand = summary;
  logPush(s, "Hand scored. " + summary.map((x) => x.name.split(" & ")[0] + "\u2026 " + (x.delta >= 0 ? "+" : "") + x.delta).join(", "));
  const max = Math.max(s.scores.A, s.scores.B);
  if (max >= 500 && s.scores.A !== s.scores.B) finalize(lobby, s);
  else { s.phase = "handover"; logPush(s, "Tap Next hand."); }
}
function nextHand(lobby) {
  const s = lobby.spades; if (!s || s.phase !== "handover") return { error: "Not between hands." };
  startHand(lobby, s); return { ok: true };
}
function finalize(lobby, s) {
  s.phase = "over";
  const winKey = s.scores.A > s.scores.B ? "A" : "B";
  s.results = { scores: s.scores, winners: s.order.filter((c) => teamOf(s, c) === winKey), winTeam: teamName(s, lobby, winKey), winScore: s.scores[winKey] };
  logPush(s, "Game over \u2014 " + teamName(s, lobby, winKey) + " win!");
}
function onLeave(lobby, cid) {
  const s = lobby.spades; if (!s || s.phase === "over") return;
  finalize(lobby, s);
}
module.exports = { startGame, bid, playCard, nextHand, onLeave, legalPlays, teamOf };
