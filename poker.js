/* =========================================================================
   Texas Hold'em engine for Card Lobby.

   Pure-ish logic operating on a lobby object:
     lobby.players : Map<cid, { name, chips, connected, ... }>
     lobby.order   : [cid]  (seat order)
     lobby.poker   : { on, sb, bb, buttonCid, hand }

   A live hand:
     hand = { phase, deck, community, pot, inHand:{cid:{hole,folded,allIn,cTotal,cRound}},
              order:[cid], button:idx, currentBet, minRaise, toAct, needToAct:Set, results }

   Betting-reopen rule is slightly simplified: any all-in that increases the
   current bet reopens action. This never mispays a pot; it just occasionally
   allows one extra re-raise. Everything else is standard Hold'em.
   ========================================================================= */

// Pacing (ms). Reveal one hand at a time at showdown; run out all-in boards a card at a time.
const REVEAL_MS = 1500;   // gap between each shown hand at showdown
const RUNOUT_MS = 1400;   // gap between streets when everyone's all-in
const PAUSE_MS  = 1700;   // beat after the winning hand before settling the pot
const MUCK_MS   = 20000;  // auto-muck losers who don't choose in time

// timers fire later, so guard them: bail if a new hand has begun in the meantime
function alive(lobby, hand) { return lobby.poker && lobby.poker.hand === hand && hand.phase !== "done"; }
function notify(lobby) { if (typeof lobby.notify === "function") lobby.notify(); }

const SUITS = ["S", "H", "D", "C"];
const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K"];
function makeDeck() { const d = []; for (const s of SUITS) for (const r of RANKS) d.push(r + s); return d; }
function shuffle(a) { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

/* ---------- hand evaluation ---------- */
const RV = { A: 14, K: 13, Q: 12, J: 11, T: 10 };
function rv(code) { const r = code.slice(0, -1); return RV[r] || +r; }
function suitOf(code) { return code.slice(-1); }

// score a 5-card hand -> comparable array [category, ...tiebreakers]; higher is better
function score5(cards) {
  const vals = cards.map(rv).sort((a, b) => b - a);
  const suits = cards.map(suitOf);
  const isFlush = suits.every((s) => s === suits[0]);
  const cnt = {};
  vals.forEach((v) => (cnt[v] = (cnt[v] || 0) + 1));
  const groups = Object.keys(cnt).map((v) => [cnt[v], +v]).sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  const tb = groups.map((g) => g[1]); // tiebreak ranks ordered by group size then rank

  // straight (with wheel A-2-3-4-5)
  const uniq = [...new Set(vals)].sort((a, b) => b - a);
  let straightHigh = 0;
  const arr = uniq.slice();
  if (arr.includes(14)) arr.push(1);
  let run = 1;
  for (let i = 1; i < arr.length; i++) {
    if (arr[i] === arr[i - 1] - 1) { run++; if (run >= 5) { straightHigh = arr[i - 4]; break; } }
    else if (arr[i] !== arr[i - 1]) run = 1;
  }

  if (isFlush && straightHigh) return [8, straightHigh];
  if (groups[0][0] === 4) return [7, ...tb];
  if (groups[0][0] === 3 && groups[1] && groups[1][0] >= 2) return [6, ...tb];
  if (isFlush) return [5, ...vals];
  if (straightHigh) return [4, straightHigh];
  if (groups[0][0] === 3) return [3, ...tb];
  if (groups[0][0] === 2 && groups[1] && groups[1][0] === 2) return [2, ...tb];
  if (groups[0][0] === 2) return [1, ...tb];
  return [0, ...vals];
}
const CAT_NAME = ["High card", "Pair", "Two pair", "Three of a kind", "Straight", "Flush", "Full house", "Four of a kind", "Straight flush"];

function cmp(a, b) { for (let i = 0; i < Math.max(a.length, b.length); i++) { const d = (a[i] || 0) - (b[i] || 0); if (d) return d; } return 0; }

// best 5-of-7
function evaluate7(cards7) {
  let best = null;
  const n = cards7.length;
  for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) for (let c = b + 1; c < n; c++)
    for (let d = c + 1; d < n; d++) for (let e = d + 1; e < n; e++) {
      const s = score5([cards7[a], cards7[b], cards7[c], cards7[d], cards7[e]]);
      if (!best || cmp(s, best) > 0) best = s;
    }
  return best;
}
function handName(score) { return CAT_NAME[score[0]]; }

