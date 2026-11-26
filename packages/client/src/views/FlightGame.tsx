import { useEffect, useRef, useState } from 'react';
import { FIELD_HEIGHT, GROUND, PENCIL_W, PLAYER_H, PLAYER_W, type GameState, flap, gapOf, newGame, playerX, resize, restart, step } from '../lib/flightGame';
import { t, useLang } from '../lib/i18n';

/*
 * The home page mini game (feature `minigame`, opt-in): the Kladde notebook flaps through gaps between pencils on
 * dotted paper above a ruler. Drawn on a canvas with the theme tokens, so it follows the color scheme and the accent;
 * the loop only runs while a game is on. Space, ↑, Enter or a click/tap flaps; the best score stays on this device.
 */

const BEST_KEY = 'kladde.minigameBest';
const STEP = 1 / 120;
/** A finished game ignores input this long, so a late flap does not start the next one */
const RESTART_GRACE = 450;

type Colors = Record<'panel' | 'line' | 'line2' | 'text' | 'strong' | 'muted' | 'faint' | 'acc' | 'onAcc' | 'amber' | 'amberHi' | 'red' | 'bg' | 'raised', string> & {
  sans: string;
  mono: string;
};

function readColors(): Colors {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim() || '128 128 128';
  return {
    panel: v('--panel'),
    line: v('--line'),
    line2: v('--line2'),
    text: v('--text'),
    strong: v('--strong'),
    muted: v('--muted'),
    faint: v('--faint'),
    acc: v('--acc'),
    onAcc: v('--on-acc'),
    amber: v('--amber'),
    amberHi: v('--amber-hi'),
    red: v('--red'),
    bg: v('--bg'),
    raised: v('--raised'),
    sans: css.getPropertyValue('--font-sans').trim() || 'system-ui, sans-serif',
    mono: css.getPropertyValue('--font-mono').trim() || 'monospace',
  };
}

const rgb = (triplet: string, alpha = 1) => `rgb(${triplet} / ${alpha})`;

function loadBest(): number {
  try {
    return Number(localStorage.getItem(BEST_KEY)) || 0;
  } catch {
    return 0;
  }
}

