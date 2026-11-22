import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type SimulationLinkDatum, type SimulationNodeDatum } from 'd3-force';

/**
 * Layout of a large graph ahead of drawing it (#64, online mode): the forces run in a worker step by step and report
 * how far they are, so the page shows a progress bar instead of freezing while thousands of notes settle. Small graphs
 * keep the live simulation in `Graph`. Above `FORCE_MAX` notes one step of the forces costs most of a second, so the
 * notes are placed by folder instead: one disc per folder, the most linked notes in its middle.
 */

/** Above this many notes the graph is laid out by folder, not by forces */
export const FORCE_MAX = 8000;

export interface LayoutInput {
  /** Node radius by index (the collide force keeps them apart) */
  radius: Float32Array;
  /** Pairs of node indexes */
  edges: Uint32Array;
  /** Folder of each node, as an index (the layout by folder) */
  group: Uint32Array;
}

export interface LayoutProgress {
  type: 'progress';
  /** 0…1 */
  done: number;
}

export interface LayoutDone {
  type: 'done';
  /** x, y per node */
  positions: Float32Array;
}

type Node = SimulationNodeDatum & { r: number };

/** Steps of the force layout */
const TICKS = Math.ceil(Math.log(0.001) / Math.log(1 - 0.06));

const GOLDEN = Math.PI * (3 - Math.sqrt(5));

/**
 * Notes by folder: every folder a disc (its notes on a sunflower spiral, the most linked inside), the discs on a
 * spiral around the middle, the largest first
 */
export function folderLayout(input: LayoutInput, onProgress: (done: number) => void): Float32Array {
  const count = input.radius.length;
  const step = 22;
  const members = new Map<number, number[]>();
  for (let i = 0; i < count; i++) {
    const g = input.group[i];
    const list = members.get(g);
    if (list) list.push(i);
    else members.set(g, [i]);
  }
  const groups = [...members.values()].sort((a, b) => b.length - a.length);
  const out = new Float32Array(count * 2);
  let area = 0;
  let done = 0;
  groups.forEach((list, k) => {
    const r = step * Math.sqrt(list.length) + step;
    area += Math.PI * r * r * 1.3;
    // The first disc in the middle, the others on a spiral that leaves room for the discs before them
    const dist = k === 0 ? 0 : Math.sqrt(area / Math.PI) - r * 0.6;
    const cx = Math.cos(k * GOLDEN) * dist;
    const cy = Math.sin(k * GOLDEN) * dist;
    list.sort((a, b) => input.radius[b] - input.radius[a]);
    list.forEach((i, j) => {
      const d = step * Math.sqrt(j + 0.5);
      out[i * 2] = cx + Math.cos(j * GOLDEN) * d;
      out[i * 2 + 1] = cy + Math.sin(j * GOLDEN) * d;
    });
    done += list.length;
    onProgress(done / count);
  });
  return out;
}

/** Runs the layout; `onProgress` after every few steps. Returns the positions */
export function runLayout(input: LayoutInput, onProgress: (done: number) => void): Float32Array {
  const count = input.radius.length;
  if (count > FORCE_MAX) return folderLayout(input, onProgress);
  const nodes: Node[] = Array.from({ length: count }, (_, i) => ({ r: input.radius[i] }));
  const links: SimulationLinkDatum<Node>[] = [];
  for (let i = 0; i + 1 < input.edges.length; i += 2) links.push({ source: input.edges[i], target: input.edges[i + 1] });
  const sim = forceSimulation(nodes)
    .stop()
    .alphaDecay(0.06)
    .force('link', forceLink<Node, SimulationLinkDatum<Node>>(links).distance(80).strength(0.5))
    .force('charge', forceManyBody<Node>().strength(-260))
    .force('center', forceCenter(0, 0))
    .force('x', forceX(0).strength(0.05))
    .force('y', forceY(0).strength(0.05))
    .force('collide', forceCollide<Node>().radius((d) => d.r + 16));
  const ticks = TICKS;
  const every = Math.max(1, Math.floor(ticks / 50));
  for (let i = 0; i < ticks; i++) {
    sim.tick();
    if (i % every === 0) onProgress((i + 1) / ticks);
  }
  onProgress(1);
  const out = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    out[i * 2] = nodes[i].x ?? 0;
    out[i * 2 + 1] = nodes[i].y ?? 0;
  }
  return out;
}

/**
 * The layout in a worker (on the page itself where workers are missing, e.g. in tests). `onProgress` gets 0…1;
 * the returned `cancel` stops it.
 */
export function layoutInWorker(input: LayoutInput, onProgress: (done: number) => void): { result: Promise<Float32Array>; cancel: () => void } {
  if (typeof Worker === 'undefined') {
    let cancelled = false;
    const result = new Promise<Float32Array>((resolve, reject) =>
      setTimeout(() => {
        if (cancelled) return reject(new Error('cancelled'));
        resolve(runLayout(input, onProgress));
      }, 0)
    );
    return { result, cancel: () => (cancelled = true) };
  }
  const worker = new Worker(new URL('./graphLayout.worker.ts', import.meta.url), { type: 'module' });
  const result = new Promise<Float32Array>((resolve, reject) => {
    worker.onmessage = (e: MessageEvent<LayoutProgress | LayoutDone>) => {
      if (e.data.type === 'progress') onProgress(e.data.done);
      else {
        resolve(e.data.positions);
        worker.terminate();
      }
    };
    worker.onerror = (e) => {
      reject(new Error(e.message));
      worker.terminate();
    };
  });
  worker.postMessage(input, [input.radius.buffer, input.edges.buffer, input.group.buffer]);
  return { result, cancel: () => worker.terminate() };
}