/* ---------- side pots ---------- */
// contribs: {cid: totalChipsContributed}; folded: Set of cids that folded
// returns [{ amount, eligible:[cid] }]
function buildPots(contribs, folded) {
  const entries = Object.entries(contribs).filter(([, v]) => v > 0).map(([cid, v]) => ({ cid, v }));
  const pots = [];
  while (entries.some((e) => e.v > 0)) {
    const min = Math.min(...entries.filter((e) => e.v > 0).map((e) => e.v));
    let amount = 0;
    const eligible = [];
    for (const e of entries) if (e.v > 0) { amount += min; e.v -= min; if (!folded.has(e.cid)) eligible.push(e.cid); }
    pots.push({ amount, eligible });
  }
  // merge adjacent pots with identical eligibility
  const merged = [];
  for (const p of pots) {
    const last = merged[merged.length - 1];
    if (last && last.eligible.join(",") === p.eligible.join(",")) last.amount += p.amount;
    else merged.push(p);
  }
  return merged;
}

/* ---------- engine ---------- */
function seatedOrder(lobby) {
  return lobby.order.filter((cid) => { const p = lobby.players.get(cid); return p && p.connected && p.chips > 0; });
}
function activeFrom(hand, startPos) {
  const seats = hand.order, n = seats.length;
  for (let k = 0; k < n; k++) {
    const cid = seats[(startPos + k) % n];
    const ph = hand.inHand[cid];
    if (ph && !ph.folded && !ph.allIn && hand.needToAct.has(cid)) return cid;
  }
  return null;
}
function liveCount(hand) { return hand.order.filter((cid) => !hand.inHand[cid].folded).length; }
function canActCount(hand) { return hand.order.filter((cid) => { const p = hand.inHand[cid]; return !p.folded && !p.allIn; }).length; }

function startHand(lobby) {
  const pk = lobby.poker;
  const seats = seatedOrder(lobby);
  if (seats.length < 2) return { error: "Need at least 2 players with chips to deal." };
  const n = seats.length;
  let bi = seats.indexOf(pk.buttonCid);
  bi = bi < 0 ? 0 : (bi + 1) % n;
  pk.buttonCid = seats[bi];

  const deck = shuffle(makeDeck());
  const inHand = {};
  for (const cid of seats) inHand[cid] = { hole: [deck.pop(), deck.pop()], folded: false, allIn: false, cTotal: 0, cRound: 0 };
  const hand = { phase: "preflop", deck, community: [], pot: 0, inHand, order: seats, button: bi, currentBet: 0, minRaise: pk.bb, toAct: null, needToAct: new Set(), results: null, streetAggressor: null, sd: null };
  pk.hand = hand;

  let sbPos, bbPos, firstAct;
  if (n === 2) { sbPos = bi; bbPos = (bi + 1) % 2; firstAct = bi; }            // heads-up: button is SB, acts first preflop
  else { sbPos = (bi + 1) % n; bbPos = (bi + 2) % n; firstAct = (bi + 3) % n; }
  postBlind(lobby, seats[sbPos], pk.sb);
  postBlind(lobby, seats[bbPos], pk.bb);
  hand.currentBet = Math.max(...seats.map((c) => inHand[c].cRound));
  hand.minRaise = pk.bb;
  hand.sbCid = seats[sbPos]; hand.bbCid = seats[bbPos];
  hand.needToAct = new Set(seats.filter((cid) => !inHand[cid].allIn));
  hand.toAct = activeFrom(hand, firstAct);
  if (!hand.toAct) settleIfDone(lobby); // everyone all-in from blinds (edge)
  return { ok: true };
}

