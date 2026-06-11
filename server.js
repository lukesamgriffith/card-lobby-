/* =========================================================================
   Card Lobby — authoritative real-time server.

   The server holds the one true copy of every lobby's state. Because it
   decides what each client receives, hidden information is genuinely hidden:
   a hand is only ever sent to its owner's socket, and a face-down card's
   value only to whoever is peeking it.

   Players are keyed by a stable clientId (sent by the browser and kept in
   localStorage), NOT by socket id. So a dropped connection — phone locking,
   a tab backgrounding, a flaky network — does not destroy your seat: you are
   marked "away", and rejoining with the same clientId restores your hand.
   Lobbies survive a grace period while empty so a second device can still
   join after the creator's tab briefly slept.
   ========================================================================= */

const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");
const poker = require("./poker");
const gofish = require("./gofish");
const blackjack = require("./blackjack");
const war = require("./war");
const crazy8 = require("./crazy8");
const cheat = require("./cheat");
const hearts = require("./hearts");
const spades = require("./spades");
const gin = require("./ginrummy");
const bigtwo = require("./bigtwo");
const solitaire = require("./solitaire");
const { mountPWA } = require("./pwa");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

mountPWA(app); // /manifest.webmanifest + app icons (install / add to home screen)
app.get("/", (_req, res) => { res.set("Cache-Control", "no-store"); res.sendFile(path.join(__dirname, "index.html")); });
app.get("/healthz", (_req, res) => res.send("ok"));

/* ---------- card helpers ---------- */
const SUITS = ["S", "H", "D", "C"];
const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K"];
function makeDeck() {
  const d = [];
  for (const s of SUITS) for (const r of RANKS) d.push(r + s);
  return d;
}
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous 0/O/1/I
function genCode() {
  let c;
  do {
    c = Array.from({ length: 6 }, () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]).join("");
  } while (lobbies.has(c));
  return c;
}
function genId() {
  return Math.random().toString(36).slice(2, 10);
}
function placeOnTable(lobby) {
  lobby.maxZ = (lobby.maxZ || 0) + 1;
  return { x: 0.5 + (Math.random() - 0.5) * 0.28, y: 0.42 + (Math.random() - 0.5) * 0.26, z: lobby.maxZ };
}

/* ---------- state ----------
   lobby.players: Map<clientId, { name, hand:[], connected:bool, sockId:string|null }>
   lobby.order:   [clientId]   (seat order)
*/
const lobbies = new Map();
const GRACE_MS = 3 * 60 * 1000; // keep a dropped player's seat (and an empty lobby) this long

function buildView(lobby, cid) {
  return {
    code: lobby.code,
    mode: lobby.mode || "freeform",
    deckCount: lobby.deck.length,
    table: lobby.table.map((c) => ({
      id: c.id,
      faceUp: c.faceUp,
      x: c.x, y: c.y, z: c.z,
      code: c.faceUp ? c.code : c.peekedBy === cid ? c.code : null, // value only if face up or you're the peeker
      peekedByName: c.peekedBy && lobby.players.has(c.peekedBy) ? lobby.players.get(c.peekedBy).name : null,
      peekedByMe: c.peekedBy === cid,
    })),
    players: lobby.order
      .filter((id) => lobby.players.has(id))
      .map((id) => ({ id, name: lobby.players.get(id).name, count: lobby.players.get(id).hand.length, me: id === cid, away: !lobby.players.get(id).connected })),
    myHand: lobby.players.get(cid) ? lobby.players.get(cid).hand : [],
    poker: pokerView(lobby, cid),
    gofish: (lobby.mode === "gofish") ? gofishView(lobby, cid) : null,
    blackjack: (lobby.mode === "blackjack") ? bjView(lobby, cid) : null,
    war: (lobby.mode === "war") ? warView(lobby, cid) : null,
    c8: (lobby.mode === "crazy8") ? c8View(lobby, cid) : null,
    cheat: (lobby.mode === "cheat") ? cheatView(lobby, cid) : null,
    hearts: (lobby.mode === "hearts") ? heartsView(lobby, cid) : null,
    spades: (lobby.mode === "spades") ? spadesView(lobby, cid) : null,
    gin: (lobby.mode === "gin") ? ginView(lobby, cid) : null,
    bigtwo: (lobby.mode === "bigtwo") ? bigtwoView(lobby, cid) : null,
    solitaire: (lobby.mode === "solitaire") ? solitaireView(lobby, cid) : null,
  };
}
function pokerView(lobby, cid) {
  const pk = lobby.poker;
  if (!pk || !pk.on) return null;
  const hand = pk.hand;
  const players = lobby.order.filter((id) => lobby.players.has(id)).map((id) => {
    const p = lobby.players.get(id);
    const ph = hand && hand.inHand[id];
    return {
      id, name: p.name, chips: p.chips, away: !p.connected, me: id === cid,
      inHand: !!ph, folded: ph ? ph.folded : false, allIn: ph ? ph.allIn : false, cRound: ph ? ph.cRound : 0,
      isButton: pk.buttonCid === id, isSB: hand ? hand.sbCid === id : false, isBB: hand ? hand.bbCid === id : false,
      isTurn: hand ? hand.toAct === id : false,
    };
  });
  const seatedN = lobby.order.filter((id) => { const p = lobby.players.get(id); return p && p.connected && p.chips > 0; }).length;
  const v = { on: true, sb: pk.sb, bb: pk.bb, buttonCid: pk.buttonCid, players, canStart: (!hand || hand.phase === "done") && seatedN >= 2, handLive: !!hand && hand.phase !== "done" };
  if (hand) {
    v.phase = hand.phase; v.pot = hand.pot; v.community = hand.community.slice(); v.currentBet = hand.currentBet; v.toAct = hand.toAct;
    v.myHole = hand.inHand[cid] ? hand.inHand[cid].hole : null;
    v.myFolded = hand.inHand[cid] ? hand.inHand[cid].folded : false;
    v.myTurn = hand.toAct === cid;
    v.legal = v.myTurn ? poker.legalActions(lobby, cid) : null;
    v.results = hand.phase === "done" ? hand.results : null;
    if ((hand.phase === "showdown" || hand.phase === "muck") && hand.sd) {
      const sd = hand.sd;
      v.revealing = true;
      v.shown = hand.order.filter((c) => sd.shown.has(c)).map((c) => ({
        id: c, name: lobby.players.get(c).name, hole: hand.inHand[c].hole, hand: poker.handName(sd.scores[c]),
      }));
      v.myReveal = hand.phase === "muck" && sd.pendingChoice.has(cid);
    }
  }
  return v;
}

