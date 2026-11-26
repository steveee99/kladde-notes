import { describe, expect, it } from 'vitest';
import { FIELD_HEIGHT, GROUND, PENCIL_W, flap, gapOf, hits, newGame, playerX, restart, speedOf, step } from '../src/lib/flightGame';

const DT = 1 / 120;
const run = (s: ReturnType<typeof newGame>, seconds: number) => {
  for (let i = 0; i < seconds / DT; i++) if (step(s, DT)) return true;
  return false;
};

describe('flight game', () => {
  it('waits for the first flap, then starts with a pencil off screen', () => {
    const s = newGame(400, () => 0.5);
    expect(step(s, 1)).toBe(false);
    expect(s.phase).toBe('ready');
    flap(s);
    expect(s.phase).toBe('playing');
    expect(s.vy).toBeLessThan(0);
    expect(s.pencils).toHaveLength(1);
    expect(s.pencils[0].x).toBeGreaterThan(400);
  });

  it('ends on the ground without flapping and ignores flaps until restarted', () => {
    const s = newGame(400, () => 0.5);
    flap(s);
    expect(run(s, 3)).toBe(true);
    expect(s.phase).toBe('over');
    expect(s.y).toBeLessThanOrEqual(FIELD_HEIGHT - GROUND);
    flap(s);
    expect(s.phase).toBe('over');
    restart(s);
    expect(s).toMatchObject({ phase: 'ready', score: 0, pencils: [] });
  });

  it('scores a point for every pencil passed while flying through the gaps', () => {
    const s = newGame(400, () => 0.5);
    flap(s);
    // Stay in the middle of the gap: flap whenever the notebook sinks below it
    const gapMid = (s.pencils[0].gapTop * 2 + gapOf()) / 2;
    for (let i = 0; i < 12 / DT && s.phase === 'playing'; i++) {
      if (s.y > gapMid + 16 && s.vy > 0) flap(s);
      step(s, DT);
    }
    expect(s.phase).toBe('playing');
    expect(s.score).toBeGreaterThanOrEqual(5);
    expect(s.pencils.every((p) => p.x + PENCIL_W >= -8)).toBe(true);
  });

  it('hits a pencil above or below the gap but not inside it', () => {
    const s = newGame(400);
    const p = { x: playerX(400) - PENCIL_W / 2, gapTop: 60, passed: false };
    s.y = 60 + gapOf() / 2;
    expect(hits(s, p)).toBe(false);
    s.y = 50;
    expect(hits(s, p)).toBe(true);
    s.y = 60 + gapOf() + 5;
    expect(hits(s, p)).toBe(true);
    expect(hits(s, { ...p, x: 0 - PENCIL_W * 3 })).toBe(false);
  });

  it('speeds up with the score up to a limit', () => {
    expect(speedOf(10)).toBeGreaterThan(speedOf(0));
    expect(speedOf(1000)).toBe(speedOf(500));
  });
});
