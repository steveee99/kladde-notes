import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import type { LiveUpdates } from './api.js';

export interface DesktopBrowser {
  kind: 'edge' | 'chrome';
  executable: string;
}

export interface FindBrowserOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  existsSync?: (target: string) => boolean;
  detached?: boolean;
}

/** Finds Microsoft Edge (preferred) or Google Chrome to host the standalone `--app` window */
export function findAppBrowser(opts: FindBrowserOptions = {}): DesktopBrowser | null {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const existsSync = opts.existsSync ?? fs.existsSync;

  const custom = env.KLADDE_BROWSER_PATH?.trim();
  if (custom && existsSync(custom)) {
    return { kind: /chrome/i.test(path.basename(custom)) ? 'chrome' : 'edge', executable: custom };
  }

  const candidates: DesktopBrowser[] = [];
  if (platform === 'win32') {
    const pf86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const pf = env.ProgramFiles || 'C:\\Program Files';
    const local = env.LOCALAPPDATA || '';
    const edgeDirs = [
      path.win32.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.win32.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      ...(local ? [path.win32.join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe')] : []),
    ];
    for (const executable of new Set(edgeDirs)) candidates.push({ kind: 'edge', executable });

    const chromeDirs = [
      path.win32.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.win32.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      ...(local ? [path.win32.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe')] : []),
    ];
    for (const executable of new Set(chromeDirs)) candidates.push({ kind: 'chrome', executable });
  } else if (platform === 'darwin') {
    candidates.push(
      { kind: 'edge', executable: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' },
      { kind: 'chrome', executable: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' }
    );
  } else {
    candidates.push(
      { kind: 'edge', executable: '/usr/bin/microsoft-edge' },
      { kind: 'edge', executable: '/usr/bin/microsoft-edge-stable' },
      { kind: 'chrome', executable: '/usr/bin/google-chrome' },
      { kind: 'chrome', executable: '/usr/bin/chromium' },
      { kind: 'chrome', executable: '/usr/bin/chromium-browser' }
    );
  }

  return candidates.find((c) => existsSync(c.executable)) ?? null;
}

export interface RunningInstanceInfo {
  ok: boolean;
  standalone?: boolean;
  version?: string;
}

/** Checks whether a Kladde standalone instance is already serving on `127.0.0.1:<port>` */
export async function probeRunningKladde(port: number, timeoutMs = 600): Promise<RunningInstanceInfo | null> {
  if (port <= 0) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: controller.signal });
    if (!res.ok) return null;
    const data = (await res.json()) as RunningInstanceInfo;
    return data?.ok ? data : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export interface LaunchBrowserResult {
  child: ChildProcess | null;
  method: 'edge-app' | 'chrome-app' | 'system-default';
}

/** Launches Kladde in a dedicated Edge/Chrome `--app` window (isolated `--user-data-dir` avoids merging into an open browser process) */
export function launchDesktopWindow(url: string, dataDir: string, opts: FindBrowserOptions = {}): LaunchBrowserResult {
  const platform = opts.platform ?? process.platform;
  const browser = findAppBrowser(opts);

  if (browser) {
    const browserDataDir = path.join(dataDir, 'browser');
    fs.mkdirSync(browserDataDir, { recursive: true, mode: 0o700 });
    const args = [
      `--app=${url}`,
      `--user-data-dir=${browserDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-mode',
      '--new-window',
    ];
    const detached = !!opts.detached;
    const child = spawn(browser.executable, args, {
      stdio: 'ignore',
      detached,
      windowsHide: false,
    });
    if (detached) child.unref();
    return { child, method: browser.kind === 'edge' ? 'edge-app' : 'chrome-app' };
  }

  // Fallback when neither Edge nor Chrome is installed: open in the OS default browser
  if (platform === 'win32') {
    spawn('cmd.exe', ['/c', 'start', '', url], { stdio: 'ignore', windowsHide: true, detached: true }).unref();
  } else if (platform === 'darwin') {
    spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
  } else {
    spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
  }
  return { child: null, method: 'system-default' };
}

export interface DesktopLifecycleOptions {
  url: string;
  dataDir: string;
  live: LiveUpdates;
  onShutdown: () => void;
  /** Grace time after opening a page before closing on 0 SSE connections */
  idleGraceMs?: number;
  /** Initial startup timeout if fallback browser never connects SSE */
  startupGraceMs?: number;
}

/**
 * Opens the Kladde app window and shuts the local server down cleanly once the window closes
 * (watched via Edge/Chrome child exit + `/api/events` SSE connection count).
 */
export function startDesktopLifecycle(opts: DesktopLifecycleOptions): void {
  const idleGraceMs = opts.idleGraceMs ?? 4_000;
  const startupGraceMs = opts.startupGraceMs ?? 30_000;
  const launchedAt = Date.now();
  let hadClient = opts.live.connections > 0;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let childAlive = false;

  const scheduleIdleShutdown = (delayMs: number) => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (opts.live.connections === 0) opts.onShutdown();
    }, delayMs);
    idleTimer.unref();
  };

  const cancelIdleShutdown = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };

  opts.live.onChange(() => {
    if (opts.live.connections > 0) {
      hadClient = true;
      cancelIdleShutdown();
    } else if (hadClient && !childAlive) {
      // Browser tab / fallback window closed (Wait 4s so F5 page reloads reconnect without shutting down)
      scheduleIdleShutdown(idleGraceMs);
    }
  });

  const { child, method } = launchDesktopWindow(opts.url, opts.dataDir);
  console.log(`🖥️  Desktop-Fenster gestartet (${method}): ${opts.url}`);

  if (child) {
    childAlive = true;
    child.on('error', (err) => {
      console.error('Browser-Start fehlgeschlagen:', err);
      childAlive = false;
      if (hadClient && opts.live.connections === 0) scheduleIdleShutdown(idleGraceMs);
    });
    child.once('exit', () => {
      childAlive = false;
      const elapsed = Date.now() - launchedAt;
      if (opts.live.connections === 0) {
        // If browser delegated cleanly to an existing window immediately (< 2.5s), give it time to connect SSE
        scheduleIdleShutdown(elapsed < 2500 ? startupGraceMs : 1500);
      }
    });
  } else {
    // Fallback OS browser: wait for first SSE connection, then shut down once closed (or if never opened)
    setTimeout(() => {
      if (!hadClient && opts.live.connections === 0) opts.onShutdown();
    }, startupGraceMs).unref();
  }
}
