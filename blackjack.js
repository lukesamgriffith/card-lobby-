/* =========================================================================
   Blackjack engine for Card Lobby. Players vs an automated dealer; reuses the
   shared chip stacks (player.chips).

   lobby.bj = {
     on, phase:'betting'|'playing'|'dealer'|'done', minBet, deck:[codes],
     order:[cid in the round], toAct:cid,
     bets:{cid:amount}, hands:{cid:{cards,bet,stood,busted,doubled,done,bj,result,payout}},
     dealer:{cards:[codes], revealed:bool}, results
   }
   Bets are taken from chips when placed and paid back on settle, so chips are
   always conserved.
   ========================================================================= */
const { makeDeck, shuffle } = require("./poker");

const REVEAL_MS = 1200, DRAW_MS = 1100, SETTLE_MS = 1400;
function alive(lobby, bj) { return lobby.bj === bj && bj.phase !== "done"; }
function notify(lobby) { if (typeof lobby.notify === "function") lobby.notify(); }

function handValue(cards) {
  let sum = 0, aces = 0;
  for (const c of cards) {
    const r = c.slice(0, -1);
    if (r === "A") { aces++; sum += 11; }
    else if (r === "T" || r === "J" || r === "Q" || r === "K") sum += 10;
    else sum += parseInt(r, 10);
  }
  while (sum > 21 && aces) { sum -= 10; aces--; }
  return { total: sum, soft: aces > 0 && sum <= 21 };
}
const isBlackjack = (cards) => cards.length === 2 && handValue(cards).total === 21;
function seated(lobby) { return lobby.order.filter((cid) => { const p = lobby.players.get(cid); return p && p.connected; }); }

function startRound(lobby) {
  const pk = lobby.bj;
  // return any reserved bets (fresh round)
  const bj = { on: true, phase: "betting", minBet: (pk && pk.minBet) || 10, deck: shuffle(makeDeck()), order: [], toAct: null, bets: {}, hands: {}, dealer: { cards: [], revealed: false }, results: null };
  lobby.bj = bj;
  return { ok: true };
}

function placeBet(lobby, cid, amount) {
  const bj = lobby.bj;
  if (!bj || bj.phase !== "betting") return { error: "Bets are closed." };
  const p = lobby.players.get(cid); if (!p) return { error: "No seat." };
  amount = Math.max(0, Math.floor(amount || 0));
  const prev = bj.bets[cid] || 0;
  p.chips += prev; // refund previous, then re-take
  if (amount > p.chips) amount = p.chips;
  if (amount > 0 && amount < bj.minBet) amount = Math.min(bj.minBet, p.chips);
  p.chips -= amount;
  if (amount > 0) bj.bets[cid] = amount; else delete bj.bets[cid];
  return { ok: true };
}

function deal(lobby) {
  const bj = lobby.bj;
  if (!bj || bj.phase !== "betting") return { error: "Not in betting." };
  const order = seated(lobby).filter((cid) => (bj.bets[cid] || 0) > 0);
  if (!order.length) return { error: "At least one player must place a bet." };
  bj.order = order;
  for (const cid of order) bj.hands[cid] = { cards: [bj.deck.pop()], bet: bj.bets[cid], stood: false, busted: false, doubled: false, done: false, bj: false, result: null, payout: 0 };
  bj.dealer.cards = [bj.deck.pop()];
  for (const cid of order) bj.hands[cid].cards.push(bj.deck.pop());
  bj.dealer.cards.push(bj.deck.pop()); // hole (hidden)
  bj.phase = "playing";
  for (const cid of order) { if (isBlackjack(bj.hands[cid].cards)) { bj.hands[cid].bj = true; bj.hands[cid].done = true; bj.hands[cid].stood = true; } }
  bj.toAct = order.find((cid) => !bj.hands[cid].done) || null;
  if (!bj.toAct) beginDealer(lobby);
  return { ok: true };
}

function advance(lobby) {
  const bj = lobby.bj;
  const next = bj.order.find((cid) => !bj.hands[cid].done);
  bj.toAct = next || null;
  if (!next) beginDealer(lobby);
}

