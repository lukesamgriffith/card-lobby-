/* =========================================================================
   Go Fish engine for Card Lobby.

   Server-authoritative: each player only ever sees their own hand; everyone
   sees hand COUNTS, completed books, the pool size, and a short event log.

   lobby.gofish = {
     phase: 'play'|'over', deck:[codes], order:[cid], turn:cid,
     hands:{cid:[codes]}, books:{cid:[ranks]}, log:[strings], results
   }
   ========================================================================= */
const { makeDeck, shuffle } = require("./poker");

const rankOf = (code) => code.slice(0, -1);
const RANK_NAME = { A: "Aces", T: "10s", J: "Jacks", Q: "Queens", K: "Kings" };
const rankPlural = (r) => RANK_NAME[r] || (r + "s");

function seated(lobby) {
  return lobby.order.filter((cid) => { const p = lobby.players.get(cid); return p && p.connected; });
}
function logPush(gf, msg) { gf.log.push(msg); if (gf.log.length > 6) gf.log.shift(); }
function nameOf(lobby, cid) { const p = lobby.players.get(cid); return p ? p.name : "?"; }

// pull any completed four-of-a-kind out of a hand into that player's books
function pullBooks(lobby, gf, cid) {
  const hand = gf.hands[cid];
  const counts = {};
  for (const c of hand) counts[rankOf(c)] = (counts[rankOf(c)] || 0) + 1;
  for (const r of Object.keys(counts)) {
    if (counts[r] === 4) {
      gf.hands[cid] = gf.hands[cid].filter((c) => rankOf(c) !== r);
      gf.books[cid].push(r);
      logPush(gf, nameOf(lobby, cid) + " completed a book of " + rankPlural(r) + "!");
    }
  }
}

function totalBooks(gf) { return gf.order.reduce((s, cid) => s + gf.books[cid].length, 0); }

function startGame(lobby) {
  const seats = seated(lobby);
  if (seats.length < 2) return { error: "Need at least 2 players to start Go Fish." };
  const deck = shuffle(makeDeck());
  const handSize = seats.length <= 3 ? 7 : 5;
  const gf = { phase: "play", deck, order: seats, turn: seats[0], hands: {}, books: {}, log: [], results: null };
  for (const cid of seats) { gf.hands[cid] = []; gf.books[cid] = []; }
  for (let i = 0; i < handSize; i++) for (const cid of seats) gf.hands[cid].push(deck.pop());
  lobby.gofish = gf;
  for (const cid of seats) pullBooks(lobby, gf, cid); // rare, but a dealt book counts
  logPush(gf, nameOf(lobby, seats[0]) + " goes first.");
  ensureCanPlay(lobby, gf); // draw the first player up if somehow empty
  return { ok: true };
}

// next player clockwise from `fromCid` who can play (drawing them up if needed)
function advanceTurn(lobby, gf, fromCid) {
  const n = gf.order.length;
  const start = gf.order.indexOf(fromCid);
  for (let k = 1; k <= n; k++) {
    const cid = gf.order[(start + k) % n];
    if (gf.hands[cid].length > 0) { gf.turn = cid; return; }
    if (gf.deck.length) { // empty-handed but cards remain: draw them back in
      gf.hands[cid].push(gf.deck.pop()); pullBooks(lobby, gf, cid);
      if (gf.hands[cid].length > 0) { gf.turn = cid; return; }
    }
  }
  gf.turn = null; // nobody can play
}

// make sure the current turn-holder can actually play (draw up / pass / or end)
function ensureCanPlay(lobby, gf) {
  let guard = 0;
  while (guard++ < gf.order.length + 3) {
    const cid = gf.turn;
    if (cid == null) break;
    if (gf.hands[cid].length === 0 && gf.deck.length) { gf.hands[cid].push(gf.deck.pop()); pullBooks(lobby, gf, cid); }
    if (gf.hands[cid].length === 0) { advanceTurn(lobby, gf, cid); continue; }       // still empty: pass on
    const hasTarget = gf.order.some((o) => o !== cid && gf.hands[o].length > 0);
    if (hasTarget) break;                                                            // good to go
    if (gf.deck.length) { advanceTurn(lobby, gf, cid); continue; }                   // nobody to ask: pass so they draw up
    break;                                                                           // no targets and empty pool -> stuck
  }
  const cid = gf.turn;
  const stuck = cid == null || gf.hands[cid].length === 0 ||
    (!gf.order.some((o) => o !== cid && gf.hands[o].length > 0) && gf.deck.length === 0);
  if (totalBooks(gf) >= 13 || stuck) finalize(lobby, gf);
}

