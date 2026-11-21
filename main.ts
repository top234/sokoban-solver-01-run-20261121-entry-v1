// Sokoban solver for make.fun sokoban-solver-01-run-20261121.
//
// The generator builds every level as a 1-wide hallway with 1-4 small
// rooms off it, each room holding 3-4 boxes and as many goals, and a box
// pushed out of a room can never come back, so the rooms are independent
// problems joined only by the player's walk. This solver finds the rooms
// by connectivity, solves each one on its own with a push-based A*
// (min-cost box-to-goal assignment heuristic, dead-square and frozen
// 2x2 pruning, canonical player regions), falls back to a push BFS when
// A* exhausts its state budget, and stitches the rooms together with
// BFS walks along the hallway.
//
// Deterministic: every budget is a count of expanded states, never the
// clock; every search breaks ties by insertion order; neighbour order
// is fixed everywhere. No randomness, no clock reads, no environment
// reads beyond the input/output directory overrides (the grader sets
// neither, so the /input and /output defaults apply there).
//
// Local run:
//   INPUT_DIR=<kit>/practice/input OUTPUT_DIR=out node main.ts

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.INPUT_DIR ?? process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.OUTPUT_DIR ?? process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** Per-room state budget for the A* pass, and for the BFS fallback pass. */
const ASTAR_CAP = 250_000;
const BFS_CAP = 500_000;
/** Whole-run budget across every instance and every pass: a timeout
 *  scores nothing, so the search gives up on a room rather than risk it. */
const TOTAL_CAP = 2_000_000;

/** Fixed neighbour order (up, down, left, right) used by every search. */
const DIRS = [
  { dx: 0, dy: -1, ch: 'u' },
  { dx: 0, dy: 1, ch: 'd' },
  { dx: -1, dy: 0, ch: 'l' },
  { dx: 1, dy: 0, ch: 'r' },
];

interface Level {
  w: number;
  h: number;
  wall: Uint8Array;
  goal: Uint8Array;
  boxes: number[];
  player: number;
}

function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const w = Math.max(...rows.map((r) => r.length));
  const h = rows.length;
  const wall = new Uint8Array(w * h).fill(1);
  const goal = new Uint8Array(w * h);
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goal[i] = 1;
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  boxes.sort((a, b) => a - b);
  return { w, h, wall, goal, boxes, player };
}

/** The cell `dx, dy` away from `i`, or -1 past the board's edge. */
function step(lv: Level, i: number, dx: number, dy: number): number {
  const x = i % lv.w;
  const y = (i - x) / lv.w;
  const nx = x + dx;
  const ny = y + dy;
  if (nx < 0 || nx >= lv.w || ny < 0 || ny >= lv.h) return -1;
  return ny * lv.w + nx;
}

interface Region {
  prev: Int32Array;
  prevCh: Uint8Array;
  cells: number[];
  min: number;
  has: Uint8Array;
}

/** Every cell reachable from `from` over `open` cells avoiding `blocked`,
 *  with the BFS tree for path reconstruction. */
function bfsRegion(lv: Level, open: Uint8Array, blocked: Uint8Array, from: number): Region {
  const size = lv.w * lv.h;
  const prev = new Int32Array(size).fill(-1);
  const prevCh = new Uint8Array(size);
  const has = new Uint8Array(size);
  const cells: number[] = [from];
  prev[from] = from;
  has[from] = 1;
  let min = from;
  for (let qi = 0; qi < cells.length; qi++) {
    const c = cells[qi];
    for (let di = 0; di < 4; di++) {
      const d = DIRS[di];
      const n = step(lv, c, d.dx, d.dy);
      if (n < 0 || !open[n] || blocked[n] || prev[n] >= 0) continue;
      prev[n] = c;
      prevCh[n] = di;
      has[n] = 1;
      if (n < min) min = n;
      cells.push(n);
    }
  }
  return { prev, prevCh, cells, min, has };
}

/** The walk from `from` to `to` along a region's BFS tree. */
function pathFrom(region: Region, from: number, to: number): string {
  let s = '';
  let cur = to;
  while (cur !== from) {
    s = DIRS[region.prevCh[cur]].ch + s;
    cur = region.prev[cur];
  }
  return s;
}

interface Room {
  cells: number[];
  /** Room cells plus the hallway cell outside the door: where the player may stand. */
  open: Uint8Array;
  /** Room cells only: where boxes may stand. */
  isRoom: Uint8Array;
  boxes: number[];
  goals: number[];
  door: number;
  entry: number;
  dead: Uint8Array;
}

/** Squares a box can never leave towards a goal: unreachable from any
 *  goal by flood, plus wall-line runs (a maximal run of open cells with
 *  no goal, every cell walled on the same side, traps a box in the run). */
