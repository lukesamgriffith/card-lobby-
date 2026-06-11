/* =========================================================================
   Gin Rummy (2). Draw from stock or discard, then discard. Melds = runs (3+
   same suit, consecutive) and sets (3+ same rank). Knock when deadwood <= 10;
   gin = 0 deadwood (+25). Opponent lays off onto the knocker's melds unless
   gin. Undercut (+25) if the opponent's deadwood <= knocker's. Game to 100.

   lobby.gin = { phase:'draw'|'discard'|'handover'|'over', order:[a,b], hands,
                 stock, discard, turn, scores, handNo, lastRound, log, results }
   ========================================================================= */
const { makeDeck, shuffle } = require("./poker");
const rankOf = (c) => c.slice(0, -1), suitOf = (c) => c.slice(-1);
const RUNV = { A: 1, "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8, "9": 9, T: 10, J: 11, Q: 12, K: 13 };
const dwVal = (r) => r === "A" ? 1 : ("TJQK".includes(r) ? 10 : parseInt(r, 10));
const seated = (lobby) => lobby.order.filter((cid) => { const p = lobby.players.get(cid); return p && p.connected; });
const nameOf = (lobby, cid) => { const p = lobby.players.get(cid); return p ? p.name : "?"; };
function logPush(g, m) { g.log.push(m); if (g.log.length > 6) g.log.shift(); }
function combos(arr, k) { const out = []; (function go(s, c) { if (c.length === k) { out.push(c.slice()); return; } for (let i = s; i < arr.length; i++) { c.push(arr[i]); go(i + 1, c); c.pop(); } })(0, []); return out; }

function candidateMelds(cards) {
  const melds = [];
  const byRank = {}; cards.forEach((c, i) => { (byRank[rankOf(c)] = byRank[rankOf(c)] || []).push(i); });
  for (const r in byRank) { const idx = byRank[r]; if (idx.length >= 3) { combos(idx, 3).forEach((m) => melds.push(m)); if (idx.length === 4) melds.push(idx.slice()); } }
  const bySuit = {}; cards.forEach((c, i) => { (bySuit[suitOf(c)] = bySuit[suitOf(c)] || []).push(i); });
  for (const s in bySuit) {
    const idx = bySuit[s].slice().sort((a, b) => RUNV[rankOf(cards[a])] - RUNV[rankOf(cards[b])]);
    for (let i = 0; i < idx.length; i++) {
      const run = [idx[i]];
      for (let j = i + 1; j < idx.length; j++) {
        const prev = RUNV[rankOf(cards[run[run.length - 1]])], cur = RUNV[rankOf(cards[idx[j]])];
        if (cur === prev + 1) { run.push(idx[j]); if (run.length >= 3) melds.push(run.slice()); }
        else break;
      }
    }
  }
  return melds;
}
function bestMelds(cards) {
  const n = cards.length;
  const melds = candidateMelds(cards).map((m) => { let mask = 0; for (const i of m) mask |= (1 << i); return { mask, idx: m }; });
  const val = cards.map((c) => dwVal(rankOf(c)));
  const full = (1 << n) - 1; const memo = new Map();
  function rec(used) {
    if (used === full) return { dw: 0, melds: [] };
    if (memo.has(used)) return memo.get(used);
    let i = 0; while (used & (1 << i)) i++;
    let best = rec(used | (1 << i)); best = { dw: best.dw + val[i], melds: best.melds };
    for (const m of melds) if ((m.mask & (1 << i)) && !(m.mask & used)) { const sub = rec(used | m.mask); if (sub.dw < best.dw) best = { dw: sub.dw, melds: [m.idx, ...sub.melds] }; }
    memo.set(used, best); return best;
  }
  const r = rec(0);
  const inMeld = new Set(); r.melds.forEach((m) => m.forEach((i) => inMeld.add(i)));
  return { deadwoodValue: r.dw, melds: r.melds.map((m) => m.map((i) => cards[i])), deadwood: cards.filter((_, i) => !inMeld.has(i)) };
}
// greedy layoff of opp deadwood onto knocker melds; returns reduced deadwood value
function layoff(knockerMelds, oppDeadwood) {
  const melds = knockerMelds.map((m) => m.slice());
  let dw = oppDeadwood.slice(), changed = true;
  while (changed) {
    changed = false;
    for (let k = 0; k < dw.length; k++) {
      const c = dw[k];
      for (const m of melds) {
        const isSet = m.length >= 3 && m.every((x) => rankOf(x) === rankOf(m[0]));
        if (isSet && m.length < 4 && rankOf(c) === rankOf(m[0])) { m.push(c); dw.splice(k, 1); changed = true; break; }
        const isRun = m.length >= 3 && m.every((x) => suitOf(x) === suitOf(m[0]));
        if (isRun && suitOf(c) === suitOf(m[0])) {
          const vals = m.map((x) => RUNV[rankOf(x)]).sort((a, b) => a - b);
          const cv = RUNV[rankOf(c)];
          if (cv === vals[0] - 1 || cv === vals[vals.length - 1] + 1) { m.push(c); dw.splice(k, 1); changed = true; break; }
        }
      }
      if (changed) break;
    }
  }
  return dw.reduce((a, c) => a + dwVal(rankOf(c)), 0);
}

function startGame(lobby) {
  const seats = seated(lobby);
  if (seats.length !== 2) return { error: "Gin Rummy needs exactly 2 players." };
  const g = { phase: null, order: seats, hands: {}, stock: [], discard: [], turn: null, scores: {}, handNo: 0, lastRound: null, log: [], results: null };
  for (const c of seats) g.scores[c] = 0;
  lobby.gin = g; startHand(lobby, g); return { ok: true };
}
function startHand(lobby, g) {
  const deck = shuffle(makeDeck());
  g.hands[g.order[0]] = deck.slice(0, 10); g.hands[g.order[1]] = deck.slice(10, 20);
  g.stock = deck.slice(20); g.discard = [g.stock.pop()];
  g.turn = g.order[(g.handNo + 1) % 2]; // non-dealer first
  g.phase = "draw";
  logPush(g, "New hand. " + nameOf(lobby, g.turn) + " to draw.");
}
function drawStock(lobby, cid) {
  const g = lobby.gin; if (!g || g.phase !== "draw" || g.turn !== cid) return { error: "Can't draw now." };
  if (!g.stock.length) { endWash(lobby, g); return { ok: true }; }
  g.hands[cid].push(g.stock.pop()); g.phase = "discard";
  return { ok: true };
}
function drawDiscard(lobby, cid) {
  const g = lobby.gin; if (!g || g.phase !== "draw" || g.turn !== cid) return { error: "Can't draw now." };
  if (!g.discard.length) return { error: "Discard pile empty." };
  g.hands[cid].push(g.discard.pop()); g.phase = "discard";
  return { ok: true };
}
function discard(lobby, cid, card, knock) {
  const g = lobby.gin; if (!g || g.phase !== "discard" || g.turn !== cid) return { error: "Can't discard now." };
  if (!g.hands[cid].includes(card)) return { error: "You don't hold that card." };
  if (g.hands[cid].length !== 11) return { error: "Draw first." };
  const after = g.hands[cid].filter((c) => c !== card);
  const me = bestMelds(after);
  if (knock && me.deadwoodValue > 10) return { error: "You can only knock with 10 or less deadwood." };
  g.hands[cid] = after; g.discard.push(card);
  if (knock) { endRound(lobby, g, cid); return { ok: true }; }
  g.turn = g.order.find((c) => c !== cid); g.phase = "draw";
  if (g.stock.length <= 2) { endWash(lobby, g); }
  return { ok: true };
}
function endRound(lobby, g, knocker) {
  const opp = g.order.find((c) => c !== knocker);
  const km = bestMelds(g.hands[knocker]);
  const om = bestMelds(g.hands[opp]);
  const gin = km.deadwoodValue === 0;
  let scorer, pts, kind;
  if (gin) { scorer = knocker; pts = om.deadwoodValue + 25; kind = "Gin"; }
  else {
    const oppDw = layoff(km.melds, om.deadwood);
    const diff = oppDw - km.deadwoodValue;
    if (diff > 0) { scorer = knocker; pts = diff; kind = "Knock"; }
    else { scorer = opp; pts = (km.deadwoodValue - oppDw) + 25; kind = "Undercut"; }
  }
  g.scores[scorer] += pts;
  g.handNo++;
  g.lastRound = { knocker: nameOf(lobby, knocker), scorer: nameOf(lobby, scorer), scorerCid: scorer, pts, kind,
    knockerDw: km.deadwoodValue, oppDw: om.deadwoodValue, totals: g.order.map((c) => ({ cid: c, name: nameOf(lobby, c), score: g.scores[c] })) };
  logPush(g, kind + "! " + nameOf(lobby, scorer) + " +" + pts + ".");
  if (Object.values(g.scores).some((s) => s >= 100)) finalize(lobby, g);
  else g.phase = "handover";
}
function endWash(lobby, g) { g.handNo++; g.lastRound = { wash: true, totals: g.order.map((c) => ({ cid: c, name: nameOf(lobby, c), score: g.scores[c] })) }; logPush(g, "Stock ran out \u2014 no score."); g.phase = "handover"; }
function nextHand(lobby) { const g = lobby.gin; if (!g || g.phase !== "handover") return { error: "Not between hands." }; startHand(lobby, g); return { ok: true }; }
function finalize(lobby, g) {
  g.phase = "over";
  const standings = g.order.map((c) => ({ cid: c, name: nameOf(lobby, c), score: g.scores[c] })).sort((a, b) => b.score - a.score);
  g.results = { standings, winners: [standings[0].cid] };
  logPush(g, "Game over \u2014 " + standings[0].name + " wins with " + standings[0].score + ".");
}
function onLeave(lobby, cid) { const g = lobby.gin; if (!g || g.phase === "over") return; const other = g.order.find((x) => x !== cid); if (other) { g.phase = "over"; g.results = { standings: [{ cid: other, name: nameOf(lobby, other), score: g.scores[other] }], winners: [other] }; } }

module.exports = { startGame, drawStock, drawDiscard, discard, nextHand, onLeave, bestMelds };