function finalize(lobby, gf) {
  const standings = gf.order.map((cid) => ({ cid, name: nameOf(lobby, cid), books: gf.books[cid].length, ranks: gf.books[cid].slice() }))
    .sort((a, b) => b.books - a.books);
  const top = standings.length ? standings[0].books : 0;
  gf.results = { standings, winners: standings.filter((s) => s.books === top).map((s) => s.cid) };
  gf.phase = "over"; gf.turn = null;
  const names = gf.results.winners.map((c) => nameOf(lobby, c)).join(" & ");
  logPush(gf, "Game over \u2014 " + names + " win" + (gf.results.winners.length > 1 ? "" : "s") + " with " + top + " books!");
}

// current player asks `target` for `rank`
function ask(lobby, cid, target, rank) {
  const gf = lobby.gofish;
  if (!gf || gf.phase !== "play") return { error: "No game in progress." };
  if (gf.turn !== cid) return { error: "Not your turn." };
  if (!gf.hands[target]) return { error: "No such player." };
  if (target === cid) return { error: "Ask someone else." };
  rank = String(rank || "").toUpperCase();
  if (!gf.hands[cid].some((c) => rankOf(c) === rank)) return { error: "You must hold a card of that rank to ask for it." };
  if (gf.hands[target].length === 0) return { error: "That player has no cards." };

  const asker = nameOf(lobby, cid), tgt = nameOf(lobby, target);
  const matches = gf.hands[target].filter((c) => rankOf(c) === rank);
  if (matches.length) {
    gf.hands[target] = gf.hands[target].filter((c) => rankOf(c) !== rank);
    gf.hands[cid].push(...matches);
    logPush(gf, asker + " got " + matches.length + " " + rankPlural(rank) + " from " + tgt + " \u2014 go again!");
    pullBooks(lobby, gf, cid);
    // turn stays with asker
  } else {
    logPush(gf, tgt + ": \u201CGo Fish!\u201D \u2014 " + asker + " draws.");
    if (gf.deck.length) {
      const drawn = gf.deck.pop();
      gf.hands[cid].push(drawn);
      pullBooks(lobby, gf, cid);
      if (rankOf(drawn) === rank) logPush(gf, asker + " fished a " + rankPlural(rank).replace(/s$/, "") + " \u2014 go again!");
      else advanceTurn(lobby, gf, cid);
    } else {
      advanceTurn(lobby, gf, cid); // empty pool, nothing to draw
    }
  }
  ensureCanPlay(lobby, gf);
  return { ok: true };
}

// a player left: drop them; their cards go back to the pool so the game can continue
function removePlayer(lobby, cid) {
  const gf = lobby.gofish; if (!gf || gf.phase !== "play") return;
  if (!gf.hands[cid]) return;
  gf.deck.push(...gf.hands[cid]);
  delete gf.hands[cid]; delete gf.books[cid];
  const wasTurn = gf.turn === cid;
  const idx = gf.order.indexOf(cid);
  gf.order = gf.order.filter((x) => x !== cid);
  if (gf.order.length < 2) return finalize(lobby, gf);
  if (wasTurn) { gf.turn = gf.order[idx % gf.order.length]; ensureCanPlay(lobby, gf); }
}

// it's a player's turn but they dropped: move the action along without removing them
function skipTurn(lobby, cid) {
  const gf = lobby.gofish; if (!gf || gf.phase !== "play") return;
  if (gf.turn === cid) { advanceTurn(lobby, gf, cid); ensureCanPlay(lobby, gf); }
}

module.exports = { startGame, ask, removePlayer, skipTurn, rankOf, rankPlural };