function computeDead(lv: Level, room: Room): Uint8Array {
  const { w, h } = lv;
  const dead = new Uint8Array(w * h);
  const reach = new Uint8Array(w * h);
  const q: number[] = [];
  for (const g of room.goals) {
    reach[g] = 1;
    q.push(g);
  }
  for (let qi = 0; qi < q.length; qi++) {
    const c = q[qi];
    for (const d of DIRS) {
      const n = step(lv, c, d.dx, d.dy);
      if (n >= 0 && room.open[n] && !reach[n]) {
        reach[n] = 1;
        q.push(n);
      }
    }
  }
  for (const c of room.cells) if (!reach[c]) dead[c] = 1;
  const walled = (c: number, dx: number, dy: number): boolean => {
    const n = step(lv, c, dx, dy);
    return n < 0 || !room.open[n];
  };
  // Horizontal runs: no goal, every cell walled above (or below).
  for (let y = 0; y < h; y++) {
    let x = 0;
    while (x < w) {
      if (!room.open[y * w + x]) {
        x++;
        continue;
      }
      const run: number[] = [];
      while (x < w && room.open[y * w + x]) {
        run.push(y * w + x);
        x++;
      }
      if (run.some((c) => lv.goal[c])) continue;
      if (run.every((c) => walled(c, 0, -1))) for (const c of run) dead[c] = 1;
      if (run.every((c) => walled(c, 0, 1))) for (const c of run) dead[c] = 1;
    }
  }
  // Vertical runs: no goal, every cell walled left (or right).
  for (let x = 0; x < w; x++) {
    let y = 0;
    while (y < h) {
      if (!room.open[y * w + x]) {
        y++;
        continue;
      }
      const run: number[] = [];
      while (y < h && room.open[y * w + x]) {
        run.push(y * w + x);
        y++;
      }
      if (run.some((c) => lv.goal[c])) continue;
      if (run.every((c) => walled(c, -1, 0))) for (const c of run) dead[c] = 1;
      if (run.every((c) => walled(c, 1, 0))) for (const c of run) dead[c] = 1;
    }
  }
  return dead;
}

/** The rooms: connected floor components off the player's (hallway) row
 *  that hold boxes, each with its door onto the hallway. */
function findRooms(lv: Level): Room[] {
  const hallRow = Math.floor(lv.player / lv.w);
  const size = lv.w * lv.h;
  const seen = new Uint8Array(size);
  const rooms: Room[] = [];
  for (let i = 0; i < size; i++) {
    if (lv.wall[i] || seen[i] || Math.floor(i / lv.w) === hallRow) continue;
    const cells: number[] = [];
    const q: number[] = [i];
    seen[i] = 1;
    for (let qi = 0; qi < q.length; qi++) {
      const c = q[qi];
      cells.push(c);
      for (const d of DIRS) {
        const n = step(lv, c, d.dx, d.dy);
        if (n < 0 || lv.wall[n] || seen[n] || Math.floor(n / lv.w) === hallRow) continue;
        seen[n] = 1;
        q.push(n);
      }
    }
    cells.sort((a, b) => a - b);
    const inComp = new Uint8Array(size);
    for (const c of cells) inComp[c] = 1;
    const boxes = lv.boxes.filter((b) => inComp[b]);
    if (boxes.length === 0) continue;
    const goals = cells.filter((c) => lv.goal[c]);
    let door = -1;
    let entry = -1;
    for (const c of cells) {
      for (const dy of [-1, 1]) {
        const n = step(lv, c, 0, dy);
        if (n >= 0 && Math.floor(n / lv.w) === hallRow && !lv.wall[n]) {
          door = c;
          entry = n;
          break;
        }
      }
      if (door >= 0) break;
    }
    if (door < 0) continue;
    const open = new Uint8Array(size);
    for (const c of cells) open[c] = 1;
    open[entry] = 1;
    const room: Room = { cells, open, isRoom: inComp, boxes, goals, door, entry, dead: new Uint8Array(size) };
    room.dead = computeDead(lv, room);
    rooms.push(room);
  }
  return rooms;
}

/** A 2x2 block is frozen when every cell is a wall or a box and none is
 *  a goal. Only blocks holding the just-moved box can newly freeze. */
function frozen2x2(lv: Level, room: Room, boxes: number[], moved: number): boolean {
  const w = lv.w;
  const x = moved % w;
  const y = (moved - x) / w;
  for (let oy = -1; oy <= 0; oy++) {
    for (let ox = -1; ox <= 0; ox++) {
      const x0 = x + ox;
      const y0 = y + oy;
      if (x0 < 0 || y0 < 0 || x0 + 1 >= w || y0 + 1 >= lv.h) continue;
      let frozen = true;
      for (let dy = 0; dy < 2 && frozen; dy++) {
        for (let dx = 0; dx < 2 && frozen; dx++) {
          const c = (y0 + dy) * w + (x0 + dx);
          if (lv.goal[c]) frozen = false;
          else if (room.open[c] && !boxes.includes(c)) frozen = false;
        }
      }
      if (frozen) return true;
    }
  }
  return false;
}

