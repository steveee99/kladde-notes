import { fitPrintDiagram, mindmapToMermaid, svgNaturalSize } from '@kladde/shared';
import { t } from '../lib/i18n';

/**
 * Renders ```mermaid and ```mindmap blocks to SVG. Mermaid is large, so it is loaded on first use
 * (the PWA still precaches its chunks, so diagrams work offline). Colors come from the Material 3 theme variables.
 */

export type DiagramKind = 'mermaid' | 'mindmap';

type Mermaid = typeof import('mermaid').default;

let loading: Promise<Mermaid> | null = null;
let configuredFor = '';
let counter = 0;
/** SVG (or error) per theme + source, so re-created widgets show up without a flicker */
const cache = new Map<string, { svg?: string; error?: string }>();

const isDark = () => document.documentElement.dataset.scheme !== 'light';
/** Colors for paper (print and exports) instead of the app's scheme */
const PAPER = 'paper';
const screenKey = () => `${document.documentElement.dataset.theme ?? 'werkbank'}-${isDark() ? 'dark' : 'light'}-${document.documentElement.dataset.accent ?? 'blue'}`;

/** The browser is printing: diagrams on the page take their paper colors and size */
let printing = false;
export const isPrinting = () => printing;

/** "R G B" variable → #rrggbb (Mermaid's color math needs hex) */
function cssColor(name: string): string {
  const parts = getComputedStyle(document.documentElement).getPropertyValue(name).trim().split(/[\s/]+/).slice(0, 3).map(Number);
  if (parts.length < 3 || parts.some((n) => Number.isNaN(n))) return '#888888';
  return `#${parts.map((n) => Math.round(n).toString(16).padStart(2, '0')).join('')}`;
}

/** The light scheme on white, whatever scheme the app shows */
const PAPER_COLORS = {
  bg: '#ffffff',
  surface: '#ffffff',
  raised: '#f1eee7',
  line: '#d2ccc0',
  ink: '#211f1c',
  muted: '#645f57',
  accent: '#2642ba',
  onAccent: '#ffffff',
  accent2: '#6941c6',
  ok: '#1a7444',
  warn: '#8a5800',
  danger: '#b42318',
};

function themeVariables(paper: boolean) {
  const v = paper ? PAPER_COLORS : {
    bg: cssColor('--surface'),
    surface: cssColor('--surface-container-low'),
    raised: cssColor('--surface-container-high'),
    line: cssColor('--outline-variant'),
    ink: cssColor('--on-surface'),
    muted: cssColor('--on-surface-variant'),
    accent: cssColor('--primary'),
    onAccent: cssColor('--on-primary'),
    accent2: cssColor('--tertiary'),
    ok: cssColor('--ok'),
    warn: cssColor('--warn'),
    danger: cssColor('--error'),
  };
  // Mind map branches and pie slices cycle through these
  const scale = [v.accent, v.accent2, v.warn, v.ok, v.danger, v.muted];
  const extra: Record<string, string> = {};
  for (let i = 0; i < 12; i++) {
    extra[`cScale${i}`] = scale[i % scale.length];
    extra[`cScaleLabel${i}`] = v.onAccent;
    extra[`pie${i + 1}`] = scale[i % scale.length];
  }
  return {
    darkMode: !paper && isDark(),
    // An exported SVG becomes an image, where web fonts do not load: its labels are measured with a font that is there
    fontFamily: paper ? 'Arial, Helvetica, sans-serif' : getComputedStyle(document.body).fontFamily,
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
    // Mind map root label (sits on git0)
    gitBranchLabel0: v.onAccent,
    ...extra,
  };
}

async function mermaid(theme: string): Promise<Mermaid> {
  loading ??= import('mermaid').then((m) => m.default);
  const m = await loading;
  if (configuredFor !== theme) {
    m.initialize({
      startOnLoad: false,
      // Notes can be shared: no scripts, no click handlers, sanitized labels
      securityLevel: 'strict',
      suppressErrorRendering: true,
      theme: 'base',
      themeVariables: themeVariables(theme === PAPER),
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
  const screen = cache.get(`${screenKey()}\n${kind}\n${src}`);
  return printing ? (cache.get(`${PAPER}\n${kind}\n${src}`) ?? screen) : screen;
}

/** Diagrams are drawn one after the other: Mermaid has one configuration, and paper and screen differ */
let queue: Promise<unknown> = Promise.resolve();

export function renderDiagram(kind: DiagramKind, src: string, paper = false): Promise<{ svg?: string; error?: string }> {
  const theme = paper ? PAPER : screenKey();
  const hit = cache.get(`${theme}\n${kind}\n${src}`);
  if (hit) return Promise.resolve(hit);
  const job = queue.then(() => draw(kind, src, theme));
  queue = job;
  return job;
}

async function draw(kind: DiagramKind, src: string, theme: string): Promise<{ svg?: string; error?: string }> {
  // The scheme may have changed while the diagram waited for its turn: the cache must not mix the colors
  if (theme !== PAPER) theme = screenKey();
  const key = `${theme}\n${kind}\n${src}`;
  const hit = cache.get(key);
  if (hit) return hit;
  let result: { svg?: string; error?: string };
  const id = `wz-mermaid-${++counter}`;
  try {
    const m = await mermaid(theme);
    const code = diagramSource(kind, src);
    if (!code.trim()) result = { error: t('editor.diagramEmpty') };
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

/** Room for a diagram on an A4 page with the margins of the print styles, in CSS pixels */
const PRINT_PAGE = { width: 640, height: 1000 };

function sizeForPaper(el: HTMLElement) {
  const svg = el.querySelector('svg');
  const natural = svg && svgNaturalSize({ viewBox: svg.getAttribute('viewBox') });
  if (!svg || !natural) return;
  svg.style.width = `${fitPrintDiagram(natural, PRINT_PAGE).width}px`;
  svg.style.maxWidth = '100%';
}

/** Fills `el` with the diagram (or its error); `done` runs once the size is final */
export function drawDiagram(el: HTMLElement, kind: DiagramKind, src: string, done?: () => void): void {
  el.dataset.kind = kind;
  el.dataset.src = src;
  const show = (r: { svg?: string; error?: string }) => {
    el.classList.toggle('wz-diagram-failed', !!r.error);
    if (r.svg) {
      el.innerHTML = r.svg;
      if (printing) sizeForPaper(el);
    } else {
      const err = document.createElement('div');
      err.className = 'wz-query-error';
      err.textContent = t('editor.diagramError', { error: (r.error ?? '').split('\n')[0] });
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
    wait.textContent = t('editor.diagramDrawing');
    el.replaceChildren(wait);
  }
  void renderDiagram(kind, src, printing).then((r) => {
    // A newer source may have arrived meanwhile
    if (el.dataset.src === src && el.dataset.kind === kind) show(r);
  });
}

function redrawAll() {
  document.querySelectorAll<HTMLElement>('.wz-diagram[data-kind][data-src]').forEach((el) => {
    drawDiagram(el, el.dataset.kind as DiagramKind, el.dataset.src ?? '');
  });
}

/** Switches the diagrams on the page to their paper colors while printing, and back */
export function setPaperDiagrams(on: boolean): void {
  if (printing === on) return;
  printing = on;
  redrawAll();
}

// Redraw the diagrams on screen in the new colors when the color scheme changes
if (typeof MutationObserver !== 'undefined' && typeof document !== 'undefined') {
  new MutationObserver(redrawAll).observe(document.documentElement, { attributes: true, attributeFilter: ['data-scheme', 'data-accent'] });
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