const RANK_ORDER = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K"];
const SUIT_ORDER = ["S", "H", "C", "D"];
function cardSort(a, b) {
  const ra = RANK_ORDER.indexOf(a.slice(0, -1)), rb = RANK_ORDER.indexOf(b.slice(0, -1));
  return ra !== rb ? ra - rb : SUIT_ORDER.indexOf(a.slice(-1)) - SUIT_ORDER.indexOf(b.slice(-1));
}

function gofishView(lobby, cid) {
  const gf = lobby.gofish;
  if (!gf) return { on: true, started: false };
  const players = gf.order.filter((id) => lobby.players.has(id)).map((id) => ({
    id, name: lobby.players.get(id).name, me: id === cid, away: !lobby.players.get(id).connected,
    handCount: gf.hands[id] ? gf.hands[id].length : 0,
    books: gf.books[id] ? gf.books[id].slice() : [], booksCount: gf.books[id] ? gf.books[id].length : 0,
    isTurn: gf.turn === id,
  }));
  const myHand = gf.hands[cid] ? gf.hands[cid].slice().sort(cardSort) : [];
  const myRanks = [...new Set(myHand.map((c) => c.slice(0, -1)))];
  return {
    on: true, started: true, phase: gf.phase, poolCount: gf.deck.length, turn: gf.turn,
    players, myHand, myRanks, myTurn: gf.turn === cid, inGame: !!gf.hands[cid], locked: !!gf.locked,
    log: gf.log.slice(-5), results: gf.phase === "over" ? gf.results : null,
  };
}

function bjView(lobby, cid) {
  const bj = lobby.bj;
  if (!bj) return null;
  const me = lobby.players.get(cid);
  const dealerCards = bj.dealer.cards.map((c, i) => (bj.dealer.revealed || i === 0) ? c : null);
  const dealer = { cards: dealerCards, revealed: bj.dealer.revealed, total: bj.dealer.revealed ? blackjack.handValue(bj.dealer.cards).total : null };
  let players;
  if (bj.phase === "betting") {
    players = lobby.order.filter((id) => { const p = lobby.players.get(id); return p && p.connected; }).map((id) => ({
      id, name: lobby.players.get(id).name, me: id === cid, away: false, chips: lobby.players.get(id).chips, bet: bj.bets[id] || 0,
    }));
  } else {
    players = bj.order.filter((id) => lobby.players.has(id)).map((id) => {
      const h = bj.hands[id]; const v = blackjack.handValue(h.cards);
      return { id, name: lobby.players.get(id).name, me: id === cid, away: !lobby.players.get(id).connected,
        chips: lobby.players.get(id).chips, bet: h.bet, cards: h.cards.slice(), total: v.total, soft: v.soft,
        busted: h.busted, stood: h.stood, doubled: h.doubled, bj: h.bj, isTurn: bj.toAct === id,
        result: h.result, payout: h.payout };
    });
  }
  const h = bj.hands[cid];
  const legal = bj.toAct === cid && h ? { canHit: true, canStand: true, canDouble: h.cards.length === 2 && me.chips >= h.bet } : null;
  return {
    on: true, phase: bj.phase, minBet: bj.minBet, dealer, players,
    myChips: me ? me.chips : 0, myBet: bj.bets[cid] || 0,
    canBet: bj.phase === "betting", canDeal: bj.phase === "betting" && Object.values(bj.bets).some((b) => b > 0),
    myTurn: bj.toAct === cid, legal, inRound: bj.phase !== "betting" && !!h,
    results: bj.phase === "done" ? bj.results : null,
  };
}
/* ---- shared helpers for the extra games ---- */
function pname(lobby, id) { return lobby.players.has(id) ? lobby.players.get(id).name : "?"; }
function isConn(lobby, id) { const p = lobby.players.get(id); return !!(p && p.connected); }
const B2_RIDX = { "3": 0, "4": 1, "5": 2, "6": 3, "7": 4, "8": 5, "9": 6, T: 7, J: 8, Q: 9, K: 10, A: 11, "2": 12 };
const B2_SIDX = { C: 0, D: 1, H: 2, S: 3 };
function b2sort(a, b) { return (B2_RIDX[a.slice(0, -1)] * 4 + B2_SIDX[a.slice(-1)]) - (B2_RIDX[b.slice(0, -1)] * 4 + B2_SIDX[b.slice(-1)]); }

