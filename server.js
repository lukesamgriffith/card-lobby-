/* =========================================================================
   Card Lobby — authoritative real-time server.

   The server holds the one true copy of every lobby's state. Because it
   decides what each client receives, hidden information is genuinely hidden:
   a player's hand is only ever sent to that player's own socket, and a
   face-down table card's value is sent only to whoever is peeking it.
   ========================================================================= */

const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "index.html")));
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
// assign a position (fractions of the table) + stacking order to a card landing on the table
function placeOnTable(lobby) {
  lobby.maxZ = (lobby.maxZ || 0) + 1;
  return { x: 0.5 + (Math.random() - 0.5) * 0.28, y: 0.42 + (Math.random() - 0.5) * 0.26, z: lobby.maxZ };
}

/* ---------- state ---------- */
/** code -> { code, deck:[], table:[{id,code,faceUp,peekedBy}], players:Map<sid,{name,hand:[]}>, order:[sid] } */
const lobbies = new Map();

function buildView(lobby, sid) {
  return {
    code: lobby.code,
    deckCount: lobby.deck.length,
    table: lobby.table.map((c) => ({
      id: c.id,
      faceUp: c.faceUp,
      x: c.x, y: c.y, z: c.z,
      // value revealed only when face up, or to the peeker themselves
      code: c.faceUp ? c.code : c.peekedBy === sid ? c.code : null,
      peekedByName: c.peekedBy && lobby.players.has(c.peekedBy) ? lobby.players.get(c.peekedBy).name : null,
      peekedByMe: c.peekedBy === sid,
    })),
    players: lobby.order
      .filter((id) => lobby.players.has(id))
      .map((id) => ({ id, name: lobby.players.get(id).name, count: lobby.players.get(id).hand.length, me: id === sid })),
    myHand: lobby.players.get(sid) ? lobby.players.get(sid).hand : [],
  };
}
function broadcast(lobby) {
  for (const sid of lobby.players.keys()) io.to(sid).emit("state", buildView(lobby, sid));
}
function lobbyOf(socket) {
  const code = socket.data.code;
  return code ? lobbies.get(code) : null;
}
function cleanupIfEmpty(lobby) {
  if (lobby && lobby.players.size === 0) lobbies.delete(lobby.code);
}

