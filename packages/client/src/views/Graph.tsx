import { useEffect, useMemo, useRef, useState } from 'react';
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, SimulationLinkDatum, SimulationNodeDatum } from 'd3-force';
import type { GraphEdge, GraphFilter, GraphNode, GraphNoteKind, ParaRole } from '@kladde/shared';
import { extractMeta, filterGraph, filterGraphData, isHiddenPath, projectTitleOf, roleOfFolder, splitPath } from '@kladde/shared';
import { Filter, LocateFixed, X } from '../lib/icons';
import { Dropdown } from './Dropdown';
import { useVault, vault } from '../data/vault';
import { navigate } from '../lib/router';
import { compareText, folderDisplayName, getLang, locale, t, useLang, type I18nKey } from '../lib/i18n';
import { layoutInWorker } from '../lib/graphLayout';
import { PageBody, PageHeader } from './PageHeader';
import { LoadBar } from './LoadBar';
import { onlineGraph, useOnlineGraph } from '../data/onlineGraph';

/** A graph node; `orphan` (no link in or out on the whole graph) draws it as a ring */
type ViewNode = GraphNode & { orphan?: boolean };

interface SimNode extends SimulationNodeDatum, ViewNode {}
type SimLink = SimulationLinkDatum<SimNode>;

/** Node colour by PARA role, taken from the theme variables */
const ROLE_VAR: Record<string, string> = { inbox: '--warn', projects: '--primary', areas: '--ok', resources: '--tertiary', archive: '--outline', zettel: '--error', memory: '--secondary' };
const LEGEND: [string, I18nKey][] = [
  ['projects', 'graph.legendProjects'],
  ['areas', 'graph.legendAreas'],
  ['resources', 'graph.legendResources'],
  ['zettel', 'graph.legendZettel'],
  ['inbox', 'graph.legendInbox'],
  ['archive', 'graph.legendArchive'],
  ['memory', 'graph.legendMemory'],
];

function cssColor(name: string, alpha = 1): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim().split(/\s+/).join(',');
  return `rgba(${v},${alpha})`;
}

/** Above this many notes the layout runs ahead in a worker with a progress bar, without the live animation */
const BIG_GRAPH = 1500;

/** A short fingerprint of the graph's structure: the layout starts again only when it changes */
function structureKey(nodes: ViewNode[], edges: GraphEdge[]): string {
  let h = 0x811c9dc5;
  const mix = (text: string) => {
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  };
  for (const n of nodes) mix(`${n.id}\u0001${n.title}\u0001${n.folder}\u0001${n.links}\u0001${n.orphan ? 1 : 0}\u0002`);
  for (const e of edges) mix(`${e.source}>${e.target}\u0002`);
  return `${nodes.length}:${edges.length}:${h >>> 0}`;
}

