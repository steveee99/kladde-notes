import { useEffect, useRef, useState } from 'react';
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, SimulationLinkDatum, SimulationNodeDatum } from 'd3-force';
import type { GraphEdge, GraphNode } from '@kladde/shared';
import { roleOfFolder } from '@kladde/shared';
import { useVault, vault } from '../data/vault';
import { navigate } from '../lib/router';

interface SimNode extends SimulationNodeDatum, GraphNode {}
type SimLink = SimulationLinkDatum<SimNode>;

/** Node colour by PARA role, taken from the theme variables */
const ROLE_VAR: Record<string, string> = { inbox: '--warn', projects: '--accent', areas: '--ok', resources: '--accent2', archive: '--faint', zettel: '--danger' };
const LEGEND: [string, string][] = [
  ['projects', 'Projekte'],
  ['areas', 'Bereiche'],
  ['resources', 'Ressourcen'],
  ['zettel', 'Zettel'],
  ['inbox', 'Inbox'],
  ['archive', 'Archiv'],
];

function cssColor(name: string, alpha = 1): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim().split(/\s+/).join(',');
  return `rgba(${v},${alpha})`;
}

export function Graph({ nodes, edges, focusId, height, onOpen }: { nodes: GraphNode[]; edges: GraphEdge[]; focusId?: string; height: number; onOpen: (id: string) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hoverTitle, setHoverTitle] = useState<string | null>(null);

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
    const colors = () => ({
      line: cssColor('--line'),
      lineHi: cssColor('--accent', 0.8),
      text: cssColor('--ink'),
      muted: cssColor('--muted'),
      bg: cssColor('--bg'),
      role: Object.fromEntries(Object.entries(ROLE_VAR).map(([r, v]) => [r, cssColor(v)])),
      other: cssColor('--muted'),
    });
    let palette = colors();

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

    const sim = forceSimulation(simNodes)
      .force('link', forceLink<SimNode, SimLink>(simLinks).id((d) => d.id).distance(80).strength(0.5))
      .force('charge', forceManyBody().strength(-260))
      .force('center', forceCenter(0, 0))
      .force('x', forceX(0).strength(0.05))
      .force('y', forceY(0).strength(0.05))
      .force('collide', forceCollide<SimNode>().radius((d) => radius(d) + 16))
      .on('tick', () => draw());

    function toWorld(px: number, py: number) {
      return { x: (px - width / 2 - view.x) / view.k, y: (py - height / 2 - view.y) / view.k };
    }

    function nodeAt(px: number, py: number): SimNode | null {
      const p = toWorld(px, py);
      let best: SimNode | null = null;
      let bestD = Infinity;
      for (const n of simNodes) {
        const d = Math.hypot((n.x ?? 0) - p.x, (n.y ?? 0) - p.y);
        if (d < radius(n) + 6 / view.k && d < bestD) (best = n), (bestD = d);
      }
      return best;
    }

    function draw() {
      ctx.save();
      ctx.clearRect(0, 0, width, height);
      ctx.translate(width / 2 + view.x, height / 2 + view.y);
      ctx.scale(view.k, view.k);
      const active = hover ?? (focusId ? byId.get(focusId) ?? null : null);
      const near = active ? neighbours.get(active.id) ?? new Set() : null;
      ctx.lineWidth = 1 / view.k;
      for (const l of simLinks) {
        const s = l.source as SimNode;
        const t = l.target as SimNode;
        const hi = active && (s.id === active.id || t.id === active.id);
        ctx.strokeStyle = hi ? palette.lineHi : palette.line;
        ctx.globalAlpha = active && !hi ? 0.35 : 1;
        ctx.beginPath();
        ctx.moveTo(s.x!, s.y!);
        ctx.lineTo(t.x!, t.y!);
        ctx.stroke();
      }
      for (const n of simNodes) {
        const role = roleOfFolder(n.folder);
        const dim = active && n.id !== active.id && !near!.has(n.id);
        ctx.globalAlpha = dim ? 0.25 : 1;
        ctx.fillStyle = (role && palette.role[role]) || palette.other;
        ctx.beginPath();
        ctx.arc(n.x!, n.y!, radius(n), 0, Math.PI * 2);
        ctx.fill();
        if (n.id === focusId) {
          ctx.strokeStyle = palette.text;
          ctx.lineWidth = 2 / view.k;
          ctx.stroke();
          ctx.lineWidth = 1 / view.k;
        }
        const label = n.id === active?.id || near?.has(n.id) || view.k > 1.4 || n.links >= 4 || simNodes.length < 25;
        if (label && !dim) {
          ctx.font = `${12 / view.k}px Inter, system-ui, sans-serif`;
          ctx.textAlign = 'center';
          ctx.fillStyle = n.id === active?.id ? palette.text : palette.muted;
          const text = n.title.length > 32 ? `${n.title.slice(0, 30)}…` : n.title;
          ctx.fillText(text, n.x!, n.y! + radius(n) + 13 / view.k);
        }
      }
      ctx.restore();
    }

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
        sim.alphaTarget(0.3).restart();
      } else panning = { x: p.x, y: p.y, vx: view.x, vy: view.y };
    };
    const onMove = (e: PointerEvent) => {
      const p = pos(e);
      if (dragging) {
        const w = toWorld(p.x, p.y);
        dragging.fx = w.x;
        dragging.fy = w.y;
        moved = true;
      } else if (panning) {
        view = { ...view, x: panning.vx + p.x - panning.x, y: panning.vy + p.y - panning.y };
        moved = moved || Math.abs(p.x - panning.x) + Math.abs(p.y - panning.y) > 4;
        draw();
      } else {
        const h = nodeAt(p.x, p.y);
        if (h !== hover) {
          hover = h;
          canvas.style.cursor = h ? 'pointer' : 'grab';
          setHoverTitle(h?.title ?? null);
          draw();
        }
      }
    };
    const onUp = (e: PointerEvent) => {
      const p = pos(e);
      if (dragging) {
        dragging.fx = null;
        dragging.fy = null;
        sim.alphaTarget(0);
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
      const k = Math.min(4, Math.max(0.25, view.k * Math.exp(-e.deltaY * 0.0015)));
      view = { k, x: p.x - ((p.x - view.x) * k) / view.k, y: p.y - ((p.y - view.y) * k) / view.k };
      draw();
    };
    const onLeave = () => {
      hover = null;
      setHoverTitle(null);
      draw();
    };

    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointerleave', onLeave);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);
    // Theme switch: re-read the colours
    const mo = new MutationObserver(() => {
      palette = colors();
      draw();
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    resize();
    return () => {
      sim.stop();
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
  }, [JSON.stringify(nodes.map((n) => [n.id, n.title, n.folder, n.links])), JSON.stringify(edges), focusId, height]);

  return (
    <div ref={wrapRef} className="relative w-full touch-none select-none overflow-hidden rounded-2xl border border-line bg-surface">
      <canvas ref={canvasRef} className="block cursor-grab" />
      {hoverTitle && <div className="pointer-events-none absolute left-3 top-3 rounded-lg bg-raised px-2 py-1 text-xs anim-fade-in">{hoverTitle}</div>}
    </div>
  );
}

export function GraphLegend() {
  return (
    <div className="flex flex-wrap gap-3 text-xs text-muted">
      {LEGEND.map(([role, label]) => (
        <span key={role} className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: `rgb(var(${ROLE_VAR[role]}))` }} />
          {label}
        </span>
      ))}
    </div>
  );
}