function warView(lobby, cid) {
  const w = lobby.war; if (!w) return { on: true, started: false };
  const lb = w.lastBattle;
  return {
    on: true, started: true, phase: w.phase,
    players: w.order.map((id) => ({ id, name: pname(lobby, id), me: id === cid, count: w.piles[id] ? w.piles[id].length : 0 })),
    inGame: w.order.includes(cid),
    lastBattle: lb ? { winner: lb.winner, war: lb.war, a: { id: w.order[0], name: pname(lobby, w.order[0]), cards: lb.a }, b: { id: w.order[1], name: pname(lobby, w.order[1]), cards: lb.b } } : null,
    log: w.log.slice(-5), winner: w.winner,
  };
}
function c8View(lobby, cid) {
  const g = lobby.c8; if (!g) return { on: true, started: false };
  return {
    on: true, started: true, phase: g.phase,
    players: g.order.map((id) => ({ id, name: pname(lobby, id), me: id === cid, away: !isConn(lobby, id), count: g.hands[id] ? g.hands[id].length : 0, isTurn: g.turn === id })),
    top: g.discard[g.discard.length - 1], suit: g.suit, stockCount: g.stock.length,
    myHand: g.hands[cid] ? g.hands[cid].slice() : [], myTurn: g.turn === cid, inGame: !!g.hands[cid], drew: g.drew,
    playable: g.hands[cid] ? g.hands[cid].filter((c) => crazy8.playable(g, c)) : [],
    log: g.log.slice(-5), winner: g.winner,
  };
}
function cheatView(lobby, cid) {
  const g = lobby.cheat; if (!g) return { on: true, started: false };
  return {
    on: true, started: true, phase: g.phase,
    players: g.order.map((id) => ({ id, name: pname(lobby, id), me: id === cid, away: !isConn(lobby, id), count: g.hands[id] ? g.hands[id].length : 0, isTurn: g.turn === id })),
    reqRank: cheat.reqRank(g), reqLabel: cheat.rankPlural(cheat.reqRank(g)), pileCount: g.pile.length,
    lastPlay: g.lastPlay ? { id: g.lastPlay.cid, name: pname(lobby, g.lastPlay.cid), count: g.lastPlay.cards.length, claimLabel: cheat.rankPlural(g.lastPlay.claimRank) } : null,
    canChallenge: !!g.lastPlay && g.lastPlay.cid !== cid && g.phase === "play",
    reveal: g.reveal,
    myHand: g.hands[cid] ? g.hands[cid].slice().sort(cardSort) : [], myTurn: g.turn === cid, inGame: !!g.hands[cid],
    log: g.log.slice(-5), winner: g.winner,
  };
}
function heartsView(lobby, cid) {
  const h = lobby.hearts; if (!h) return { on: true, started: false };
  const myHand = h.hands[cid] ? h.hands[cid].slice().sort(cardSort) : [];
  const v = {
    on: true, started: true, phase: h.phase,
    players: h.order.map((id) => ({ id, name: pname(lobby, id), me: id === cid, away: !isConn(lobby, id), count: h.hands[id] ? h.hands[id].length : 0, score: h.scores[id], isTurn: h.turn === id, isLeader: h.leader === id })),
    myHand, inGame: !!h.hands[cid], trick: h.trick.map((t) => ({ id: t.cid, name: pname(lobby, t.cid), card: t.card })),
    heartsBroken: h.heartsBroken, trickNo: h.trickNo, locked: !!h.locked, log: h.log.slice(-5),
  };
  if (h.phase === "pass") { v.passDir = ["left", "right", "across", "hold"][h.passDir % 4]; v.iPassed = !!h.pass[cid]; v.legal = myHand; }
  else if (h.phase === "play") { v.myTurn = h.turn === cid; v.legal = h.turn === cid ? hearts.legalPlays(h, cid) : []; }
  else if (h.phase === "handover") v.lastHand = h.lastHand;
  else if (h.phase === "over") v.results = h.results;
  return v;
}
function spadesView(lobby, cid) {
  const s = lobby.spades; if (!s) return { on: true, started: false };
  const myHand = s.hands[cid] ? s.hands[cid].slice().sort(cardSort) : [];
  const v = {
    on: true, started: true, phase: s.phase,
    players: s.order.map((id) => ({ id, name: pname(lobby, id), me: id === cid, away: !isConn(lobby, id), count: s.hands[id] ? s.hands[id].length : 0, team: spades.teamOf(s, id), bid: (id in s.bids) ? s.bids[id] : null, tricks: s.tricksWon[id] || 0, isTurn: (s.phase === "bid" ? s.bidTurn : s.turn) === id })),
    teams: { A: { score: s.scores.A, bags: s.bags.A }, B: { score: s.scores.B, bags: s.bags.B } },
    myHand, inGame: !!s.hands[cid], trick: s.trick.map((t) => ({ id: t.cid, name: pname(lobby, t.cid), card: t.card })),
    spadesBroken: s.spadesBroken, trickNo: s.trickNo, locked: !!s.locked, myTeam: spades.teamOf(s, cid), log: s.log.slice(-5),
  };
  if (s.phase === "bid") v.myBidTurn = s.bidTurn === cid;
  else if (s.phase === "play") { v.myTurn = s.turn === cid; v.legal = s.turn === cid ? spades.legalPlays(s, cid) : []; }
  else if (s.phase === "handover") v.lastHand = s.lastHand;
  else if (s.phase === "over") v.results = s.results;
  return v;
}
function ginView(lobby, cid) {
  const g = lobby.gin; if (!g) return { on: true, started: false };
  const myHand = g.hands[cid] ? g.hands[cid].slice() : [];
  const bm = g.hands[cid] ? gin.bestMelds(g.hands[cid]) : null;
  const v = {
    on: true, started: true, phase: g.phase,
    players: g.order.map((id) => ({ id, name: pname(lobby, id), me: id === cid, away: !isConn(lobby, id), count: g.hands[id] ? g.hands[id].length : 0, score: g.scores[id], isTurn: g.turn === id })),
    discardTop: g.discard.length ? g.discard[g.discard.length - 1] : null, stockCount: g.stock.length,
    myHand, inGame: !!g.hands[cid], myTurn: g.turn === cid,
    myDeadwood: bm ? bm.deadwoodValue : null, myMelds: bm ? bm.melds : [],
    canDraw: g.phase === "draw" && g.turn === cid, canDiscard: g.phase === "discard" && g.turn === cid, log: g.log.slice(-5),
  };
  if (g.phase === "discard" && g.turn === cid && g.hands[cid].length === 11) {
    let best = 99; for (const c of g.hands[cid]) { const dw = gin.bestMelds(g.hands[cid].filter((x) => x !== c)).deadwoodValue; if (dw < best) best = dw; }
    v.knockable = best <= 10; v.bestKnockDw = best;
  }
  if (g.phase === "handover") v.lastRound = g.lastRound;
  if (g.phase === "over") v.results = g.results;
  return v;
}
function bigtwoView(lobby, cid) {
  const g = lobby.bigtwo; if (!g) return { on: true, started: false };
  return {
    on: true, started: true, phase: g.phase,
    players: g.order.map((id) => ({ id, name: pname(lobby, id), me: id === cid, away: !isConn(lobby, id), count: g.hands[id] ? g.hands[id].length : 0, isTurn: g.turn === id, isLast: g.lastPlayer === id })),
    current: g.current ? { type: g.current.type, len: g.current.len, cards: g.currentCards } : null,
    myHand: g.hands[cid] ? g.hands[cid].slice().sort(b2sort) : [], myTurn: g.turn === cid, inGame: !!g.hands[cid], firstPlay: g.firstPlay,
    log: g.log.slice(-5), winner: g.winner,
  };
}
function solitaireView(lobby, cid) {
  const s = lobby.solitaire; if (!s) return { on: true, started: false };
  solitaire.ensureBoard(lobby, cid); const b = s.boards[cid];
  if (!b) return { on: true, started: true, board: null };
  return {
    on: true, started: true,
    board: {
      stockCount: b.stock.length, wasteTop: b.waste.length ? b.waste[b.waste.length - 1] : null, wasteCount: b.waste.length,
      foundations: { S: b.foundations.S.slice(-1)[0] || null, H: b.foundations.H.slice(-1)[0] || null, D: b.foundations.D.slice(-1)[0] || null, C: b.foundations.C.slice(-1)[0] || null },
      foundationCounts: { S: b.foundations.S.length, H: b.foundations.H.length, D: b.foundations.D.length, C: b.foundations.C.length },
      tableau: b.tableau.map((col) => col.map((x) => ({ card: x.up ? x.card : null, up: x.up }))),
      won: b.won, moves: b.moves,
    },
  };
}