/* ---------- socket handlers ---------- */
io.on("connection", (socket) => {
  socket.on("create", ({ name } = {}, cb) => {
    const code = genCode();
    const lobby = { code, deck: makeDeck(), table: [], players: new Map(), order: [], maxZ: 0 };
    lobby.players.set(socket.id, { name: (name || "Player").slice(0, 16), hand: [] });
    lobby.order.push(socket.id);
    lobbies.set(code, lobby);
    socket.data.code = code;
    socket.join(code);
    if (cb) cb({ ok: true, code });
    broadcast(lobby);
  });

  socket.on("join", ({ code, name } = {}, cb) => {
    const c = (code || "").trim().toUpperCase();
    const lobby = lobbies.get(c);
    if (!lobby) return cb && cb({ ok: false, error: "No lobby found with that code." });
    lobby.players.set(socket.id, { name: (name || "Player").slice(0, 16), hand: [] });
    lobby.order.push(socket.id);
    socket.data.code = c;
    socket.join(c);
    if (cb) cb({ ok: true, code: c });
    broadcast(lobby);
  });

  /* a tiny helper so each action mutates then re-broadcasts */
  const act = (fn) => () => {
    const lobby = lobbyOf(socket);
    if (!lobby || !lobby.players.has(socket.id)) return;
    fn(lobby, lobby.players.get(socket.id));
    broadcast(lobby);
  };
  const act1 = (fn) => (arg) => {
    const lobby = lobbyOf(socket);
    if (!lobby || !lobby.players.has(socket.id)) return;
    fn(lobby, lobby.players.get(socket.id), arg);
    broadcast(lobby);
  };

  socket.on("shuffle", act((l) => { l.deck = shuffle(l.deck); }));

  socket.on("dealToMe", act((l, me) => { if (l.deck.length) me.hand.push(l.deck.shift()); }));

  socket.on("dealToTable", act((l) => {
    if (l.deck.length) l.table.push({ id: genId(), code: l.deck.shift(), faceUp: false, peekedBy: null, ...placeOnTable(l) });
  }));

  socket.on("dealToPlayer", act1((l, _me, { pid } = {}) => {
    if (l.deck.length && l.players.has(pid)) l.players.get(pid).hand.push(l.deck.shift());
  }));

  socket.on("flip", act1((l, _me, { id } = {}) => {
    const c = l.table.find((t) => t.id === id);
    if (c) { c.faceUp = !c.faceUp; if (c.faceUp) c.peekedBy = null; }
  }));

  socket.on("peek", act1((l, _me, { id } = {}) => {
    const c = l.table.find((t) => t.id === id);
    if (c && !c.faceUp) c.peekedBy = c.peekedBy === socket.id ? null : socket.id;
  }));

  socket.on("takeFromTable", act1((l, me, { id } = {}) => {
    const i = l.table.findIndex((t) => t.id === id);
    if (i >= 0) me.hand.push(l.table.splice(i, 1)[0].code);
  }));

  socket.on("tableToDeck", act1((l, _me, { id } = {}) => {
    const i = l.table.findIndex((t) => t.id === id);
    if (i >= 0) l.deck.push(l.table.splice(i, 1)[0].code);
  }));

  socket.on("playFromHand", act1((l, me, { code, faceUp } = {}) => {
    const i = me.hand.indexOf(code);
    if (i >= 0) { me.hand.splice(i, 1); l.table.push({ id: genId(), code, faceUp: !!faceUp, peekedBy: null, ...placeOnTable(l) }); }
  }));

  socket.on("handToDeck", act1((l, me, { code } = {}) => {
    const i = me.hand.indexOf(code);
    if (i >= 0) l.deck.push(me.hand.splice(i, 1)[0]);
  }));

  socket.on("collectAll", act((l) => {
    l.table.forEach((c) => l.deck.push(c.code));
    for (const p of l.players.values()) { l.deck.push(...p.hand); p.hand = []; }
    l.table = [];
    l.deck = shuffle(l.deck);
  }));

  // live drag: relay position to the OTHERS in the room only (no z change, no heavy full rebroadcast)
  socket.on("dragMove", ({ id, x, y } = {}) => {
    const lobby = lobbyOf(socket);
    if (!lobby) return;
    const c = lobby.table.find((t) => t.id === id);
    if (!c) return;
    c.x = x; c.y = y;
    socket.to(lobby.code).emit("cardMoved", { id, x, y });
  });
  // drop: finalize position, bring to the top of the stack, full reconcile for everyone
  socket.on("dropCard", ({ id, x, y } = {}) => {
    const lobby = lobbyOf(socket);
    if (!lobby) return;
    const c = lobby.table.find((t) => t.id === id);
    if (!c) return;
    c.x = x; c.y = y; lobby.maxZ = (lobby.maxZ || 0) + 1; c.z = lobby.maxZ;
    broadcast(lobby);
  });

  function removeFromLobby() {
    const lobby = lobbyOf(socket);
    if (!lobby) return;
    const me = lobby.players.get(socket.id);
    if (me) lobby.deck.push(...me.hand); // return cards to deck
    lobby.players.delete(socket.id);
    lobby.order = lobby.order.filter((id) => id !== socket.id);
    lobby.table.forEach((c) => { if (c.peekedBy === socket.id) c.peekedBy = null; });
    socket.data.code = null;
    if (lobby.players.size === 0) cleanupIfEmpty(lobby);
    else broadcast(lobby);
  }

  socket.on("leave", () => { removeFromLobby(); });
  socket.on("disconnect", () => { removeFromLobby(); });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Card Lobby server listening on :" + PORT));