export function Graph({ nodes, edges, focusId, height, onOpen }: { nodes: ViewNode[]; edges: GraphEdge[]; focusId?: string; height: number; onOpen: (id: string) => void }) {
  useVault();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hoverTitle, setHoverTitle] = useState<string | null>(null);
  /** Share of the layout of a large graph while it runs (null: done or a small graph) */
  const [layout, setLayout] = useState<number | null>(null);
  const roleConfig = vault.roleConfig();
  const memoryFolder = vault.memoryFolder();
  const roleConfigKey = JSON.stringify([roleConfig, memoryFolder]);
  const key = useMemo(() => structureKey(nodes, edges), [nodes, edges]);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const wrap = wrapRef.current!;
    const ctx = canvas.getContext('2d')!;
    const simNodes: SimNode[] = nodes.map((n) => ({ ...n }));
    const byId = new Map(simNodes.map((n) => [n.id, n]));
    const simLinks: SimLink[] = edges.filter((e) => byId.has(e.source) && byId.has(e.target)).map((e) => ({ source: e.source, target: e.target }));
    const neighbours = new Map<string, Set<string>>();
    for (const e of edges) {
      if (!neighbours.has(e.source)) neighbours.set(e.source, new Set());
      if (!neighbours.has(e.target)) neighbours.set(e.target, new Set());
      neighbours.get(e.source)!.add(e.target);
      neighbours.get(e.target)!.add(e.source);
    }
    let width = wrap.clientWidth;
    let view = { x: 0, y: 0, k: 1 };
    let hover: SimNode | null = null;
    let dragging: SimNode | null = null;
    let panning: { x: number; y: number; vx: number; vy: number } | null = null;
    let moved = false;
    const radius = (n: SimNode) => 4 + Math.sqrt(n.links) * 2.2 + (n.id === focusId ? 3 : 0);
    const fontFamily = getComputedStyle(document.documentElement).getPropertyValue('--font-sans').trim() || 'Roboto, system-ui, sans-serif';
    const colors = () => ({
      line: cssColor('--outline-variant'),
      lineHi: cssColor('--primary', 0.8),
      text: cssColor('--on-surface'),
      muted: cssColor('--on-surface-variant'),
      bg: cssColor('--surface'),
      role: Object.fromEntries(Object.entries(ROLE_VAR).map(([r, v]) => [r, cssColor(v)])),
      other: cssColor('--on-surface-variant'),
    });
    let palette = colors();
    const roleOf = (n: SimNode) => (memoryFolder && (n.folder === memoryFolder || n.folder.startsWith(`${memoryFolder}/`)) ? 'memory' : roleOfFolder(n.folder, roleConfig));
    const fills = simNodes.map((n) => roleOf(n) ?? '');

    // Thousands of notes (#64): the layout runs ahead in a worker, only the notes in focus get labels
    const big = simNodes.length > BIG_GRAPH;
    let placed = !big;
    let sim: ReturnType<typeof forceSimulation<SimNode>> | null = null;
    let job: ReturnType<typeof layoutInWorker> | null = null;
    if (!big) {
      sim = forceSimulation(simNodes)
        .alphaDecay(0.0228)
        .force('link', forceLink<SimNode, SimLink>(simLinks).id((d) => d.id).distance(80).strength(0.5))
        .force('charge', forceManyBody().strength(-260))
        .force('center', forceCenter(0, 0))
        .force('x', forceX(0).strength(0.05))
        .force('y', forceY(0).strength(0.05))
        .force('collide', forceCollide<SimNode>().radius((d) => radius(d) + 16))
        .on('tick', () => draw());
    } else {
      const at = new Map(simNodes.map((n, i) => [n.id, i]));
      const pairs = new Uint32Array(simLinks.length * 2);
      simLinks.forEach((l, i) => {
        pairs[i * 2] = at.get(l.source as string)!;
        pairs[i * 2 + 1] = at.get(l.target as string)!;
        l.source = byId.get(l.source as string)!;
        l.target = byId.get(l.target as string)!;
      });
      const folders = new Map<string, number>();
      const group = Uint32Array.from(simNodes, (n) => folders.get(n.folder) ?? folders.set(n.folder, folders.size).get(n.folder)!);
      setLayout(0);
      job = layoutInWorker({ radius: Float32Array.from(simNodes, radius), edges: pairs, group }, (done) => setLayout(done));
      job.result
        .then((pos) => {
          simNodes.forEach((n, i) => {
            n.x = pos[i * 2];
            n.y = pos[i * 2 + 1];
          });
          placed = true;
          fit();
          setLayout(null);
          draw();
        })
        .catch(() => {
          // Cancelled: the page moved on or the graph changed
        });
    }
    const minZoom = big ? 0.01 : 0.25;

    /** Zooms so that every note is in view (after the layout of a large graph) */
    function fit() {
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (const n of simNodes) {
        x0 = Math.min(x0, n.x!);
        y0 = Math.min(y0, n.y!);
        x1 = Math.max(x1, n.x!);
        y1 = Math.max(y1, n.y!);
      }
      if (!Number.isFinite(x0)) return;
      const k = Math.min(1, Math.max(minZoom, Math.min(width / (x1 - x0 + 80), height / (y1 - y0 + 80))));
      view = { k, x: (-(x0 + x1) / 2) * k, y: (-(y0 + y1) / 2) * k };
    }

    const resize = () => {
      width = wrap.clientWidth;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      draw();
    };

    function toWorld(px: number, py: number) {
      return { x: (px - width / 2 - view.x) / view.k, y: (py - height / 2 - view.y) / view.k };
    }

    function nodeAt(px: number, py: number): SimNode | null {
      if (!placed) return null;
      const p = toWorld(px, py);
      let best: SimNode | null = null;
      let bestD = Infinity;
      for (const n of simNodes) {
        const d = Math.hypot((n.x ?? 0) - p.x, (n.y ?? 0) - p.y);
        if (d < radius(n) + 6 / view.k && d < bestD) {
          best = n;
          bestD = d;
        }
      }
      return best;
    }

    function draw() {
      ctx.clearRect(0, 0, width, height);
      if (!placed) return;
      ctx.save();
      ctx.translate(width / 2 + view.x, height / 2 + view.y);
      ctx.scale(view.k, view.k);
      // What is in view (with a margin for labels): the rest is not drawn
      const tl = toWorld(-40, -40);
      const br = toWorld(width + 40, height + 40);
      const inView = (x: number, y: number, r = 0) => x + r >= tl.x && x - r <= br.x && y + r >= tl.y && y - r <= br.y;
      const active = hover ?? (focusId ? byId.get(focusId) ?? null : null);
      const near = active ? neighbours.get(active.id) ?? new Set() : null;
      // Lines in two strokes (normal and highlighted) instead of one per line
      ctx.lineWidth = 1 / view.k;
      const hiLinks: SimLink[] = [];
      ctx.strokeStyle = palette.line;
      ctx.globalAlpha = active ? 0.35 : 1;
      ctx.beginPath();
      for (const l of simLinks) {
        const s = l.source as SimNode;
        const tgt = l.target as SimNode;
        if (Math.max(s.x!, tgt.x!) < tl.x || Math.min(s.x!, tgt.x!) > br.x || Math.max(s.y!, tgt.y!) < tl.y || Math.min(s.y!, tgt.y!) > br.y) continue;
        if (active && (s.id === active.id || tgt.id === active.id)) {
          hiLinks.push(l);
          continue;
        }
        ctx.moveTo(s.x!, s.y!);
        ctx.lineTo(tgt.x!, tgt.y!);
      }
      ctx.stroke();
      if (hiLinks.length) {
        ctx.globalAlpha = 1;
        ctx.strokeStyle = palette.lineHi;
        ctx.beginPath();
        for (const l of hiLinks) {
          ctx.moveTo((l.source as SimNode).x!, (l.source as SimNode).y!);
          ctx.lineTo((l.target as SimNode).x!, (l.target as SimNode).y!);
        }
        ctx.stroke();
      }
      // Circles grouped by colour, dimming and ring: one path each
      const groups = new Map<string, { fill: string; dim: boolean; orphan: boolean; list: SimNode[] }>();
      const labels: SimNode[] = [];
      simNodes.forEach((n, i) => {
        const r = radius(n);
        if (!inView(n.x!, n.y!, r)) return;
        const dim = !!active && n.id !== active.id && !near!.has(n.id);
        const fill = (fills[i] && palette.role[fills[i]]) || palette.other;
        const key = `${fill}|${dim ? 1 : 0}|${n.orphan ? 1 : 0}`;
        let group = groups.get(key);
        if (!group) groups.set(key, (group = { fill, dim, orphan: !!n.orphan, list: [] }));
        group.list.push(n);
        const label = n.id === active?.id || near?.has(n.id) || view.k > 1.4 || (!big && n.links >= 4) || simNodes.length < 25;
        if (label && !dim) labels.push(n);
      });
      for (const group of groups.values()) {
        ctx.globalAlpha = group.dim ? 0.25 : 1;
        ctx.beginPath();
        for (const n of group.list) {
          const r = radius(n);
          ctx.moveTo(n.x! + r, n.y!);
          ctx.arc(n.x!, n.y!, r, 0, Math.PI * 2);
        }
        if (group.orphan) {
          // Orphans: a dashed ring in the role colour, so they stand out without a colour of their own
          ctx.fillStyle = palette.bg;
          ctx.fill();
          ctx.strokeStyle = group.fill;
          ctx.lineWidth = 2 / view.k;
          ctx.setLineDash([3 / view.k, 2 / view.k]);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.lineWidth = 1 / view.k;
        } else {
          ctx.fillStyle = group.fill;
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
      const focused = focusId ? byId.get(focusId) : undefined;
      if (focused && inView(focused.x!, focused.y!, radius(focused))) {
        ctx.beginPath();
        ctx.arc(focused.x!, focused.y!, radius(focused), 0, Math.PI * 2);
        ctx.strokeStyle = palette.text;
        ctx.lineWidth = 2 / view.k;
        ctx.stroke();
        ctx.lineWidth = 1 / view.k;
      }
      ctx.font = `${12 / view.k}px ${fontFamily}`;
      ctx.textAlign = 'center';
      for (const n of labels) {
        ctx.fillStyle = n.id === active?.id ? palette.text : palette.muted;
        const text = n.title.length > 32 ? `${n.title.slice(0, 30)}…` : n.title;
        ctx.fillText(text, n.x!, n.y! + radius(n) + 13 / view.k);
      }
      ctx.restore();
    }

    // A large graph draws at most once per frame while the pointer moves
    let frame = 0;
    const redraw = () => {
      if (!big) return draw();
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        draw();
      });
    };

    const pos = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const onDown = (e: PointerEvent) => {
      const p = pos(e);
      moved = false;
      canvas.setPointerCapture(e.pointerId);
      dragging = nodeAt(p.x, p.y);
      if (dragging) {
        const w = toWorld(p.x, p.y);
        dragging.fx = w.x;
        dragging.fy = w.y;
        sim?.alphaTarget(0.3).restart();
      } else panning = { x: p.x, y: p.y, vx: view.x, vy: view.y };
    };
    const onMove = (e: PointerEvent) => {
      const p = pos(e);
      if (dragging) {
        const w = toWorld(p.x, p.y);
        dragging.fx = w.x;
        dragging.fy = w.y;
        // Without a running simulation (large graph) the note just follows the pointer
        if (!sim) {
          dragging.x = w.x;
          dragging.y = w.y;
          redraw();
        }
        moved = true;
      } else if (panning) {
        view = { ...view, x: panning.vx + p.x - panning.x, y: panning.vy + p.y - panning.y };
        moved = moved || Math.abs(p.x - panning.x) + Math.abs(p.y - panning.y) > 4;
        redraw();
      } else {
        const h = nodeAt(p.x, p.y);
        if (h !== hover) {
          hover = h;
          canvas.style.cursor = h ? 'pointer' : 'grab';
          setHoverTitle(h?.title ?? null);
          redraw();
        }
      }
    };
    const onUp = (e: PointerEvent) => {
      const p = pos(e);
      if (dragging) {
        dragging.fx = null;
        dragging.fy = null;
        sim?.alphaTarget(0);
        if (!moved) onOpen(dragging.id);
      } else if (!moved) {
        const n = nodeAt(p.x, p.y);
        if (n) onOpen(n.id);
      }
      dragging = null;
      panning = null;
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const p = { x: e.offsetX - width / 2, y: e.offsetY - height / 2 };
      const k = Math.min(4, Math.max(minZoom, view.k * Math.exp(-e.deltaY * 0.0015)));
      view = { k, x: p.x - ((p.x - view.x) * k) / view.k, y: p.y - ((p.y - view.y) * k) / view.k };
      redraw();
    };
    const onLeave = () => {
      hover = null;
      setHoverTitle(null);
      redraw();
    };

    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointerleave', onLeave);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);
    const mo = new MutationObserver(() => {
      palette = colors();
      draw();
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-scheme', 'data-accent'] });
    resize();
    return () => {
      sim?.stop();
      job?.cancel();
      if (frame) cancelAnimationFrame(frame);
      setLayout(null);
      ro.disconnect();
      mo.disconnect();
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('wheel', onWheel);
    };
    // Rebuild only when the structure changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, roleConfigKey, focusId, height]);

  return (
    <div ref={wrapRef} className="paper-grid relative w-full touch-none select-none overflow-hidden rounded-lg border border-outline-variant bg-surface-container-low">
      <canvas ref={canvasRef} className="block cursor-grab" />
      {layout !== null && (
        <div className="absolute inset-0 flex items-center justify-center p-6">
          <LoadBar label={t('graph.layingOut', { n: nodes.length.toLocaleString(locale(getLang())) })} value={layout} />
        </div>
      )}
      {hoverTitle && <div className="pointer-events-none absolute left-3 top-3 max-w-[calc(100%-1.5rem)] truncate rounded bg-inverse-surface px-2 py-1 text-body-s text-inverse-on-surface anim-fade-in">{hoverTitle}</div>}
    </div>
  );
}

export function GraphLegend({ orphans }: { orphans?: boolean }) {
  useVault();
  useLang();
  const { para, zettel, memory } = vault.features();
  const visible = LEGEND.filter(([role]) => {
    if (role === 'inbox') return true;
    if (role === 'memory') return memory.enabled;
    if (role === 'zettel') return zettel.enabled;
    return para.enabled;
  });
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 text-label-m text-on-surface-variant">
      {visible.map(([role, labelKey]) => (
        <span key={role} className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: `rgb(var(${ROLE_VAR[role]}))` }} />
          {t(labelKey)}
        </span>
      ))}
      {orphans && (
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full border-2 border-dashed border-on-surface-variant" />
          {t('graph.legendOrphan')}
        </span>
      )}
    </div>
  );
}