function broadcast(lobby) {
  for (const p of lobby.players.values()) {
    if (p.connected && p.sockId) io.to(p.sockId).emit("state", buildView(lobby, p._cid));
  }
}
function lobbyOf(socket) {
  const code = socket.data.code;
  return code ? lobbies.get(code) : null;
}

/* return any blackjack stakes to players (used on teardown / mode switch) */
function refundBets(lobby) {
  const bj = lobby.bj; if (!bj) return;
  if (bj.phase === "betting") { for (const cid of Object.keys(bj.bets)) { const p = lobby.players.get(cid); if (p) p.chips += bj.bets[cid]; } }
  else if (bj.phase === "playing" || bj.phase === "dealer") { for (const cid of bj.order) { const p = lobby.players.get(cid); if (p && bj.hands[cid]) p.chips += bj.hands[cid].bet; } }
}

/* clear a mode's state when leaving it (mode switch / teardown) */
function teardownMode(l, mode) {
  if (mode === "poker") l.poker = null;
  else if (mode === "gofish") l.gofish = null;
  else if (mode === "blackjack") { refundBets(l); l.bj = null; }
  else if (mode === "war") l.war = null;
  else if (mode === "crazy8") l.c8 = null;
  else if (mode === "cheat") l.cheat = null;
  else if (mode === "hearts") l.hearts = null;
  else if (mode === "spades") l.spades = null;
  else if (mode === "gin") l.gin = null;
  else if (mode === "bigtwo") l.bigtwo = null;
  else if (mode === "solitaire") l.solitaire = null;
}