/** Whole knowledge network */
export function GraphView() {
  useVault();
  const [hideArchive, setHideArchive] = useState(true);
  const [onlyLinked, setOnlyLinked] = useState(false);
  const g = vault.links().graph();
  const nodes = g.nodes.filter((n) => (!hideArchive || roleOfFolder(n.folder) !== 'archive') && (!onlyLinked || n.links > 0));
  const ids = new Set(nodes.map((n) => n.id));
  const edges = g.edges.filter((e) => ids.has(e.source) && ids.has(e.target));
  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-8 sm:py-8">
      <div className="mb-4 flex flex-wrap items-center gap-3 anim-fade-up">
        <h1 className="text-2xl font-bold tracking-tight">Wissensnetz</h1>
        <span className="text-sm text-faint">
          {nodes.length} Notizen · {edges.length} Verbindungen
        </span>
        <label className="ml-auto flex items-center gap-1.5 text-sm text-muted">
          <input type="checkbox" checked={hideArchive} onChange={(e) => setHideArchive(e.target.checked)} /> Archiv ausblenden
        </label>
        <label className="flex items-center gap-1.5 text-sm text-muted">
          <input type="checkbox" checked={onlyLinked} onChange={(e) => setOnlyLinked(e.target.checked)} /> Nur verbundene
        </label>
      </div>
      <Graph nodes={nodes} edges={edges} height={Math.max(420, window.innerHeight - 220)} onOpen={(id) => navigate(`/n/${id}`)} />
      <div className="mt-3">
        <GraphLegend />
      </div>
    </div>
  );
}