function allPermutations(n: number): number[][] {
  const out: number[][] = [];
  const a = Array.from({ length: n }, (_, i) => i);
  const gen = (k: number): void => {
    if (k === n) {
      out.push([...a]);
      return;
    }
    for (let i = k; i < n; i++) {
      const t = a[k];
      a[k] = a[i];
      a[i] = t;
      gen(k + 1);
      a[i] = a[k];
      a[k] = t;
    }
  };
  gen(0);
  return out;
}

class Heap<T> {
  items: T[] = [];
  less: (a: T, b: T) => boolean;
  constructor(less: (a: T, b: T) => boolean) {
    this.less = less;
  }
  get size(): number {
    return this.items.length;
  }
  push(v: T): void {
    const a = this.items;
    a.push(v);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(a[i], a[p])) break;
      const t = a[i];
      a[i] = a[p];
      a[p] = t;
      i = p;
    }
  }
  pop(): T | undefined {
    const a = this.items;
    if (a.length === 0) return undefined;
    const top = a[0];
    const last = a.pop() as T;
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && this.less(a[l], a[m])) m = l;
        if (r < a.length && this.less(a[r], a[m])) m = r;
        if (m === i) break;
        const t = a[i];
        a[i] = a[m];
        a[m] = t;
        i = m;
      }
    }
    return top;
  }
}

interface SNode {
  boxes: number[];
  player: number;
  /** Smallest cell of the player's reachable region: the canonical
   *  player position, so states differing only by where the player
   *  stands inside one region dedupe to one state. */
  canon: number;
  g: number;
  h: number;
  seq: number;
  parent: SNode | null;
  seg: string;
}

/** Push-based search of one room from its entry cell. With useAstar the
 *  queue orders by pushes + assignment heuristic (push-optimal when it
 *  finishes); without it the queue is FIFO by pushes (plain push BFS).
 *  Returns null when the state budget runs out or the room is dead. */
function searchRoom(
  lv: Level,
  room: Room,
  startPlayer: number,
  useAstar: boolean,
  cap: number,
  budget: { used: number; limit: number },
): { moves: string; pushes: number; endPlayer: number } | null {
  const n = room.boxes.length;
  for (const b of room.boxes) if (room.dead[b]) return null;
  const perms = n === room.goals.length ? allPermutations(n) : [];
  const hCache = new Map<string, number>();
  const heuristic = (boxes: number[]): number => {
    if (perms.length === 0) return 0;
    const key = boxes.join(',');
    const hit = hCache.get(key);
    if (hit !== undefined) return hit;
    let best = Infinity;
    for (const p of perms) {
      let s = 0;
      for (let i = 0; i < n; i++) {
        const b = boxes[i];
        const g = room.goals[p[i]];
        const bx = b % lv.w;
        const gx = g % lv.w;
        s += Math.abs(bx - gx) + Math.abs((b - bx) / lv.w - (g - gx) / lv.w);
      }
      if (s < best) best = s;
    }
    hCache.set(key, best);
    return best;
  };
  let seq = 0;
  const heap = new Heap<SNode>((a, b) => {
    const fa = a.g + (useAstar ? a.h : 0);
    const fb = b.g + (useAstar ? b.h : 0);
    if (fa !== fb) return fa < fb;
    if (a.h !== b.h) return a.h < b.h;
    return a.seq < b.seq;
  });
  const scratch = new Uint8Array(lv.w * lv.h);
  const startBoxes = [...room.boxes].sort((a, b) => a - b);
  for (const b of startBoxes) scratch[b] = 1;
  const startRegion = bfsRegion(lv, room.open, scratch, startPlayer);
  for (const b of startBoxes) scratch[b] = 0;
  const start: SNode = {
    boxes: startBoxes,
    player: startPlayer,
    canon: startRegion.min,
    g: 0,
    h: heuristic(startBoxes),
    seq: seq++,
    parent: null,
    seg: '',
  };
  heap.push(start);
  const best = new Map<string, number>();
  const closed = new Set<string>();
  const keyOf = (boxes: number[], canon: number): string => boxes.join(',') + '|' + canon;
  let expansions = 0;
  while (heap.size > 0) {
    const node = heap.pop() as SNode;
    const key = keyOf(node.boxes, node.canon);
    if (closed.has(key)) continue;
    const known = best.get(key);
    if (known !== undefined && node.g > known) continue;
    closed.add(key);
    for (const b of node.boxes) scratch[b] = 1;
    const region = bfsRegion(lv, room.open, scratch, node.player);
    for (const b of node.boxes) scratch[b] = 0;
    let solved = true;
    for (const b of node.boxes) {
      if (!lv.goal[b]) {
        solved = false;
        break;
      }
    }
    if (solved && region.has[room.entry]) {
      const segs: string[] = [];
      let pushes = 0;
      let cur: SNode | null = node;
      while (cur !== null) {
        if (cur.seg.length > 0) {
          segs.push(cur.seg);
          pushes++;
        }
        cur = cur.parent;
      }
      segs.reverse();
      let moves = segs.join('');
      for (const b of node.boxes) scratch[b] = 1;
      const back = bfsRegion(lv, room.open, scratch, node.player);
      for (const b of node.boxes) scratch[b] = 0;
      if (back.has[room.entry]) moves += pathFrom(back, node.player, room.entry);
      return { moves, pushes, endPlayer: room.entry };
    }
    expansions++;
    budget.used++;
    if (expansions > cap || budget.used > budget.limit) return null;
    for (const b of node.boxes) {
      for (const d of DIRS) {
        const pushPos = step(lv, b, -d.dx, -d.dy);
        const target = step(lv, b, d.dx, d.dy);
        if (pushPos < 0 || target < 0) continue;
        if (!region.has[pushPos]) continue;
        if (!room.isRoom[target]) continue;
        if (node.boxes.includes(target)) continue;
        if (room.dead[target]) continue;
        const childBoxes = [...node.boxes];
        childBoxes[childBoxes.indexOf(b)] = target;
        childBoxes.sort((x, y) => x - y);
        if (frozen2x2(lv, room, childBoxes, target)) continue;
        for (const cb of childBoxes) scratch[cb] = 1;
        const cregion = bfsRegion(lv, room.open, scratch, b);
        for (const cb of childBoxes) scratch[cb] = 0;
        const ckey = keyOf(childBoxes, cregion.min);
        const cg = node.g + 1;
        const prevBest = best.get(ckey);
        if (prevBest !== undefined && cg >= prevBest) continue;
        best.set(ckey, cg);
        heap.push({
          boxes: childBoxes,
          player: b,
          canon: cregion.min,
          g: cg,
          h: useAstar ? heuristic(childBoxes) : 0,
          seq: seq++,
          parent: node,
          seg: pathFrom(region, node.player, pushPos) + d.ch,
        });
      }
    }
  }
  return null;
}