/* remove a player for good (explicit leave, or grace expired): return their cards, drop the seat */
function purgePlayer(lobby, cid) {
  const p = lobby.players.get(cid);
  if (!p) return;
  if (lobby.mode === "gofish" && lobby.gofish) gofish.removePlayer(lobby, cid);
  else if (lobby.mode === "blackjack" && lobby.bj) blackjack.onLeave(lobby, cid);
  else if (lobby.mode === "war" && lobby.war) war.onLeave(lobby, cid);
  else if (lobby.mode === "crazy8" && lobby.c8) crazy8.removePlayer(lobby, cid);
  else if (lobby.mode === "cheat" && lobby.cheat) cheat.removePlayer(lobby, cid);
  else if (lobby.mode === "hearts" && lobby.hearts) hearts.onLeave(lobby, cid);
  else if (lobby.mode === "spades" && lobby.spades) spades.onLeave(lobby, cid);
  else if (lobby.mode === "gin" && lobby.gin) gin.onLeave(lobby, cid);
  else if (lobby.mode === "bigtwo" && lobby.bigtwo) bigtwo.removePlayer(lobby, cid);
  else if (lobby.mode === "solitaire" && lobby.solitaire) solitaire.onLeave(lobby, cid);
  lobby.deck.push(...p.hand);
  lobby.players.delete(cid);
  lobby.order = lobby.order.filter((id) => id !== cid);
  lobby.table.forEach((c) => { if (c.peekedBy === cid) c.peekedBy = null; });
  if (lobby.players.size === 0) lobbies.delete(lobby.code);
  else broadcast(lobby);
}

