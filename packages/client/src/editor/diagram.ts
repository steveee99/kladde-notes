import { mindmapToMermaid } from '@kladde/shared';

/**
 * Renders ```mermaid and ```mindmap blocks to SVG. Mermaid is large, so it is loaded on first use
 * (the PWA still precaches its chunks, so diagrams work offline). Colors come from the theme
 * variables; when the theme changes, every visible diagram is drawn again.
 */

export type DiagramKind = 'mermaid' | 'mindmap';

type Mermaid = typeof import('mermaid').default;

let loading: Promise<Mermaid> | null = null;
let configuredFor = '';
let counter = 0;
/** SVG (or error) per theme + source, so re-created widgets show up without a flicker */
const cache = new Map<string, { svg?: string; error?: string }>();

const themeKey = () => document.documentElement.dataset.theme ?? 'light';

/** "R G B" variable → #rrggbb (Mermaid's color math needs hex) */
function cssColor(name: string): string {
  const parts = getComputedStyle(document.documentElement).getPropertyValue(name).trim().split(/[\s/]+/).slice(0, 3).map(Number);
  if (parts.length < 3 || parts.some((n) => Number.isNaN(n))) return '#888888';
  return `#${parts.map((n) => Math.round(n).toString(16).padStart(2, '0')).join('')}`;
}

function themeVariables() {
  const v = {
    bg: cssColor('--bg'),
    surface: cssColor('--surface'),
    raised: cssColor('--raised'),
    line: cssColor('--line'),
    ink: cssColor('--ink'),
    muted: cssColor('--muted'),
    accent: cssColor('--accent'),
    onAccent: cssColor('--on-accent'),
    accent2: cssColor('--accent2'),
    ok: cssColor('--ok'),
    warn: cssColor('--warn'),
    danger: cssColor('--danger'),
  };
  const dark = themeKey() !== 'light';
  // Mind map branches and pie slices cycle through these
  const scale = [v.accent, v.accent2, v.warn, v.ok, v.danger, v.muted];
  const extra: Record<string, string> = {};
  for (let i = 0; i < 12; i++) {
    extra[`cScale${i}`] = scale[i % scale.length];
    extra[`cScaleLabel${i}`] = v.onAccent;
    extra[`pie${i + 1}`] = scale[i % scale.length];
  }
  return {
    darkMode: dark,
    fontFamily: getComputedStyle(document.body).fontFamily,
    fontSize: '14px',
    background: v.surface,
    primaryColor: v.raised,
    primaryTextColor: v.ink,
    primaryBorderColor: v.accent,
    secondaryColor: v.surface,
    secondaryTextColor: v.ink,
    secondaryBorderColor: v.line,
    tertiaryColor: v.bg,
    tertiaryTextColor: v.ink,
    tertiaryBorderColor: v.line,
    lineColor: v.muted,
    textColor: v.ink,
    titleColor: v.ink,
    mainBkg: v.raised,
    nodeBorder: v.accent,
    clusterBkg: v.bg,
    clusterBorder: v.line,
    edgeLabelBackground: v.surface,
    noteBkgColor: v.raised,
    noteTextColor: v.ink,
    noteBorderColor: v.line,
    actorBkg: v.raised,
    actorBorder: v.accent,
    actorTextColor: v.ink,
    signalColor: v.muted,
    signalTextColor: v.ink,
    labelBoxBkgColor: v.raised,
    labelTextColor: v.ink,
    pieStrokeColor: v.surface,
    pieOuterStrokeColor: v.line,
    pieTitleTextColor: v.ink,
    pieSectionTextColor: v.onAccent,
    pieLegendTextColor: v.ink,
    git0: v.accent,
    git1: v.accent2,
    git2: v.warn,
    git3: v.ok,
    ...extra,
  };
}

async function mermaid(): Promise<Mermaid> {
  loading ??= import('mermaid').then((m) => m.default);
  const m = await loading;
  const theme = themeKey();
  if (configuredFor !== theme) {
    m.initialize({
      startOnLoad: false,
      // Notes can be shared: no scripts, no click handlers, sanitized labels
      securityLevel: 'strict',
      suppressErrorRendering: true,
      theme: 'base',
      themeVariables: themeVariables(),
      flowchart: { htmlLabels: true, curve: 'basis' },
    });
    configuredFor = theme;
  }
  return m;
}

export function diagramSource(kind: DiagramKind, src: string): string {
  return kind === 'mindmap' ? mindmapToMermaid(src) : src;
}

export function cachedDiagram(kind: DiagramKind, src: string) {
  return cache.get(`${themeKey()}\n${kind}\n${src}`);
}

export async function renderDiagram(kind: DiagramKind, src: string): Promise<{ svg?: string; error?: string }> {
  const key = `${themeKey()}\n${kind}\n${src}`;
  const hit = cache.get(key);
  if (hit) return hit;
  let result: { svg?: string; error?: string };
  const id = `wz-mermaid-${++counter}`;
  try {
    const m = await mermaid();
    const code = diagramSource(kind, src);
    if (!code.trim()) result = { error: 'Leeres Diagramm' };
    else result = { svg: (await m.render(id, code)).svg };
  } catch (e) {
    result = { error: e instanceof Error ? e.message : String(e) };
    // Mermaid may leave its scratch element behind after a parse error
    document.getElementById(id)?.remove();
    document.getElementById(`d${id}`)?.remove();
  }
  if (cache.size > 100) cache.delete(cache.keys().next().value!);
  cache.set(key, result);
  return result;
}

/** Fills `el` with the diagram (or its error); `done` runs once the size is final */
export function drawDiagram(el: HTMLElement, kind: DiagramKind, src: string, done?: () => void): void {
  el.dataset.kind = kind;
  el.dataset.src = src;
  const show = (r: { svg?: string; error?: string }) => {
    el.classList.toggle('wz-diagram-failed', !!r.error);
    if (r.svg) el.innerHTML = r.svg;
    else {
      const err = document.createElement('div');
      err.className = 'wz-query-error';
      err.textContent = `Diagramm-Fehler: ${(r.error ?? '').split('\n')[0]}`;
      const pre = document.createElement('pre');
      pre.className = 'wz-diagram-src';
      pre.textContent = src;
      el.replaceChildren(err, pre);
    }
    done?.();
  };
  const hit = cachedDiagram(kind, src);
  if (hit) return show(hit);
  if (!el.firstChild) {
    const wait = document.createElement('div');
    wait.className = 'wz-diagram-wait';
    wait.textContent = 'Diagramm wird gezeichnet …';
    el.replaceChildren(wait);
  }
  void renderDiagram(kind, src).then((r) => {
    // A newer source may have arrived meanwhile
    if (el.dataset.src === src && el.dataset.kind === kind) show(r);
  });
}

/** Full-screen view for large diagrams */
export function openDiagram(svg: string) {
  const box = document.createElement('div');
  box.className = 'wz-lightbox wz-diagram-lightbox anim-fade-in';
  const inner = document.createElement('div');
  inner.className = 'wz-diagram-full anim-pop';
  inner.innerHTML = svg;
  box.append(inner);
  box.addEventListener('click', () => box.remove());
  document.body.append(box);
}

// Theme switch: draw every visible diagram with the new colors
new MutationObserver(() => {
  for (const el of document.querySelectorAll<HTMLElement>('.wz-diagram[data-src]')) {
    drawDiagram(el, el.dataset.kind as DiagramKind, el.dataset.src!);
  }
}).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
