import { APP_VERSION } from '@kladde/shared';
import { registerSW } from 'virtual:pwa-register';

/**
 * Every deploy is applied right away. The service worker alone is not enough: the browser only looks
 * for a new one on a navigation, and an iOS home-screen app often resumes from the background without
 * one, so an old version could stay for days. So whenever the app starts, comes back to the foreground
 * or goes online again it asks the server for its version; if that differs it updates the service
 * worker (autoUpdate reloads the page once the new one takes over), and if that does not happen soon
 * it drops the service worker and its caches and reloads from the network.
 * Notes live in IndexedDB, not in these caches, so nothing is lost.
 */
const RESET_KEY = 'kladde_update_reset';
const ATTACHMENT_CACHE = 'kladde-files';

let registration: ServiceWorkerRegistration | undefined;
let checking = false;

async function serverVersion(): Promise<string | undefined> {
  try {
    const res = await fetch('/health', { cache: 'no-store' });
    if (!res.ok) return undefined;
    return ((await res.json()) as { version?: string }).version;
  } catch {
    return undefined; // offline: keep the running version
  }
}

async function hardReset(target: string) {
  // Only once per server version, so a broken deploy cannot loop the app through reloads
  try {
    if (sessionStorage.getItem(RESET_KEY) === target) return;
    sessionStorage.setItem(RESET_KEY, target);
  } catch {
    return;
  }
  const regs = (await navigator.serviceWorker?.getRegistrations()) ?? [];
  await Promise.all(regs.map((r) => r.unregister()));
  const keys = 'caches' in window ? await caches.keys() : [];
  await Promise.all(keys.filter((k) => k !== ATTACHMENT_CACHE).map((k) => caches.delete(k)));
  location.reload();
}

async function check() {
  if (checking) return;
  checking = true;
  try {
    const version = await serverVersion();
    if (!version || version === APP_VERSION) return;
    await registration?.update().catch(() => undefined);
    // autoUpdate reloads the page when the new worker takes over; if it has not after a while, force it
    setTimeout(() => void hardReset(version), 8000);
  } finally {
    checking = false;
  }
}

export function keepUpToDate() {
  if (!('serviceWorker' in navigator)) return;
  registerSW({
    immediate: true,
    onRegisteredSW(_url, reg) {
      registration = reg;
      void check();
    },
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void check();
  });
  window.addEventListener('online', () => void check());
}
