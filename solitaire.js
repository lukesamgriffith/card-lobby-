/* =========================================================================
   Solitaire — Klondike, draw-one (solo; each player gets their own board).
   7 tableau columns, stock/waste, 4 foundations. Build foundations up by suit
   from Ace; build tableau down in alternating colours; only Kings to empties.

   lobby.solitaire = { boards: { cid: board } }
   board = { stock, waste, foundations:{S,H,D,C}, tableau:[[{card,up}]*7],
             won, moves }
   ========================================================================= */
const { makeDeck, shuffle } = require("./poker");
const RANK = { A: 1, "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8, "9": 9, T: 10, J: 11, Q: 12, K: 13 };
const rankOf = (c) => c.slice(0, -1), suitOf = (c) => c.slice(-1);
const isRed = (c) => suitOf(c) === "H" || suitOf(c) === "D";
const seated = (lobby) => lobby.order.filter((cid) => { const p = lobby.players.get(cid); return p && p.connected; });

function deal() {
  const deck = shuffle(makeDeck());
  const tableau = [[], [], [], [], [], [], []];
  let k = 0;
  for (let col = 0; col < 7; col++) for (let row = 0; row <= col; row++) tableau[col].push({ card: deck[k++], up: row === col });
  return { stock: deck.slice(k), waste: [], foundations: { S: [], H: [], D: [], C: [] }, tableau, won: false, moves: 0 };
}
function startGame(lobby) {
  const s = { boards: {} };
  for (const cid of seated(lobby)) s.boards[cid] = deal();
  lobby.solitaire = s; return { ok: true };
}
function ensureBoard(lobby, cid) { const s = lobby.solitaire; if (s && !s.boards[cid]) s.boards[cid] = deal(); }
function newBoard(lobby, cid) { const s = lobby.solitaire; if (!s) return { error: "No game." }; s.boards[cid] = deal(); return { ok: true }; }

function draw(lobby, cid) {
  const s = lobby.solitaire; if (!s) return { error: "No game." };
  const b = s.boards[cid]; if (!b) return { error: "No board." };
  if (b.stock.length) b.waste.push(b.stock.pop());
  else if (b.waste.length) { b.stock = b.waste.slice().reverse(); b.waste = []; }
  b.moves++; return { ok: true };
}
function foundationAccepts(b, suit, card) {
  if (suitOf(card) !== suit) return false;
  const f = b.foundations[suit];
  return f.length ? RANK[rankOf(card)] === RANK[rankOf(f[f.length - 1])] + 1 : rankOf(card) === "A";
}
function tableauAccepts(b, col, card) {
  const t = b.tableau[col];
  if (!t.length) return rankOf(card) === "K";
  const top = t[t.length - 1]; if (!top.up) return false;
  return isRed(top.card) !== isRed(card) && RANK[rankOf(top.card)] === RANK[rankOf(card)] + 1;
}
function validRun(t, index) {
  for (let i = index; i < t.length; i++) {
    if (!t[i].up) return false;
    if (i > index) { const a = t[i - 1].card, c = t[i].card; if (!(isRed(a) !== isRed(c) && RANK[rankOf(a)] === RANK[rankOf(c)] + 1)) return false; }
  }
  return true;
}
// from/to: {zone:'waste'} | {zone:'foundation',suit} | {zone:'tableau',col,index?}
function move(lobby, cid, from, to) {
  const s = lobby.solitaire; if (!s) return { error: "No game." };
  const b = s.boards[cid]; if (!b) return { error: "No board." };
  let moving = []; // array of card codes (in order, bottom first)
  if (from.zone === "waste") { if (!b.waste.length) return { error: "Waste is empty." }; moving = [b.waste[b.waste.length - 1]]; }
  else if (from.zone === "foundation") { const f = b.foundations[from.suit]; if (!f.length) return { error: "Empty foundation." }; moving = [f[f.length - 1]]; }
  else if (from.zone === "tableau") {
    const t = b.tableau[from.col]; const idx = from.index;
    if (idx == null || idx < 0 || idx >= t.length) return { error: "Bad source." };
    if (!validRun(t, idx)) return { error: "Not a movable run." };
    moving = t.slice(idx).map((x) => x.card);
  } else return { error: "Bad source." };

  const bottom = moving[0];
  if (to.zone === "foundation") {
    if (moving.length !== 1) return { error: "Only one card to a foundation." };
    if (!foundationAccepts(b, to.suit, bottom)) return { error: "Can't place there." };
  } else if (to.zone === "tableau") {
    if (!tableauAccepts(b, to.col, bottom)) return { error: "Can't place there." };
  } else return { error: "Bad destination." };

  // remove from source
  if (from.zone === "waste") b.waste.pop();
  else if (from.zone === "foundation") b.foundations[from.suit].pop();
  else { const t = b.tableau[from.col]; t.splice(from.index); if (t.length && !t[t.length - 1].up) t[t.length - 1].up = true; }
  // add to destination
  if (to.zone === "foundation") b.foundations[to.suit].push(bottom);
  else for (const c of moving) b.tableau[to.col].push({ card: c, up: true });

  b.moves++;
  if (["S", "H", "D", "C"].every((su) => b.foundations[su].length === 13)) b.won = true;
  return { ok: true };
}
function onLeave(lobby, cid) { const s = lobby.solitaire; if (s && s.boards[cid]) delete s.boards[cid]; }

module.exports = { startGame, ensureBoard, newBoard, draw, move, onLeave };