const DAY = 86_400_000;
type RoleChip = ParaRole | 'none';
const ROLE_CHIPS: [RoleChip, I18nKey][] = [
  ['projects', 'graph.legendProjects'],
  ['areas', 'graph.legendAreas'],
  ['resources', 'graph.legendResources'],
  ['archive', 'graph.legendArchive'],
  ['inbox', 'graph.legendInbox'],
  ['zettel', 'graph.legendZettel'],
  ['none', 'graph.roleNone'],
];
const KIND_CHIPS: [GraphNoteKind, I18nKey][] = [
  ['note', 'graph.kindNote'],
  ['zettel', 'graph.kindZettel'],
  ['pdf', 'graph.kindPdf'],
  ['drawing', 'graph.kindDrawing'],
];

/** A filter chip: outlined, accent tinted while selected */
function FilterChip({ selected, onClick, children }: { selected: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" className="chip" aria-pressed={selected} onClick={onClick}>
      {children}
    </button>
  );
}

function FilterGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <div className="section-label">{label}</div>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

const toggle = <T,>(set: Set<T>, value: T) => {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
};

/** Whole knowledge network (#38): filters by role, type, folder, tag and time, a focus with 1–3 hops, orphans */
export function GraphView() {
  const version = useVault();
  const lang = useLang();
  const { para, zettel } = vault.features();
  const roleConfig = vault.roleConfig();
  const notes = vault.list();
  const roleChips = ROLE_CHIPS.filter(([role]) => (role === 'zettel' ? zettel.enabled : role === 'inbox' || role === 'none' || para.enabled));
  const defaultRoles = () => new Set<RoleChip>(roleChips.map(([r]) => r).filter((r) => r !== 'archive'));
  const kindChips = KIND_CHIPS.filter(([kind]) => kind !== 'zettel' || zettel.enabled);

  // Open on wide screens; on phones the filters would push the graph out of view
  const [filterOpen, setFilterOpen] = useState(() => matchMedia('(min-width: 1024px)').matches);
  const [roles, setRoles] = useState<Set<RoleChip>>(defaultRoles);
  const [kinds, setKinds] = useState<Set<GraphNoteKind>>(() => new Set());
  const [folder, setFolder] = useState('');
  const [tag, setTag] = useState('');
  const [rangeField, setRangeField] = useState<'created' | 'updated'>('created');
  const [range, setRange] = useState<[number, number] | null>(null);
  const [focusId, setFocusId] = useState(() => new URLSearchParams(location.search).get('focus') ?? '');
  const [depth, setDepth] = useState(2);
  const [onlyLinked, setOnlyLinked] = useState(false);
  const [onlyOrphans, setOnlyOrphans] = useState(() => new URLSearchParams(location.search).get('orphans') === '1');

  // Day bounds of the chosen date over all notes, for the time range sliders
  // Online mode: nodes and edges come from the server, the device has the links of only the notes it loaded
  const online = vault.online;
  const remote = useOnlineGraph();
  useEffect(() => {
    if (online) onlineGraph.want();
  }, [online, version]);
  const remoteData = online ? remote.data : null;
  const remoteTitles = useMemo(() => (remoteData ? new Map(remoteData.nodes.map((n) => [n.id, n.title])) : null), [remoteData]);

  const bounds = useMemo(() => {
    let min = Infinity;
    let max = -Infinity;
    for (const n of notes) {
      const d = Math.floor((rangeField === 'created' ? n.createdAt : n.updatedAt) / DAY);
      if (d <= 0) continue;
      if (d < min) min = d;
      if (d > max) max = d;
    }
    return min <= max ? [min, max] : [0, 0];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, rangeField]);
  const [from, to] = range ?? bounds;
  const focus = focusId && vault.get(focusId) ? focusId : '';
  const allRolesShown = roleChips.every(([r]) => roles.has(r));

  const filter: GraphFilter = {
    roles: para.enabled || zettel.enabled ? (allRolesShown ? undefined : [...roles]) : undefined,
    kinds: [...kinds],
    folder: folder || undefined,
    tag: tag || undefined,
    range: range ? { field: rangeField, from: from * DAY, to: (to + 1) * DAY - 1 } : undefined,
    focus: focus ? { id: focus, depth } : undefined,
    onlyLinked,
    onlyOrphans,
  };
  const filterKey = JSON.stringify(filter);
  const g = useMemo(() => {
    if (!online) return filterGraph(vault.links(), notes, filter, roleConfig);
    if (!remoteData) return { nodes: [], edges: [], orphans: 0 };
    return filterGraphData(
      remoteData,
      (id) => {
        const note = vault.get(id);
        const info = remoteData.info.get(id);
        if (!note || !info) return undefined;
        const kind: GraphNoteKind = info.kind === 2 ? 'drawing' : info.kind === 1 ? 'pdf' : roleOfFolder(splitPath(note.path).folder, roleConfig) === 'zettel' ? 'zettel' : 'note';
        return { kind, tags: () => info.tags, createdAt: note.createdAt, updatedAt: note.updatedAt };
      },
      filter,
      roleConfig
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // Online: again when the server's graph or a path changes, not with every sync (100,000 notes take a moment)
  }, [online ? vault.getPathStamp() : version, online, remoteData, filterKey, JSON.stringify(roleConfig)]);

  const rolesChanged = roleChips.some(([r]) => roles.has(r) !== (r !== 'archive'));
  const active = [rolesChanged, kinds.size > 0, !!folder, !!tag, !!range, !!focus].filter(Boolean).length;
  const reset = () => {
    setRoles(defaultRoles());
    setKinds(new Set());
    setFolder('');
    setTag('');
    setRange(null);
    setFocusId('');
  };
  const tags = useMemo(
    () => {
      const all = new Set<string>();
      if (remoteData) for (const i of remoteData.info.values()) for (const x of i.tags) all.add(x);
      else if (!online) for (const n of notes) for (const x of extractMeta(n.path, n.content).tags) all.add(x);
      return [...all].sort((a, b) => compareText(a, b, lang));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version, lang, remoteData]
  );
  const titleOf = (id: string) => {
    const remoteTitle = remoteTitles?.get(id);
    if (remoteTitle) return remoteTitle;
    const n = vault.get(id);
    return n ? projectTitleOf(n.path, n.content, roleConfig) : '';
  };
  const noteOptions = useMemo(
    () =>
      (remoteData
        ? remoteData.nodes.map((n) => ({ value: n.id, label: n.title }))
        : notes.filter((n) => !isHiddenPath(n.path)).map((n) => ({ value: n.id, label: projectTitleOf(n.path, n.content, roleConfig) || splitPath(n.path).name }))
      ).sort((a, b) => compareText(a.label, b.label, lang)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version, lang, remoteData]
  );
  const dayLabel = (d: number) => new Date(d * DAY).toLocaleDateString(locale(lang), { dateStyle: 'medium' });
  const setBound = (which: 0 | 1, value: number) => {
    const next: [number, number] = which === 0 ? [Math.min(value, to), to] : [from, Math.max(value, from)];
    setRange(next[0] === bounds[0] && next[1] === bounds[1] ? null : next);
  };

  return (
    <div>
      <PageHeader
        title={t('graph.title')}
        subtitle={`${t('graph.summary', { nodes: g.nodes.length, edges: g.edges.length })}${g.orphans > 0 ? ` · ${t('graph.orphanCount', { n: g.orphans })}` : ''}`}
        actions={
          <>
            {active > 0 && (
              <button type="button" className="btn-text" onClick={reset}>
                {t('graph.reset')}
              </button>
            )}
            <button type="button" className="btn-tonal" aria-expanded={filterOpen} onClick={() => setFilterOpen(!filterOpen)}>
              <Filter size={16} /> {t('graph.filters')}
              {active > 0 && <span className="pill bg-acc text-on-acc">{active}</span>}
            </button>
          </>
        }
      />
      <PageBody>

      {filterOpen && (
        <div className="card mb-4 grid gap-5 p-4 anim-fade-in sm:p-5 lg:grid-cols-2">
          {roleChips.length > 2 && (
            <FilterGroup label={t('graph.filterRoles')}>
              {roleChips.map(([role, key]) => (
                <FilterChip key={role} selected={roles.has(role)} onClick={() => setRoles(toggle(roles, role))}>
                  {t(key)}
                </FilterChip>
              ))}
            </FilterGroup>
          )}
          <FilterGroup label={t('graph.filterKinds')}>
            {kindChips.map(([kind, key]) => (
              <FilterChip key={kind} selected={kinds.has(kind)} onClick={() => setKinds(toggle(kinds, kind))}>
                {t(key)}
              </FilterChip>
            ))}
          </FilterGroup>
          <FilterGroup label={t('graph.filterWhere')}>
            <Dropdown
              variant="chip"
              value={folder}
              onChange={setFolder}
              aria-label={t('graph.filterFolder')}
              options={[{ value: '', label: t('graph.allFolders') }, ...vault.folders().map((f) => ({ value: f, label: folderDisplayName(f, lang) }))]}
            />
            <Dropdown
              variant="chip"
              value={tag}
              onChange={setTag}
              aria-label={t('graph.filterTag')}
              options={[{ value: '', label: t('graph.allTags') }, ...tags.map((x) => ({ value: x, label: `#${x}` }))]}
            />
          </FilterGroup>
          <FilterGroup label={t('graph.filterFocus')}>
            <Dropdown
              variant="chip"
              value={focus}
              onChange={setFocusId}
              aria-label={t('graph.filterFocus')}
              leadingIcon={<LocateFixed size={18} />}
              options={[{ value: '', label: t('graph.noFocus') }, ...noteOptions]}
            />
            {focus && (
              <div className="segmented" role="group" aria-label={t('graph.depth')}>
                {[1, 2, 3].map((d) => (
                  <button key={d} type="button" aria-pressed={depth === d} onClick={() => setDepth(d)} title={t('graph.depthTitle', { n: d })}>
                    {d}
                  </button>
                ))}
              </div>
            )}
          </FilterGroup>
          {bounds[1] > bounds[0] && (
            <div className="space-y-2 lg:col-span-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="section-label">{t('graph.filterTime')}</span>
                <div className="segmented ml-auto h-8" role="group" aria-label={t('graph.filterTime')}>
                  {(['created', 'updated'] as const).map((f) => (
                    <button
                      key={f}
                      type="button"
                      aria-pressed={rangeField === f}
                      onClick={() => {
                        setRangeField(f);
                        setRange(null);
                      }}
                    >
                      {t(f === 'created' ? 'graph.timeCreated' : 'graph.timeUpdated')}
                    </button>
                  ))}
                </div>
              </div>
              <div className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
                <label className="block">
                  <span className="flex justify-between text-body-s text-on-surface-variant">
                    {t('graph.timeFrom')} <span className="tabular-nums text-on-surface">{dayLabel(from)}</span>
                  </span>
                  <input type="range" className="w-full cursor-pointer accent-primary" min={bounds[0]} max={bounds[1]} value={from} onChange={(e) => setBound(0, Number(e.target.value))} />
                </label>
                <label className="block">
                  <span className="flex justify-between text-body-s text-on-surface-variant">
                    {t('graph.timeTo')} <span className="tabular-nums text-on-surface">{dayLabel(to)}</span>
                  </span>
                  <input type="range" className="w-full cursor-pointer accent-primary" min={bounds[0]} max={bounds[1]} value={to} onChange={(e) => setBound(1, Number(e.target.value))} />
                </label>
              </div>
            </div>
          )}
        </div>
      )}

      {focus && (
        <div className="mb-3 flex flex-wrap items-center gap-2 text-body-m text-on-surface-variant">
          <LocateFixed size={18} className="shrink-0 text-primary" />
          <span className="min-w-0 truncate">{t('graph.focusOn', { title: titleOf(focus), n: depth })}</span>
          <button type="button" className="btn-icon h-8 w-8" onClick={() => setFocusId('')} aria-label={t('graph.clearFocus')} title={t('graph.clearFocus')}>
            <X size={18} />
          </button>
        </div>
      )}

      {online && !remoteData ? (
        <div className="card flex flex-col items-center gap-4 px-6 py-16 text-center">
          {remote.phase === 'error' ? (
            <>
              <p className="text-body-m text-muted">{t('graph.loadFailed', { error: remote.error ?? '' })}</p>
              <button type="button" className="btn-tonal" onClick={() => onlineGraph.want()}>
                {t('graph.retry')}
              </button>
            </>
          ) : (
            <LoadBar
              label={remote.received > 0 ? t('graph.loadingDownload') : t('graph.loadingServer')}
              detail={remote.received > 0 ? `${(remote.received / 1_048_576).toFixed(1)} MB` : undefined}
            />
          )}
        </div>
      ) : g.nodes.length === 0 ? (
        <div className="card flex flex-col items-center gap-3 px-6 py-16 text-center">
          <p className="text-body-m text-on-surface-variant">{t('graph.empty')}</p>
          {active > 0 && (
            <button type="button" className="btn-tonal" onClick={reset}>
              {t('graph.reset')}
            </button>
          )}
        </div>
      ) : (
        <Graph nodes={g.nodes} edges={g.edges} focusId={focus || undefined} height={Math.max(420, window.innerHeight - (filterOpen ? 420 : 220))} onOpen={(id) => navigate(`/n/${id}`)} />
      )}
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        <GraphLegend orphans={g.orphans > 0} />
        <div className="ml-auto flex flex-wrap gap-2">
          <FilterChip
            selected={onlyOrphans}
            onClick={() => {
              setOnlyOrphans(!onlyOrphans);
              setOnlyLinked(false);
            }}
          >
            {t('graph.onlyOrphans')}
          </FilterChip>
          <FilterChip
            selected={onlyLinked}
            onClick={() => {
              setOnlyLinked(!onlyLinked);
              setOnlyOrphans(false);
            }}
          >
            {t('graph.onlyLinked')}
          </FilterChip>
        </div>
      </div>
      </PageBody>
    </div>
  );
}