function postBlind(lobby, cid, amt) {
  const p = lobby.players.get(cid), ph = lobby.poker.hand.inHand[cid];
  const pay = Math.min(amt, p.chips);
  p.chips -= pay; ph.cRound += pay; ph.cTotal += pay; lobby.poker.hand.pot += pay;
  if (p.chips === 0) ph.allIn = true;
}

function legalActions(lobby, cid) {
  const pk = lobby.poker, hand = pk.hand;
  if (!hand || hand.toAct !== cid) return null;
  const p = lobby.players.get(cid), ph = hand.inHand[cid];
  const toCall = Math.max(0, hand.currentBet - ph.cRound);
  const minRaiseTo = hand.currentBet + hand.minRaise;
  const maxRaiseTo = ph.cRound + p.chips; // all-in total this round
  return {
    toCall: Math.min(toCall, p.chips),
    canCheck: toCall <= 0,
    canCall: toCall > 0 && p.chips > 0,
    canRaise: p.chips > toCall, // has chips beyond a call
    minRaiseTo: Math.min(minRaiseTo, maxRaiseTo),
    maxRaiseTo,
    chips: p.chips,
  };
}

// action: 'fold' | 'check' | 'call' | 'raise' (amount = total cRound to reach) | 'allin'
function applyAction(lobby, cid, action, amount) {
  const pk = lobby.poker, hand = pk.hand;
  if (!hand || hand.phase === "done" || hand.toAct !== cid) return { error: "Not your turn." };
  const p = lobby.players.get(cid), ph = hand.inHand[cid];
  const toCall = Math.max(0, hand.currentBet - ph.cRound);
  const pos = hand.order.indexOf(cid);

  const put = (total) => { // raise this player's cRound to `total`
    total = Math.min(total, ph.cRound + p.chips);
    const pay = total - ph.cRound;
    p.chips -= pay; ph.cRound += pay; ph.cTotal += pay; hand.pot += pay;
    if (p.chips === 0) ph.allIn = true;
  };

  if (action === "fold") {
    ph.folded = true; hand.needToAct.delete(cid);
  } else if (action === "check") {
    if (toCall > 0) return { error: "Can't check, there's a bet to call." };
    hand.needToAct.delete(cid);
  } else if (action === "call") {
    if (toCall <= 0) { hand.needToAct.delete(cid); }
    else { put(hand.currentBet); hand.needToAct.delete(cid); }
  } else if (action === "raise" || action === "allin") {
    const maxTo = ph.cRound + p.chips;
    let to = action === "allin" ? maxTo : Math.min(amount || 0, maxTo);
    const minTo = hand.currentBet + hand.minRaise;
    if (action === "raise" && to < minTo && to < maxTo) return { error: "Raise too small." };
    if (to <= hand.currentBet && action === "raise") return { error: "Raise must exceed the current bet." };
    put(to);
    if (ph.cRound > hand.currentBet) { // a genuine raise (or all-in over the bet) -> reopen
      hand.minRaise = Math.max(hand.minRaise, ph.cRound - hand.currentBet);
      hand.currentBet = ph.cRound;
      hand.streetAggressor = cid;
      hand.needToAct = new Set(hand.order.filter((c) => !hand.inHand[c].folded && !hand.inHand[c].allIn));
    }
    hand.needToAct.delete(cid);
  } else return { error: "Unknown action." };

  // only one player left -> they win immediately
  if (liveCount(hand) === 1) { awardUncontested(lobby); return { ok: true }; }
  // betting round finished?
  if (hand.needToAct.size === 0 || canActCount(hand) <= 1) { advanceStreet(lobby); return { ok: true }; }
  hand.toAct = activeFrom(hand, pos + 1);
  if (!hand.toAct) advanceStreet(lobby);
  return { ok: true };
}