function saveBest(n: number) {
  try {
    localStorage.setItem(BEST_KEY, String(n));
  } catch {
    /* ignore */
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

/** A pencil: body from `from` to the tip at `tipY`; `down` points the tip downwards */
function drawPencil(ctx: CanvasRenderingContext2D, c: Colors, x: number, from: number, tipY: number, down: boolean) {
  const tip = 24;
  const lead = 7;
  const dir = down ? 1 : -1;
  const bodyEnd = tipY - dir * tip;
  const top = Math.min(from, bodyEnd);
  const h = Math.abs(bodyEnd - from);
  // Body with three facets
  ctx.fillStyle = rgb(c.amber);
  ctx.fillRect(x, top, PENCIL_W, h);
  ctx.fillStyle = rgb(c.bg, 0.18);
  ctx.fillRect(x + PENCIL_W * 0.66, top, PENCIL_W * 0.34, h);
  ctx.fillStyle = rgb(c.strong, 0.14);
  ctx.fillRect(x + PENCIL_W * 0.08, top, PENCIL_W * 0.16, h);
  // Sharpened wood and the lead
  ctx.fillStyle = rgb(c.amberHi);
  ctx.beginPath();
  ctx.moveTo(x, bodyEnd);
  ctx.lineTo(x + PENCIL_W, bodyEnd);
  ctx.lineTo(x + PENCIL_W / 2, tipY);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = rgb(c.text);
  ctx.beginPath();
  ctx.moveTo(x + PENCIL_W / 2 - (PENCIL_W / 2) * (lead / tip), tipY - dir * lead);
  ctx.lineTo(x + PENCIL_W / 2 + (PENCIL_W / 2) * (lead / tip), tipY - dir * lead);
  ctx.lineTo(x + PENCIL_W / 2, tipY);
  ctx.closePath();
  ctx.fill();
}

/** The Kladde mark (see `AppLogo`) as the player */
function drawNotebook(ctx: CanvasRenderingContext2D, c: Colors, x: number, y: number, tilt: number, flapping: boolean) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(tilt);
  const w = PLAYER_W;
  const h = PLAYER_H;
  if (flapping) {
    // The cover swings open a little: a page behind the notebook
    ctx.fillStyle = rgb(c.text, 0.6);
    ctx.beginPath();
    ctx.moveTo(-w / 2, -h / 2 + 2);
    ctx.lineTo(-w / 2 - 9, -h / 2 + 6);
    ctx.lineTo(-w / 2 - 6, h / 2 - 3);
    ctx.lineTo(-w / 2, h / 2 - 2);
    ctx.closePath();
    ctx.fill();
  }
  ctx.fillStyle = rgb(c.acc);
  roundRect(ctx, -w / 2, -h / 2, w, h, 3.5);
  ctx.fill();
  ctx.fillStyle = rgb(c.onAcc, 0.28);
  ctx.fillRect(-w / 2, -h / 2, 4.5, h);
  ctx.fillStyle = rgb(c.onAcc, 0.55);
  ctx.fillRect(w / 2 - 5.5, -h / 2, 2.2, h);
  ctx.fillStyle = rgb(c.onAcc, 0.8);
  roundRect(ctx, -2, -h / 2 + 5.5, 6, 2.2, 1.1);
  ctx.fill();
  roundRect(ctx, -2, -h / 2 + 9.8, 3.8, 2.2, 1.1);
  ctx.fill();
  ctx.restore();
}

function draw(ctx: CanvasRenderingContext2D, s: GameState, c: Colors, best: number, record: boolean, paused: boolean, still: boolean) {
  const w = s.width;
  const field = FIELD_HEIGHT - GROUND;
  ctx.clearRect(0, 0, w, FIELD_HEIGHT);
  ctx.fillStyle = rgb(c.panel);
  ctx.fillRect(0, 0, w, FIELD_HEIGHT);
  // Dotted paper, scrolling slower than the pencils
  const grid = 16;
  const shift = still ? 0 : (s.distance * 0.35) % grid;
  ctx.fillStyle = rgb(c.line2);
  for (let gx = grid - shift; gx < w; gx += grid) for (let gy = grid; gy < field; gy += grid) ctx.fillRect(gx - 0.75, gy - 0.75, 1.5, 1.5);
  // The margin line of an exercise book
  ctx.fillStyle = rgb(c.red, 0.35);
  ctx.fillRect(28, 0, 1, field);

  for (const p of s.pencils) {
    drawPencil(ctx, c, p.x, -40, p.gapTop, true);
    drawPencil(ctx, c, p.x, field + 40, p.gapTop + gapOf(), false);
  }

  // The ground is a ruler
  ctx.fillStyle = rgb(c.raised);
  ctx.fillRect(0, field, w, GROUND);
  ctx.fillStyle = rgb(c.line2);
  ctx.fillRect(0, field, w, 1);
  const tick = 8;
  const offset = s.distance % (tick * 5);
  ctx.fillStyle = rgb(c.faint);
  for (let i = 0, tx = -offset; tx < w; i++, tx += tick) ctx.fillRect(Math.round(tx), field + 1, 1, i % 5 === 0 ? 8 : 4);

  const px = playerX(w);
  const tilt = s.phase === 'ready' ? 0 : Math.max(-0.45, Math.min(1.1, s.vy / 420));
  drawNotebook(ctx, c, px, s.y, tilt, s.phase === 'playing' && s.vy < -120);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (s.phase === 'playing') {
    ctx.font = `600 22px ${c.mono}`;
    ctx.fillStyle = rgb(c.strong);
    ctx.fillText(String(s.score), w / 2, 26);
  }
  const card = (lines: [string, string, string][], low = false) => {
    const widest = Math.max(
      ...lines.map(([text, font]) => {
        ctx.font = font;
        return ctx.measureText(text).width;
      }),
    );
    const cw = Math.min(w - 24, Math.ceil(widest) + 36);
    const ch = 22 + lines.length * 22;
    const cx = (w - cw) / 2;
    // At the start the notebook floats in the middle: the card sits below it
    const cy = low ? field - ch - 14 : (field - ch) / 2;
    ctx.fillStyle = rgb(c.panel, 0.92);
    roundRect(ctx, cx, cy, cw, ch, 8);
    ctx.fill();
    ctx.strokeStyle = rgb(c.line2);
    ctx.lineWidth = 1;
    ctx.stroke();
    lines.forEach(([text, font, color], i) => {
      ctx.font = font;
      ctx.fillStyle = color;
      ctx.fillText(text, w / 2, cy + 22 + i * 22);
    });
  };
  if (paused && s.phase === 'playing') card([[t('minigame.paused'), `600 15px ${c.sans}`, rgb(c.strong)], [t('minigame.resume'), `13px ${c.sans}`, rgb(c.muted)]]);
  else if (s.phase === 'ready')
    card([
      [t('minigame.ready'), `600 15px ${c.sans}`, rgb(c.strong)],
      [best ? t('minigame.best', { n: best }) : t('minigame.hint'), `13px ${c.sans}`, rgb(c.muted)],
    ], true);
  else if (s.phase === 'over')
    card([
      [t('minigame.score', { n: s.score }), `600 15px ${c.sans}`, rgb(c.strong)],
      ...(best > 0 ? [[record ? t('minigame.newBest') : t('minigame.best', { n: best }), `13px ${c.mono}`, rgb(record ? c.acc : c.muted)] as [string, string, string]] : []),
      [t('minigame.again'), `13px ${c.sans}`, rgb(c.muted)],
    ]);
}

export function FlightGame({ onBest }: { onBest?: (best: number) => void }) {
  const lang = useLang();
  const redraw = useRef<() => void>(() => undefined);
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [announce, setAnnounce] = useState('');

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!wrap || !canvas || !ctx) return;
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const game = newGame(Math.max(240, wrap.clientWidth));
    let colors = readColors();
    let best = loadBest();
    let frame = 0;
    let last = 0;
    let acc = 0;
    let paused = false;
    let endedAt = 0;
    let record = false;

    const render = () => draw(ctx, game, colors, best, record, paused, still);
    redraw.current = render;
    const fit = () => {
      const width = Math.max(240, Math.floor(wrap.clientWidth));
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(FIELD_HEIGHT * dpr);
      canvas.style.height = `${FIELD_HEIGHT}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      resize(game, width);
      render();
    };
    const stop = () => {
      cancelAnimationFrame(frame);
      frame = 0;
    };
    const tick = (now: number) => {
      acc += Math.min(0.1, (now - last) / 1000);
      last = now;
      let ended = false;
      while (acc >= STEP && !ended) {
        ended = step(game, STEP);
        acc -= STEP;
      }
      render();
      if (!ended) {
        frame = requestAnimationFrame(tick);
        return;
      }
      frame = 0;
      endedAt = performance.now();
      record = game.score > best;
      if (record) {
        best = game.score;
        saveBest(best);
        onBest?.(best);
      }
      render();
      setAnnounce(t('minigame.overAnnounce', { n: game.score, best }));
    };
    const run = () => {
      if (frame) return;
      last = performance.now();
      acc = 0;
      frame = requestAnimationFrame(tick);
    };
    const input = () => {
      if (game.phase === 'over') {
        if (performance.now() - endedAt < RESTART_GRACE) return;
        restart(game);
        record = false;
        setAnnounce('');
        render();
        return;
      }
      if (paused) paused = false;
      else if (game.phase === 'ready') setAnnounce(t('minigame.started'));
      flap(game);
      run();
    };
    const onPointer = (e: PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      canvas.focus({ preventScroll: true });
      input();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key === ' ' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === 'w') {
        e.preventDefault();
        input();
      }
    };
    const pause = () => {
      if (game.phase !== 'playing' || paused) return;
      paused = true;
      stop();
      render();
    };
    const onVisibility = () => document.hidden && pause();

    const resizer = new ResizeObserver(fit);
    resizer.observe(wrap);
    // Color scheme, palette or accent changed: draw with the new tokens
    const themer = new MutationObserver(() => {
      colors = readColors();
      render();
    });
    themer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-scheme', 'data-palette', 'data-accent', 'data-theme'] });
    // A game that scrolled out of view pauses
    const viewer = new IntersectionObserver(([entry]) => !entry.isIntersecting && pause());
    viewer.observe(canvas);
    canvas.addEventListener('pointerdown', onPointer);
    canvas.addEventListener('keydown', onKey);
    canvas.addEventListener('blur', pause);
    document.addEventListener('visibilitychange', onVisibility);
    void document.fonts?.ready.then(render);
    fit();
    return () => {
      stop();
      resizer.disconnect();
      themer.disconnect();
      viewer.disconnect();
      canvas.removeEventListener('pointerdown', onPointer);
      canvas.removeEventListener('keydown', onKey);
      canvas.removeEventListener('blur', pause);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [onBest]);
  // The texts on the canvas follow the language
  useEffect(() => redraw.current(), [lang]);

  return (
    <div ref={wrapRef} className="relative overflow-hidden" data-minigame>
      <canvas
        ref={canvasRef}
        tabIndex={0}
        role="img"
        aria-label={t('minigame.canvasAria')}
        className="block w-full cursor-pointer touch-manipulation select-none outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-acc"
        style={{ height: FIELD_HEIGHT }}
      />
      <p className="sr-only" aria-live="polite">
        {announce}
      </p>
    </div>
  );
}

export const minigameBest = loadBest;
