import { APP_VERSION } from '@kladde/shared';
import { registerSW } from 'virtual:pwa-register';
import { SERVER_VERSION_EVENT } from '../data/vault';

/**
 * Every deploy is applied right away, but not in the middle of the user's work. The service worker alone is
 * not enough: the browser only looks for a new one on a navigation, and an iOS home-screen app often resumes
 * from the background without one, so an old version could stay for days. So the app compares its version
 * with the server's: when the live event stream (re)connects (a deploy restarts the server, so every open
 * client hears of it within seconds), when the app starts, comes back to the foreground or goes online
 * again, and every few minutes as a fallback. If it differs it updates the service worker, and if no new
 * worker shows up soon it drops the service worker and its caches instead.
 *
 * The reload itself waits for a calm moment (see `whenCalm`): the app in the background, right after
 * start, or the user not typing for a few seconds (the cursor may stay in the editor). After it the app skips its entry animations and shows the cached
 * account at once, so the update looks like nothing happened instead of the whole screen blinking.
 * Notes live in IndexedDB, not in these caches, so nothing is lost.
 */
const RESET_KEY = 'kladde_update_reset';
const UPDATED_KEY = 'kladde_updated';
const ATTACHMENT_CACHE = 'kladde-files';
/** Right after start the user has not done anything yet: a reload then is not noticed */
const STARTUP_MS = 2500;
/** No key, click or touch for this long counts as a pause, even with the cursor still in a field */
const IDLE_MS = 10_000;
/** Fallback check while the app is open, in case the event stream hangs behind a proxy */
const CHECK_EVERY_MS = 10 * 60_000;

let registration: ServiceWorkerRegistration | undefined;
let applyUpdate: ((reload?: boolean) => Promise<void>) | undefined;
let checking = false;
let pending: (() => void) | null = null;
const startedAt = Date.now();
let lastInput = 0;

function markUpdated() {
  try {
    sessionStorage.setItem(UPDATED_KEY, '1');
  } catch {
    // private mode: the app just animates in once
  }
}

/** Typing in the editor or a field right now: a reload would take the cursor (and maybe a word) away */
function busy(): boolean {
  const el = document.activeElement as HTMLElement | null;
  const inField = !!el && (el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');
  return inField && Date.now() - lastInput < IDLE_MS;
}

/** Runs `fn` now if that does not disturb the user, otherwise when the app goes to the background or the user stops typing */
function whenCalm(fn: () => void) {
  if (document.visibilityState === 'hidden' || Date.now() - startedAt < STARTUP_MS || !busy()) {
    fn();
    return;
  }
  pending = fn;
}

function runPending() {
  const fn = pending;
  if (fn && (document.visibilityState === 'hidden' || !busy())) {
    pending = null;
    fn();
  }
}

interface HealthInfo {
  version?: string;
  standalone?: boolean;
}

async function serverHealth(): Promise<HealthInfo | undefined> {
  try {
    const res = await fetch('/health', { cache: 'no-store' });
    if (!res.ok) return undefined;
    return (await res.json()) as HealthInfo;
  } catch {
    return undefined; // offline: keep the running version
  }
}

async function serverVersion(): Promise<string | undefined> {
  return (await serverHealth())?.version;
}

async function clearServiceWorkers() {
  const regs = (await navigator.serviceWorker?.getRegistrations()) ?? [];
  await Promise.all(regs.map((r) => r.unregister()));
  const keys = 'caches' in window ? await caches.keys() : [];
  await Promise.all(keys.filter((k) => k !== ATTACHMENT_CACHE).map((k) => caches.delete(k)));
}

async function hardReset(target: string) {
  // Only once per server version, so a broken deploy cannot loop the app through reloads
  try {
    if (sessionStorage.getItem(RESET_KEY) === target) return;
    sessionStorage.setItem(RESET_KEY, target);
  } catch {
    return;
  }
  await clearServiceWorkers();
  markUpdated();
  location.reload();
}

/** `known`: the version the event stream just reported, so no extra request is needed */
async function check(known?: string) {
  if (checking) return;
  checking = true;
  try {
    const version = known ?? (await serverVersion());
    if (!version || version === APP_VERSION) return;
    await registration?.update().catch(() => undefined);
    // A new worker reports itself through onNeedRefresh; if none came after a while, start clean
    setTimeout(() => whenCalm(() => void hardReset(version)), 8000);
  } finally {
    checking = false;
  }
}

export function keepUpToDate() {
  if (!('serviceWorker' in navigator)) return;
  void (async () => {
    const health = await serverHealth();
    if (health?.standalone) {
      // Desktop mode replaces kladde.exe directly: a Service Worker must never cache stale assets across updates
      await clearServiceWorkers().catch(() => undefined);
      return;
    }
    applyUpdate = registerSW({
      immediate: true,
      onRegisteredSW(_url, reg) {
        registration = reg;
        void check();
      },
      // A new version is installed and waiting: take it over (and reload) once that does not disturb
      onNeedRefresh() {
        whenCalm(() => {
          markUpdated();
          void applyUpdate?.(true);
        });
      },
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void check();
      else runPending();
    });
    document.addEventListener('focusout', () => setTimeout(runPending, 300));
    window.addEventListener('online', () => void check());
    window.addEventListener(SERVER_VERSION_EVENT, (e) => void check((e as CustomEvent<string>).detail));
    // Typing pauses: a waiting update runs once the user has not typed or clicked for IDLE_MS
    const touched = () => (lastInput = Date.now());
    for (const type of ['keydown', 'pointerdown', 'input', 'compositionupdate']) window.addEventListener(type, touched, { capture: true, passive: true });
    setInterval(() => {
      if (pending) runPending();
    }, 2000);
    setInterval(() => {
      if (document.visibilityState === 'visible') void check();
    }, CHECK_EVERY_MS);
  })();
}

/** True once after a reload for an update: the app then appears without entry animations */
export function justUpdated(): boolean {
  try {
    if (sessionStorage.getItem(UPDATED_KEY) !== '1') return false;
    sessionStorage.removeItem(UPDATED_KEY);
    return true;
  } catch {
    return false;
  }
}