function awardUncontested(lobby) {
  const hand = lobby.poker.hand;
  const winner = hand.order.find((cid) => !hand.inHand[cid].folded);
  lobby.players.get(winner).chips += hand.pot;
  hand.results = { board: hand.community.slice(), winners: [{ cid: winner, name: lobby.players.get(winner).name, amount: hand.pot }], shown: [], uncontested: true };
  hand.pot = 0; hand.phase = "done"; hand.toAct = null;
}

function advanceStreet(lobby) {
  const pk = lobby.poker, hand = pk.hand;
  // reset the betting round
  for (const cid of hand.order) hand.inHand[cid].cRound = 0;
  hand.currentBet = 0; hand.minRaise = pk.bb;

  // nobody left who can bet -> run the remaining board out, paced
  if (canActCount(hand) <= 1) { hand.streetAggressor = null; scheduleRunout(lobby, hand); return; }

  dealStreet(hand);
  if (hand.phase === "showdown") return beginShowdown(lobby);

  hand.streetAggressor = null; // fresh betting street
  hand.needToAct = new Set(hand.order.filter((c) => !hand.inHand[c].folded && !hand.inHand[c].allIn));
  hand.toAct = activeFrom(hand, (hand.button + 1) % hand.order.length);
  if (!hand.toAct) advanceStreet(lobby);
}

function dealStreet(hand) {
  const deal = (k) => { for (let i = 0; i < k; i++) hand.community.push(hand.deck.pop()); };
  const next = { preflop: "flop", flop: "turn", turn: "river", river: "showdown" }[hand.phase];
  if (next === "flop") deal(3); else if (next === "turn" || next === "river") deal(1);
  hand.phase = next;
}

// Everyone's committed: turn the remaining cards one street at a time so it isn't instant.
function scheduleRunout(lobby, hand) {
  setTimeout(() => {
    if (!alive(lobby, hand)) return;
    dealStreet(hand);
    notify(lobby);
    if (hand.phase === "showdown") beginShowdown(lobby);
    else scheduleRunout(lobby, hand);
  }, RUNOUT_MS);
}

// ---- Showdown: work out winners, then reveal in order with pacing ----

function computeOutcome(lobby, hand) {
  const folded = new Set(hand.order.filter((c) => hand.inHand[c].folded));
  const contribs = {};
  for (const cid of hand.order) contribs[cid] = hand.inHand[cid].cTotal;
  const pots = buildPots(contribs, folded);
  const scores = {};
  for (const cid of hand.order) if (!folded.has(cid)) scores[cid] = evaluate7(hand.inHand[cid].hole.concat(hand.community));

  const winMap = {};
  for (const pot of pots) {
    const elig = pot.eligible.filter((c) => !folded.has(c));
    if (!elig.length) continue;
    let best = null, winners = [];
    for (const c of elig) { const s = scores[c]; const d = best ? cmp(s, best) : 1; if (d > 0) { best = s; winners = [c]; } else if (d === 0) winners.push(c); }
    const share = Math.floor(pot.amount / winners.length);
    const rem = pot.amount - share * winners.length;
    const ordered = winners.slice().sort((a, b) => ((hand.order.indexOf(a) - hand.button + 999) % hand.order.length) - ((hand.order.indexOf(b) - hand.button + 999) % hand.order.length));
    for (const c of ordered) winMap[c] = (winMap[c] || 0) + share;
    for (let i = 0; i < rem; i++) winMap[ordered[i]] += 1;
  }
  return { folded, scores, winMap };
}

// Reveal order: from the last aggressor (or first seat left of the button if checked down), clockwise.
function revealOrder(hand, folded) {
  const n = hand.order.length;
  const agg = hand.streetAggressor;
  let start = (agg != null && !folded.has(agg)) ? hand.order.indexOf(agg) : (hand.button + 1) % n;
  const order = [];
  for (let k = 0; k < n; k++) { const cid = hand.order[(start + k) % n]; if (!folded.has(cid)) order.push(cid); }
  return order;
}