/** Solve one level: nearest room first (by walk distance), A* per room
 *  with a push-BFS fallback, walks stitched between rooms. */
function solveLevel(text: string, budget: { used: number; limit: number }): string {
  const lv = parseLevel(text);
  const rooms = findRooms(lv);
  const size = lv.w * lv.h;
  const floor = new Uint8Array(size);
  for (let i = 0; i < size; i++) floor[i] = lv.wall[i] ? 0 : 1;
  const boxArr = new Uint8Array(size);
  for (const b of lv.boxes) boxArr[b] = 1;
  let player = lv.player;
  let moves = '';
  const remaining = [...rooms];
  while (remaining.length > 0) {
    let bestIdx = -1;
    let bestPath: string | null = null;
    for (let i = 0; i < remaining.length; i++) {
      const reg = bfsRegion(lv, floor, boxArr, player);
      if (!reg.has[remaining[i].entry]) continue;
      const p = pathFrom(reg, player, remaining[i].entry);
      if (bestPath === null || p.length < bestPath.length) {
        bestIdx = i;
        bestPath = p;
      }
    }
    if (bestIdx < 0 || bestPath === null) break;
    const room = remaining.splice(bestIdx, 1)[0];
    moves += bestPath;
    player = room.entry;
    const sol =
      searchRoom(lv, room, room.entry, true, ASTAR_CAP, budget) ??
      searchRoom(lv, room, room.entry, false, BFS_CAP, budget);
    if (sol === null) continue;
    moves += sol.moves;
    player = sol.endPlayer;
    for (const b of room.boxes) boxArr[b] = 0;
    for (const g of room.goals) boxArr[g] = 1;
  }
  return moves;
}

function main(): void {
  const budget = { used: 0, limit: TOTAL_CAP };
  let ids: string[] = [];
  try {
    ids = readdirSync(INPUT_DIR).sort();
  } catch {
    ids = [];
  }
  for (const id of ids) {
    let moves = '';
    try {
      moves = solveLevel(readFileSync(join(INPUT_DIR, id, 'level.txt'), 'utf8'), budget);
    } catch {
      moves = '';
    }
    try {
      mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
      writeFileSync(join(OUTPUT_DIR, id, 'solution.txt'), moves + '\n');
    } catch {
      // Nothing more can be done for this instance.
    }
  }
}

main();
