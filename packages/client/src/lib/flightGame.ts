/*
 * The rules of the home page mini game (feature `minigame`): a little notebook flaps through gaps between pencils.
 * Pure state and physics without the DOM, so the canvas view (`views/FlightGame.tsx`) only draws and forwards input.
 * Units are CSS pixels and seconds; the field is `width` × FIELD_HEIGHT with the ground at its bottom.
 */

export const FIELD_HEIGHT = 240;
export const GROUND = 22;
export const PLAYER_W = 20;
export const PLAYER_H = 24;
export const PENCIL_W = 30;
const GRAVITY = 980;
const FLAP = -300;
const MAX_FALL = 420;
const GAP = 84;
const SPACING = 176;
const BASE_SPEED = 128;
const MAX_SPEED = 196;
/** Collisions forgive a few pixels, the drawing has round corners */
const SLACK = 3;

export type Phase = 'ready' | 'playing' | 'over';

export interface Pencil {
  x: number;
  /** Top edge of the gap */
  gapTop: number;
  passed: boolean;
}

export interface GameState {
  phase: Phase;
  width: number;
  /** Center of the notebook */
  y: number;
  vy: number;
  pencils: Pencil[];
  score: number;
  /** Distance travelled, drives the background's scrolling */
  distance: number;
  random: () => number;
}

export const playerX = (width: number) => Math.round(Math.max(56, width * 0.26));
export const speedOf = (score: number) => Math.min(MAX_SPEED, BASE_SPEED + score * 3);

export function newGame(width: number, random: () => number = Math.random): GameState {
  return { phase: 'ready', width, y: (FIELD_HEIGHT - GROUND) / 2, vy: 0, pencils: [], score: 0, distance: 0, random };
}

function spawn(s: GameState, x: number) {
  const min = 18;
  const max = FIELD_HEIGHT - GROUND - GAP - 18;
  s.pencils.push({ x, gapTop: Math.round(min + s.random() * (max - min)), passed: false });
}

/** A flap: starts a ready game, lifts the notebook while playing; a finished game waits for `restart` */
export function flap(s: GameState) {
  if (s.phase === 'over') return;
  if (s.phase === 'ready') {
    s.phase = 'playing';
    spawn(s, s.width + 40);
  }
  s.vy = FLAP;
}

export function restart(s: GameState) {
  Object.assign(s, newGame(s.width, s.random));
}

export function resize(s: GameState, width: number) {
  s.width = width;
}

/** Whether the notebook touches a pencil (the shaft above or below the gap) */
export function hits(s: GameState, p: Pencil): boolean {
  const px = playerX(s.width);
  const left = px - PLAYER_W / 2 + SLACK;
  const right = px + PLAYER_W / 2 - SLACK;
  if (right <= p.x || left >= p.x + PENCIL_W) return false;
  const top = s.y - PLAYER_H / 2 + SLACK;
  const bottom = s.y + PLAYER_H / 2 - SLACK;
  return top < p.gapTop || bottom > p.gapTop + GAP;
}

export const gapOf = () => GAP;

/** Advances the game by `dt` seconds; returns true when this step ended it */
export function step(s: GameState, dt: number): boolean {
  if (s.phase !== 'playing') return false;
  const speed = speedOf(s.score);
  s.distance += speed * dt;
  s.vy = Math.min(MAX_FALL, s.vy + GRAVITY * dt);
  s.y += s.vy * dt;
  if (s.y < PLAYER_H / 2) {
    s.y = PLAYER_H / 2;
    s.vy = 0;
  }
  const px = playerX(s.width);
  for (const p of s.pencils) {
    p.x -= speed * dt;
    if (!p.passed && p.x + PENCIL_W < px - PLAYER_W / 2) {
      p.passed = true;
      s.score += 1;
    }
  }
  while (s.pencils.length && s.pencils[0].x + PENCIL_W < -8) s.pencils.shift();
  const last = s.pencils[s.pencils.length - 1];
  if (!last || last.x < s.width + 40 - SPACING) spawn(s, (last ? last.x : s.width) + SPACING);
  const floor = FIELD_HEIGHT - GROUND - PLAYER_H / 2;
  if (s.y >= floor || s.pencils.some((p) => hits(s, p))) {
    s.y = Math.min(s.y, floor);
    s.phase = 'over';
    return true;
  }
  return false;
}