function beginShowdown(lobby) {
  const hand = lobby.poker.hand;
  const { folded, scores, winMap } = computeOutcome(lobby, hand);
  const order = revealOrder(hand, folded);

  // Auto-reveal up to and including the last winner in reveal order; the rest get a choice.
  let lastWin = -1;
  order.forEach((c, i) => { if (winMap[c] > 0) lastWin = i; });
  if (lastWin < 0) lastWin = order.length - 1;

  hand.sd = { folded, scores, winMap, order, autoUpTo: lastWin, pending: order.slice(lastWin + 1), shown: new Set(), pendingChoice: new Set(), muckTimer: null };
  hand.phase = "showdown";
  revealStep(lobby, hand, 0);
}

function revealStep(lobby, hand, i) {
  if (!alive(lobby, hand)) return;
  const sd = hand.sd;
  if (i <= sd.autoUpTo) {
    sd.shown.add(sd.order[i]);
    notify(lobby);
    setTimeout(() => revealStep(lobby, hand, i + 1), REVEAL_MS);
    return;
  }
  // Winner is on the table. Anyone after them may show or muck.
  if (sd.pending.length) {
    hand.phase = "muck";
    sd.pendingChoice = new Set(sd.pending);
    notify(lobby);
    sd.muckTimer = setTimeout(() => { if (alive(lobby, hand) && hand.phase === "muck") finalizeShowdown(lobby, hand); }, MUCK_MS);
  } else {
    setTimeout(() => { if (alive(lobby, hand)) finalizeShowdown(lobby, hand); }, PAUSE_MS);
  }
}

// player after the winner chooses to reveal (show=true) or muck (show=false)
function applyReveal(lobby, cid, show) {
  const hand = lobby.poker && lobby.poker.hand;
  if (!hand || hand.phase !== "muck" || !hand.sd) return { error: "Nothing to reveal." };
  const sd = hand.sd;
  if (!sd.pendingChoice.has(cid)) return { error: "Not your choice." };
  sd.pendingChoice.delete(cid);
  if (show) sd.shown.add(cid);
  notify(lobby);
  if (sd.pendingChoice.size === 0) { clearTimeout(sd.muckTimer); finalizeShowdown(lobby, hand); }
  return { ok: true };
}

function finalizeShowdown(lobby, hand) {
  const sd = hand.sd;
  for (const [cid, amt] of Object.entries(sd.winMap)) lobby.players.get(cid).chips += amt;
  const shown = hand.order
    .filter((c) => sd.shown.has(c))
    .map((c) => ({ cid: c, name: lobby.players.get(c).name, hole: hand.inHand[c].hole, hand: handName(sd.scores[c]) }));
  const winners = Object.entries(sd.winMap).map(([cid, amount]) => ({ cid, name: lobby.players.get(cid).name, amount, hand: handName(sd.scores[cid]) }));
  hand.results = { board: hand.community.slice(), winners, shown, uncontested: false };
  hand.pot = 0; hand.phase = "done"; hand.toAct = null; hand.sd = null;
  notify(lobby);
}

function settleIfDone(lobby) { const h = lobby.poker.hand; if (h && h.phase !== "done" && canActCount(h) <= 1) advanceStreet(lobby); }

// fold a player who left mid-hand; advance the action if it was their turn
function foldOnLeave(lobby, cid) {
  const pk = lobby.poker; if (!pk || !pk.hand || pk.hand.phase === "done") return;
  const hand = pk.hand, ph = hand.inHand[cid]; if (!ph || ph.folded) return;
  ph.folded = true; hand.needToAct.delete(cid);
  if (liveCount(hand) === 1) return awardUncontested(lobby);
  if (hand.toAct === cid) {
    if (hand.needToAct.size === 0 || canActCount(hand) <= 1) advanceStreet(lobby);
    else hand.toAct = activeFrom(lobby.poker.hand, hand.order.indexOf(cid) + 1);
  }
}

module.exports = { startHand, applyAction, applyReveal, legalActions, foldOnLeave, evaluate7, score5, cmp, handName, buildPots, makeDeck, shuffle };
