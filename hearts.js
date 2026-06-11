/* =========================================================================
   Hearts (exactly 4). Pass 3 (left/right/across/hold rotation), 2C leads,
   follow suit, hearts can't be led until broken, no points on trick 1.
   Hearts = 1, Q-spades = 13. Shoot the moon (all 26) -> 0 for you, +26 others.
   Game ends when someone hits 100; lowest score wins.

   lobby.hearts = { phase:'pass'|'play'|'handover'|'over', order, hands, scores,
                    handScores, passDir, pass, passed, trick:[{cid,card}], leader,
                    turn, heartsBroken, trickNo, taken, lastHand, locked, log, results }
   ========================================================================= */
const { makeDeck, shuffle } = require("./poker");
const RVAL = { "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8, "9": 9, T: 10, J: 11, Q: 12, K: 13, A: 14 };
const rankOf = (c) => c.slice(0, -1), suitOf = (c) => c.slice(-1);
const PASS = ["left", "right", "across", "hold"];
const TRICK_MS = Number(process.env.HEARTS_TRICK_MS) >= 0 ? Number(process.env.HEARTS_TRICK_MS) : 1600;
const notify = (l) => { if (typeof l.notify === "function") l.notify(); };
const seated = (lobby) => lobby.order.filter((cid) => { const p = lobby.players.get(cid); return p && p.connected; });
const nameOf = (lobby, cid) => { const p = lobby.players.get(cid); return p ? p.name : "?"; };
function logPush(h, m) { h.log.push(m); if (h.log.length > 6) h.log.shift(); }
const points = (c) => suitOf(c) === "H" ? 1 : (c === "QS" ? 13 : 0);

function startGame(lobby) {
  const seats = seated(lobby);
  if (seats.length !== 4) return { error: "Hearts needs exactly 4 players." };
  const h = { phase: null, order: seats, hands: {}, scores: {}, handScores: {}, passDir: 0, pass: {}, passed: [], trick: [], leader: null, turn: null, heartsBroken: false, trickNo: 0, taken: {}, lastHand: null, locked: false, _pending: null, log: [], results: null };
  for (const c of seats) h.scores[c] = 0;
  lobby.hearts = h;
  startHand(lobby, h);
  return { ok: true };
}

function startHand(lobby, h) {
  const deck = shuffle(makeDeck());
  h.hands = {}; h.taken = {}; h.handScores = {}; h.pass = {}; h.passed = []; h.trick = []; h.heartsBroken = false; h.trickNo = 0; h.locked = false; h._pending = null;
  let i = 0; for (const c of h.order) { h.hands[c] = deck.slice(i * 13, (i + 1) * 13); h.taken[c] = []; h.handScores[c] = 0; i++; }
  const dir = PASS[h.passDir % 4];
  if (dir === "hold") beginPlay(lobby, h);
  else { h.phase = "pass"; logPush(h, "Pass 3 cards " + dir + "."); }
}
function passTarget(h, cid, dir) {
  const i = h.order.indexOf(cid);
  if (dir === "left") return h.order[(i + 1) % 4];
  if (dir === "right") return h.order[(i + 3) % 4];
  return h.order[(i + 2) % 4];
}
function selectPass(lobby, cid, cards) {
  const h = lobby.hearts; if (!h || h.phase !== "pass") return { error: "Not passing." };
  if (h.pass[cid]) return { error: "You've already passed." };
  cards = Array.isArray(cards) ? cards : [];
  if (cards.length !== 3) return { error: "Pass exactly 3 cards." };
  if (!cards.every((c) => h.hands[cid].includes(c))) return { error: "You don't hold those." };
  h.pass[cid] = cards.slice(); h.passed.push(cid);
  logPush(h, nameOf(lobby, cid) + " has passed.");
  if (h.passed.length === 4) {
    const dir = PASS[h.passDir % 4];
    for (const c of h.order) h.hands[c] = h.hands[c].filter((x) => !h.pass[c].includes(x));
    for (const c of h.order) h.hands[passTarget(h, c, dir)].push(...h.pass[c]);
    beginPlay(lobby, h);
  }
  return { ok: true };
}
function beginPlay(lobby, h) {
  h.phase = "play"; h.trick = []; h.trickNo = 0;
  const leader = h.order.find((c) => h.hands[c].includes("2C"));
  h.leader = leader; h.turn = leader;
  logPush(h, nameOf(lobby, leader) + " leads with 2\u2663.");
}
function legalPlays(h, cid) {
  const hand = h.hands[cid], first = h.trickNo === 0;
  if (h.trick.length === 0) {
    if (first) return hand.filter((c) => c === "2C");
    let opts = hand;
    if (!h.heartsBroken) { const non = hand.filter((c) => suitOf(c) !== "H"); if (non.length) opts = non; }
    return opts;
  }
  const led = suitOf(h.trick[0].card);
  const inSuit = hand.filter((c) => suitOf(c) === led);
  if (inSuit.length) return inSuit;
  let opts = hand;
  if (first) { const safe = hand.filter((c) => points(c) === 0); if (safe.length) opts = safe; }
  return opts;
}
function playCard(lobby, cid, card) {
  const h = lobby.hearts; if (!h || h.phase !== "play") return { error: "Not in play." };
  if (h.locked) return { error: "Hold on\u2026" };
  if (h.turn !== cid) return { error: "Not your turn." };
  if (!legalPlays(h, cid).includes(card)) return { error: "You can't play that card." };
  h.hands[cid] = h.hands[cid].filter((c) => c !== card);
  h.trick.push({ cid, card });
  if (suitOf(card) === "H") h.heartsBroken = true;
  if (h.trick.length < 4) { const i = h.order.indexOf(cid); h.turn = h.order[(i + 1) % 4]; return { ok: true }; }
  const led = suitOf(h.trick[0].card);
  let win = h.trick[0];
  for (const t of h.trick) if (suitOf(t.card) === led && RVAL[rankOf(t.card)] > RVAL[rankOf(win.card)]) win = t;
  const winner = win.cid, pts = h.trick.reduce((s, t) => s + points(t.card), 0);
  h._pending = { winner, pts };
  logPush(h, nameOf(lobby, winner) + " takes the trick" + (pts ? " (" + pts + " pts)" : "") + ".");
  const finish = () => {
    for (const t of h.trick) h.taken[winner].push(t.card);
    h.handScores[winner] += pts;
    h.trick = []; h.leader = winner; h.turn = winner; h.trickNo++; h._pending = null; h.locked = false;
    if (h.trickNo === 13) endHand(lobby, h);
  };
  if (typeof lobby.notify === "function") { h.locked = true; setTimeout(() => { if (lobby.hearts === h) { finish(); notify(lobby); } }, TRICK_MS); }
  else finish();
  return { ok: true };
}
function endHand(lobby, h) {
  const hp = {}; for (const c of h.order) hp[c] = h.handScores[c];
  const shooter = h.order.find((c) => hp[c] === 26);
  if (shooter) { for (const c of h.order) hp[c] = c === shooter ? 0 : 26; logPush(h, nameOf(lobby, shooter) + " shot the moon!"); }
  for (const c of h.order) h.scores[c] += hp[c];
  h.passDir++;
  h.lastHand = h.order.map((c) => ({ cid: c, name: nameOf(lobby, c), hand: hp[c], total: h.scores[c] }));
  if (Object.values(h.scores).some((s) => s >= 100)) finalize(lobby, h);
  else { h.phase = "handover"; logPush(h, "Hand over. Tap Next hand."); }
}
function nextHand(lobby) {
  const h = lobby.hearts; if (!h || h.phase !== "handover") return { error: "Not between hands." };
  startHand(lobby, h); return { ok: true };
}
function finalize(lobby, h) {
  h.phase = "over";
  const standings = h.order.map((c) => ({ cid: c, name: nameOf(lobby, c), score: h.scores[c] })).sort((a, b) => a.score - b.score);
  const low = standings[0].score;
  h.results = { standings, winners: standings.filter((s) => s.score === low).map((s) => s.cid) };
  logPush(h, "Game over \u2014 " + standings[0].name + " wins with " + low + ".");
}
function onLeave(lobby, cid) {
  const h = lobby.hearts; if (!h || h.phase === "over") return;
  finalize(lobby, h); // 4 fixed seats: if someone leaves for good, end the game
}
module.exports = { startGame, selectPass, playCard, nextHand, onLeave, legalPlays, points };
