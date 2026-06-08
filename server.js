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

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

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
  }
  return v;
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

/* remove a player for good (explicit leave, or grace expired): return their cards, drop the seat */
function purgePlayer(lobby, cid) {
  const p = lobby.players.get(cid);
  if (!p) return;
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
    const lobby = { code, deck: makeDeck(), table: [], players: new Map(), order: [], maxZ: 0 };
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
    fn(lobby, p); broadcast(lobby);
  };
  const act1 = (fn) => (arg) => {
    const lobby = lobbyOf(socket); const p = me();
    if (!lobby || !p) return;
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

  /* ---- poker ---- */
  socket.on("pokerOn", act((l) => { if (!l.poker || !l.poker.on) l.poker = { on: true, sb: 5, bb: 10, buttonCid: null, hand: null }; }));
  socket.on("pokerOff", act((l) => { l.poker = null; }));
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