/* ---------- socket handlers ---------- */
io.on("connection", (socket) => {
  // attach a player to a lobby, creating their seat or reattaching an existing one (reconnect)
  function attach(lobby, cid, name) {
    let p = lobby.players.get(cid);
    if (p) {
      p.connected = true; p.sockId = socket.id;
      if (name) p.name = name.slice(0, 16);
    } else {
      p = { name: (name || "Player").slice(0, 16), hand: [], chips: 0, connected: true, sockId: socket.id, _cid: cid };
      lobby.players.set(cid, p);
      lobby.order.push(cid);
    }
    p._cid = cid;
    socket.data.cid = cid;
    socket.data.code = lobby.code;
    socket.join(lobby.code);
  }

  socket.on("create", ({ name, clientId } = {}, cb) => {
    const cid = clientId || genId();
    const code = genCode();
    const lobby = { code, mode: "freeform", deck: makeDeck(), table: [], players: new Map(), order: [], maxZ: 0 };
    lobbies.set(code, lobby);
    attach(lobby, cid, name);
    if (cb) cb({ ok: true, code });
    broadcast(lobby);
  });

  // join doubles as reconnect: same clientId => same seat, hand preserved
  socket.on("join", ({ code, name, clientId } = {}, cb) => {
    const c = (code || "").trim().toUpperCase();
    const lobby = lobbies.get(c);
    if (!lobby) return cb && cb({ ok: false, error: "No lobby found with that code." });
    attach(lobby, clientId || genId(), name);
    if (cb) cb({ ok: true, code: c });
    broadcast(lobby);
  });

  const me = () => { const l = lobbyOf(socket); return l ? l.players.get(socket.data.cid) : null; };
  const act = (fn) => () => {
    const lobby = lobbyOf(socket); const p = me();
    if (!lobby || !p) return;
    lobby.notify = () => broadcast(lobby);
    fn(lobby, p); broadcast(lobby);
  };
  const act1 = (fn) => (arg) => {
    const lobby = lobbyOf(socket); const p = me();
    if (!lobby || !p) return;
    lobby.notify = () => broadcast(lobby);
    fn(lobby, p, arg); broadcast(lobby);
  };

  socket.on("shuffle", act((l) => { l.deck = shuffle(l.deck); }));
  socket.on("dealToMe", act((l, p) => { if (l.deck.length) p.hand.push(l.deck.shift()); }));
  socket.on("dealToTable", act((l) => {
    if (l.deck.length) l.table.push({ id: genId(), code: l.deck.shift(), faceUp: false, peekedBy: null, ...placeOnTable(l) });
  }));
  socket.on("dealToPlayer", act1((l, _p, { pid } = {}) => {
    if (l.deck.length && l.players.has(pid)) l.players.get(pid).hand.push(l.deck.shift());
  }));
  socket.on("dealRound", act((l) => {
    for (const cid of l.order) {
      if (!l.deck.length) break;
      const p = l.players.get(cid);
      if (p) p.hand.push(l.deck.shift());
    }
  }));
  socket.on("dealMany", act1((l, _p, { pid, n } = {}) => {
    if (!l.players.has(pid)) return;
    let k = Math.max(1, Math.min(20, parseInt(n, 10) || 1));
    while (k-- > 0 && l.deck.length) l.players.get(pid).hand.push(l.deck.shift());
  }));
  socket.on("flip", act1((l, _p, { id } = {}) => {
    const c = l.table.find((t) => t.id === id);
    if (c) { c.faceUp = !c.faceUp; if (c.faceUp) c.peekedBy = null; }
  }));
  socket.on("peek", act1((l, _p, { id } = {}) => {
    const c = l.table.find((t) => t.id === id);
    if (c && !c.faceUp) c.peekedBy = c.peekedBy === socket.data.cid ? null : socket.data.cid;
  }));
  socket.on("takeFromTable", act1((l, p, { id } = {}) => {
    const i = l.table.findIndex((t) => t.id === id);
    if (i >= 0) p.hand.push(l.table.splice(i, 1)[0].code);
  }));
  socket.on("tableToDeck", act1((l, _p, { id } = {}) => {
    const i = l.table.findIndex((t) => t.id === id);
    if (i >= 0) l.deck.push(l.table.splice(i, 1)[0].code);
  }));
  socket.on("playFromHand", act1((l, p, { code, faceUp, x, y } = {}) => {
    const i = p.hand.indexOf(code);
    if (i < 0) return;
    p.hand.splice(i, 1);
    const pos = (typeof x === "number" && typeof y === "number")
      ? { x: Math.min(0.97, Math.max(0.03, x)), y: Math.min(0.94, Math.max(0.06, y)), z: (l.maxZ = (l.maxZ || 0) + 1) }
      : placeOnTable(l);
    l.table.push({ id: genId(), code, faceUp: !!faceUp, peekedBy: null, ...pos });
  }));
  socket.on("handToDeck", act1((l, p, { code } = {}) => {
    const i = p.hand.indexOf(code);
    if (i >= 0) l.deck.push(p.hand.splice(i, 1)[0]);
  }));
  socket.on("reorderHand", act1((l, p, { order } = {}) => {
    if (!Array.isArray(order)) return;
    const cur = p.hand.slice().sort().join(",");
    const next = order.slice().sort().join(",");
    if (cur === next) p.hand = order.slice(); // accept only a true permutation of the current hand
  }));

  /* ---- game mode ---- */
  // Switch the table's active game. Implemented modes do real setup; others just
  // record the mode (their engines arrive in later pushes). Poker init/teardown lives here.
  socket.on("setMode", act1((l, _p, { mode } = {}) => {
    const m = String(mode || "freeform");
    if (m === l.mode) return;
    teardownMode(l, l.mode);
    if (m === "poker") { if (!l.poker || !l.poker.on) l.poker = { on: true, sb: 5, bb: 10, buttonCid: null, hand: null }; }
    if (m === "blackjack") blackjack.startRound(l); // open a betting round
    l.mode = m; // war/crazy8/cheat/hearts/spades/gin/bigtwo/solitaire deal on their Start button
  }));

  /* ---- Go Fish ---- */
  socket.on("gofishStart", act((l) => { if (l.mode === "gofish") gofish.startGame(l); }));
  socket.on("gofishAsk", act1((l, _p, { target, rank } = {}) => { if (l.mode === "gofish" && l.gofish) gofish.ask(l, socket.data.cid, target, rank); }));

  /* ---- Blackjack ---- */
  socket.on("bjStart", act((l) => { if (l.mode === "blackjack") blackjack.startRound(l); }));
  socket.on("bjBet", act1((l, _p, { amount } = {}) => { if (l.mode === "blackjack" && l.bj) blackjack.placeBet(l, socket.data.cid, parseInt(amount, 10) || 0); }));
  socket.on("bjDeal", act((l) => { if (l.mode === "blackjack" && l.bj) blackjack.deal(l); }));
  socket.on("bjAction", act1((l, _p, { action } = {}) => { if (l.mode === "blackjack" && l.bj) blackjack.action(l, socket.data.cid, action); }));

  /* ---- War ---- */
  socket.on("warStart", act((l) => { if (l.mode === "war") war.startGame(l); }));
  socket.on("warFlip", act((l) => { if (l.mode === "war" && l.war) war.flip(l, socket.data.cid); }));

  /* ---- Crazy Eights ---- */
  socket.on("c8Start", act((l) => { if (l.mode === "crazy8") crazy8.startGame(l); }));
  socket.on("c8Play", act1((l, _p, { card, suit } = {}) => { if (l.mode === "crazy8" && l.c8) crazy8.play(l, socket.data.cid, card, suit); }));
  socket.on("c8Draw", act((l) => { if (l.mode === "crazy8" && l.c8) crazy8.draw(l, socket.data.cid); }));
  socket.on("c8Pass", act((l) => { if (l.mode === "crazy8" && l.c8) crazy8.pass(l, socket.data.cid); }));

  /* ---- Cheat ---- */
  socket.on("cheatStart", act((l) => { if (l.mode === "cheat") cheat.startGame(l); }));
  socket.on("cheatPlay", act1((l, _p, { cards } = {}) => { if (l.mode === "cheat" && l.cheat) cheat.play(l, socket.data.cid, cards); }));
  socket.on("cheatChallenge", act((l) => { if (l.mode === "cheat" && l.cheat) cheat.challenge(l, socket.data.cid); }));

  /* ---- Hearts ---- */
  socket.on("heartsStart", act((l) => { if (l.mode === "hearts") hearts.startGame(l); }));
  socket.on("heartsPass", act1((l, _p, { cards } = {}) => { if (l.mode === "hearts" && l.hearts) hearts.selectPass(l, socket.data.cid, cards); }));
  socket.on("heartsPlay", act1((l, _p, { card } = {}) => { if (l.mode === "hearts" && l.hearts) hearts.playCard(l, socket.data.cid, card); }));
  socket.on("heartsNext", act((l) => { if (l.mode === "hearts" && l.hearts) hearts.nextHand(l); }));

  /* ---- Spades ---- */
  socket.on("spadesStart", act((l) => { if (l.mode === "spades") spades.startGame(l); }));
  socket.on("spadesBid", act1((l, _p, { n } = {}) => { if (l.mode === "spades" && l.spades) spades.bid(l, socket.data.cid, n); }));
  socket.on("spadesPlay", act1((l, _p, { card } = {}) => { if (l.mode === "spades" && l.spades) spades.playCard(l, socket.data.cid, card); }));
  socket.on("spadesNext", act((l) => { if (l.mode === "spades" && l.spades) spades.nextHand(l); }));

  /* ---- Gin Rummy ---- */
  socket.on("ginStart", act((l) => { if (l.mode === "gin") gin.startGame(l); }));
  socket.on("ginDrawStock", act((l) => { if (l.mode === "gin" && l.gin) gin.drawStock(l, socket.data.cid); }));
  socket.on("ginDrawDiscard", act((l) => { if (l.mode === "gin" && l.gin) gin.drawDiscard(l, socket.data.cid); }));
  socket.on("ginDiscard", act1((l, _p, { card, knock } = {}) => { if (l.mode === "gin" && l.gin) gin.discard(l, socket.data.cid, card, !!knock); }));
  socket.on("ginNext", act((l) => { if (l.mode === "gin" && l.gin) gin.nextHand(l); }));

  /* ---- Big Two ---- */
  socket.on("bigtwoStart", act((l) => { if (l.mode === "bigtwo") bigtwo.startGame(l); }));
  socket.on("bigtwoPlay", act1((l, _p, { cards } = {}) => { if (l.mode === "bigtwo" && l.bigtwo) bigtwo.play(l, socket.data.cid, cards); }));
  socket.on("bigtwoPass", act((l) => { if (l.mode === "bigtwo" && l.bigtwo) bigtwo.pass(l, socket.data.cid); }));

  /* ---- Solitaire ---- */
  socket.on("solStart", act((l) => { if (l.mode === "solitaire") solitaire.startGame(l); }));
  socket.on("solNew", act((l) => { if (l.mode === "solitaire" && l.solitaire) solitaire.newBoard(l, socket.data.cid); }));
  socket.on("solDraw", act((l) => { if (l.mode === "solitaire" && l.solitaire) solitaire.draw(l, socket.data.cid); }));
  socket.on("solMove", act1((l, _p, { from, to } = {}) => { if (l.mode === "solitaire" && l.solitaire) solitaire.move(l, socket.data.cid, from, to); }));

  /* chips work across chip games (poker, blackjack) */
  socket.on("addChips", act1((l, p, { amount, pid } = {}) => {
    const a = Math.max(1, Math.min(100000, parseInt(amount, 10) || 0));
    const t = pid && l.players.has(pid) ? l.players.get(pid) : p;
    t.chips += a;
  }));

  /* ---- poker ---- */
  socket.on("pokerOn", act((l) => { if (!l.poker || !l.poker.on) l.poker = { on: true, sb: 5, bb: 10, buttonCid: null, hand: null }; l.mode = "poker"; }));
  socket.on("pokerOff", act((l) => { l.poker = null; l.mode = "freeform"; }));
  socket.on("pokerAddChips", act1((l, p, { amount, pid } = {}) => {
    const a = Math.max(1, Math.min(100000, parseInt(amount, 10) || 0));
    if (!l.poker || !l.poker.on) return;
    const target = pid && l.players.has(pid) ? l.players.get(pid) : p;
    target.chips += a;
  }));
  socket.on("pokerStart", act((l) => { if (l.poker && l.poker.on) poker.startHand(l); }));
  socket.on("pokerAction", act1((l, _p, { action, amount } = {}) => {
    if (l.poker && l.poker.on && l.poker.hand) poker.applyAction(l, socket.data.cid, action, parseInt(amount, 10) || 0);
  }));
  socket.on("pokerReveal", act1((l, _p, { show } = {}) => {
    if (l.poker && l.poker.on && l.poker.hand) poker.applyReveal(l, socket.data.cid, !!show);
  }));
  socket.on("collectAll", act((l) => {
    l.table.forEach((c) => l.deck.push(c.code));
    for (const p of l.players.values()) { l.deck.push(...p.hand); p.hand = []; }
    l.table = [];
    l.deck = shuffle(l.deck);
  }));

  socket.on("dragMove", ({ id, x, y } = {}) => {
    const lobby = lobbyOf(socket);
    if (!lobby) return;
    const c = lobby.table.find((t) => t.id === id);
    if (!c) return;
    c.x = x; c.y = y;
    socket.to(lobby.code).emit("cardMoved", { id, x, y });
  });
  socket.on("dropCard", ({ id, x, y } = {}) => {
    const lobby = lobbyOf(socket);
    if (!lobby) return;
    const c = lobby.table.find((t) => t.id === id);
    if (!c) return;
    c.x = x; c.y = y; lobby.maxZ = (lobby.maxZ || 0) + 1; c.z = lobby.maxZ;
    broadcast(lobby);
  });

  // explicit leave: gone immediately
  socket.on("leave", () => {
    const lobby = lobbyOf(socket); const cid = socket.data.cid;
    socket.data.code = null; socket.data.cid = null;
    if (lobby && cid) purgePlayer(lobby, cid);
  });

  // accidental drop: keep the seat, mark away, purge only if still gone after the grace period
  socket.on("disconnect", () => {
    const lobby = lobbyOf(socket); const cid = socket.data.cid;
    if (!lobby || !cid) return;
    const p = lobby.players.get(cid);
    if (!p || p.sockId !== socket.id) return; // a newer socket already took over this seat
    p.connected = false; p.sockId = null;
    if (lobby.poker && lobby.poker.hand) poker.foldOnLeave(lobby, cid); // don't stall the table mid-hand
    if (lobby.mode === "gofish" && lobby.gofish) gofish.skipTurn(lobby, cid);
    else if (lobby.mode === "blackjack" && lobby.bj) blackjack.onLeave(lobby, cid);
    else if (lobby.mode === "crazy8" && lobby.c8) crazy8.skipTurn(lobby, cid);
    else if (lobby.mode === "cheat" && lobby.cheat) cheat.skipTurn(lobby, cid);
    else if (lobby.mode === "bigtwo" && lobby.bigtwo) bigtwo.skipTurn(lobby, cid);
    broadcast(lobby);
    setTimeout(() => {
      const lb = lobbies.get(lobby.code);
      if (!lb) return;
      const pp = lb.players.get(cid);
      if (pp && !pp.connected) purgePlayer(lb, cid); // still away after grace -> remove
    }, GRACE_MS);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Card Lobby server listening on :" + PORT));