function action(lobby, cid, act) {
  const bj = lobby.bj;
  if (!bj || bj.phase !== "playing") return { error: "Not in play." };
  if (bj.toAct !== cid) return { error: "Not your turn." };
  const h = bj.hands[cid], p = lobby.players.get(cid);
  if (act === "hit") {
    h.cards.push(bj.deck.pop());
    const v = handValue(h.cards);
    if (v.total > 21) { h.busted = true; h.done = true; }
    else if (v.total === 21) { h.stood = true; h.done = true; }
    advance(lobby);
  } else if (act === "stand") {
    h.stood = true; h.done = true; advance(lobby);
  } else if (act === "double") {
    if (h.cards.length !== 2) return { error: "Can only double on your first two cards." };
    if (p.chips < h.bet) return { error: "Not enough chips to double." };
    p.chips -= h.bet; h.bet *= 2; h.doubled = true;
    h.cards.push(bj.deck.pop());
    if (handValue(h.cards).total > 21) h.busted = true;
    h.done = true; advance(lobby);
  } else return { error: "Unknown action." };
  return { ok: true };
}

// dealer reveals and draws, paced one card at a time
function beginDealer(lobby) {
  const bj = lobby.bj;
  bj.phase = "dealer"; bj.toAct = null; bj.dealer.revealed = true;
  notify(lobby);
  const allBust = bj.order.every((cid) => bj.hands[cid].busted);
  if (allBust) { setTimeout(() => { if (alive(lobby, bj)) settle(lobby); }, REVEAL_MS); return; }
  step(lobby, bj);
}
function step(lobby, bj) {
  setTimeout(() => {
    if (!alive(lobby, bj)) return;
    const v = handValue(bj.dealer.cards);
    if (v.total < 17) { bj.dealer.cards.push(bj.deck.pop()); notify(lobby); step(lobby, bj); }
    else settle(lobby);
  }, DRAW_MS);
}

function settle(lobby) {
  const bj = lobby.bj;
  const dv = handValue(bj.dealer.cards).total;
  const dealerBJ = isBlackjack(bj.dealer.cards);
  const dealerBust = dv > 21;
  for (const cid of bj.order) {
    const h = bj.hands[cid], p = lobby.players.get(cid);
    const pv = handValue(h.cards).total;
    let result, payout = 0;
    if (h.busted) { result = "lose"; }
    else if (h.bj && dealerBJ) { result = "push"; payout = h.bet; }
    else if (h.bj) { result = "blackjack"; payout = Math.floor(h.bet * 2.5); }
    else if (dealerBJ) { result = "lose"; }
    else if (dealerBust) { result = "win"; payout = h.bet * 2; }
    else if (pv > dv) { result = "win"; payout = h.bet * 2; }
    else if (pv === dv) { result = "push"; payout = h.bet; }
    else { result = "lose"; }
    h.result = result; h.payout = payout;
    if (payout > 0) p.chips += payout;
  }
  bj.results = {
    dealer: { cards: bj.dealer.cards.slice(), total: dv, bust: dealerBust, bj: dealerBJ },
    players: bj.order.map((cid) => ({ cid, name: lobby.players.get(cid).name, cards: bj.hands[cid].cards.slice(), total: handValue(bj.hands[cid].cards).total, bet: bj.hands[cid].bet, result: bj.hands[cid].result, payout: bj.hands[cid].payout })),
  };
  bj.phase = "done"; bj.toAct = null;
  notify(lobby);
}

// a player left mid-round: stand them so the table isn't stuck
function onLeave(lobby, cid) {
  const bj = lobby.bj; if (!bj) return;
  if (bj.phase === "betting") { const p = lobby.players.get(cid); if (p && bj.bets[cid]) { p.chips += bj.bets[cid]; delete bj.bets[cid]; } return; }
  if (bj.phase !== "playing" || !bj.hands[cid]) return;
  bj.hands[cid].stood = true; bj.hands[cid].done = true;
  if (bj.toAct === cid) advance(lobby);
}

module.exports = { startRound, placeBet, deal, action, onLeave, handValue, isBlackjack };
