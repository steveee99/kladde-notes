import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';

// The desktop build (#standalone): finding a browser, probing a running instance and
// shutting the local server down once the app window is closed

const spawned: { command: string; args: string[]; child: FakeChild }[] = [];
class FakeChild extends EventEmitter {
  unref = vi.fn();
}
vi.mock('child_process', () => ({
  spawn: (command: string, args: string[]) => {
    const child = new FakeChild();
    spawned.push({ command, args, child });
    return child;
  },
}));

const { findAppBrowser, launchDesktopWindow, probeRunningKladde, startDesktopLifecycle } = await import('../src/desktop');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kladde-desktop-test-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
beforeEach(() => void (spawned.length = 0));

describe('findAppBrowser', () => {
  it('takes KLADDE_BROWSER_PATH when it exists and tells Chrome from Edge', () => {
    const exists = (p: string) => p.startsWith('/opt/');
    expect(findAppBrowser({ env: { KLADDE_BROWSER_PATH: ' /opt/google-chrome ' }, platform: 'linux', existsSync: exists })).toEqual({ kind: 'chrome', executable: '/opt/google-chrome' });
    expect(findAppBrowser({ env: { KLADDE_BROWSER_PATH: '/opt/msedge' }, platform: 'linux', existsSync: exists })).toEqual({ kind: 'edge', executable: '/opt/msedge' });
    // A path that does not exist falls back to the usual places
    expect(findAppBrowser({ env: { KLADDE_BROWSER_PATH: '/nirgends/chrome' }, platform: 'linux', existsSync: (p) => p === '/usr/bin/chromium' })).toEqual({
      kind: 'chrome',
      executable: '/usr/bin/chromium',
    });
  });

  it('looks in the app folders on macOS and prefers Edge', () => {
    const both = findAppBrowser({ env: {}, platform: 'darwin', existsSync: () => true });
    expect(both?.kind).toBe('edge');
    const chrome = findAppBrowser({ env: {}, platform: 'darwin', existsSync: (p) => p.includes('Google Chrome') });
    expect(chrome?.executable).toBe('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  });

  it('finds Edge in the user profile on Windows', () => {
    const local = 'C:\\Users\\anna\\AppData\\Local';
    const found = findAppBrowser({ env: { LOCALAPPDATA: local }, platform: 'win32', existsSync: (p) => p.startsWith(local) });
    expect(found).toEqual({ kind: 'edge', executable: `${local}\\Microsoft\\Edge\\Application\\msedge.exe` });
  });
});

describe('probeRunningKladde', () => {
  let server: Server;
  let port = 0;
  let health: { status: number; body: unknown } = { status: 200, body: { ok: true, standalone: true, version: '2.24.0' } };

  beforeEach(async () => {
    const app = express();
    app.get('/health', (_req, res) => void res.status(health.status).json(health.body));
    server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    port = (server.address() as AddressInfo).port;
  });
  afterEach(() => server.close());

  it('reports a running instance', async () => {
    expect(await probeRunningKladde(port)).toEqual({ ok: true, standalone: true, version: '2.24.0' });
  });

  it('ignores errors, other answers, closed and invalid ports', async () => {
    health = { status: 500, body: { ok: true } };
    expect(await probeRunningKladde(port)).toBeNull();
    health = { status: 200, body: { ok: false } };
    expect(await probeRunningKladde(port)).toBeNull();
    expect(await probeRunningKladde(0)).toBeNull();
    server.close();
    expect(await probeRunningKladde(port, 300)).toBeNull();
  });
});

describe('launchDesktopWindow', () => {
  it('opens an isolated app window in Edge or Chrome', () => {
    const result = launchDesktopWindow('http://127.0.0.1:4000', tmp, { platform: 'linux', env: {}, existsSync: (p) => p === '/usr/bin/google-chrome', detached: true });
    expect(result.method).toBe('chrome-app');
    const [{ command, args, child }] = spawned;
    expect(command).toBe('/usr/bin/google-chrome');
    expect(args).toContain('--app=http://127.0.0.1:4000');
    expect(args).toContain(`--user-data-dir=${path.join(tmp, 'browser')}`);
    expect(fs.statSync(path.join(tmp, 'browser')).isDirectory()).toBe(true);
    expect(child.unref).toHaveBeenCalled();
  });

  it('falls back to the system browser', () => {
    const none = () => false;
    expect(launchDesktopWindow('http://x', tmp, { platform: 'linux', env: {}, existsSync: none })).toEqual({ child: null, method: 'system-default' });
    launchDesktopWindow('http://x', tmp, { platform: 'darwin', env: {}, existsSync: none });
    launchDesktopWindow('http://x', tmp, { platform: 'win32', env: {}, existsSync: none });
    expect(spawned.map((s) => s.command)).toEqual(['xdg-open', 'open', 'cmd.exe']);
  });
});

describe('startDesktopLifecycle', () => {
  const fakeLive = () => {
    const listeners: (() => void)[] = [];
    const live = { connections: 0, onChange: (fn: () => void) => listeners.push(fn) };
    const set = (n: number) => {
      live.connections = n;
      listeners.forEach((fn) => fn());
    };
    return { live, set };
  };
  // KLADDE_BROWSER_PATH works on every platform, so the tests do not depend on where they run
  const browserOn = (on: boolean) => {
    vi.stubEnv('KLADDE_BROWSER_PATH', '/opt/msedge');
    vi.spyOn(fs, 'existsSync').mockImplementation((p) => on && String(p) === '/opt/msedge');
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('shuts down after the app window closes, not while it is open', () => {
    browserOn(true);
    const { live, set } = fakeLive();
    const onShutdown = vi.fn();
    startDesktopLifecycle({ url: 'http://x', dataDir: tmp, live: live as never, onShutdown, idleGraceMs: 1000, startupGraceMs: 5000 });
    const { child } = spawned[0];
    set(1);
    vi.advanceTimersByTime(3000);
    // The page went away while the window lives (a reload): nothing happens
    set(0);
    vi.advanceTimersByTime(10_000);
    expect(onShutdown).not.toHaveBeenCalled();
    // The window closed after a while: shut down soon
    vi.advanceTimersByTime(5000);
    child.emit('exit');
    vi.advanceTimersByTime(1499);
    expect(onShutdown).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onShutdown).toHaveBeenCalledOnce();
  });

  it('waits for the page when the browser hands off to a running window right away', () => {
    browserOn(true);
    const { live, set } = fakeLive();
    const onShutdown = vi.fn();
    startDesktopLifecycle({ url: 'http://x', dataDir: tmp, live: live as never, onShutdown, idleGraceMs: 1000, startupGraceMs: 5000 });
    spawned[0].child.emit('exit');
    vi.advanceTimersByTime(2000);
    // The page connects in the handed-off window and later closes
    set(1);
    vi.advanceTimersByTime(10_000);
    expect(onShutdown).not.toHaveBeenCalled();
    set(0);
    vi.advanceTimersByTime(999);
    expect(onShutdown).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onShutdown).toHaveBeenCalledOnce();
  });

  it('handles a browser that fails to start', () => {
    browserOn(true);
    const { live, set } = fakeLive();
    const onShutdown = vi.fn();
    startDesktopLifecycle({ url: 'http://x', dataDir: tmp, live: live as never, onShutdown, idleGraceMs: 1000 });
    set(1);
    set(0);
    spawned[0].child.emit('error', new Error('ENOENT'));
    vi.advanceTimersByTime(1000);
    expect(onShutdown).toHaveBeenCalled();
  });

  it('with the system browser: stops when no page ever connects, or when the page closes', () => {
    browserOn(false);
    const never = fakeLive();
    const stopNever = vi.fn();
    startDesktopLifecycle({ url: 'http://x', dataDir: tmp, live: never.live as never, onShutdown: stopNever, startupGraceMs: 5000 });
    vi.advanceTimersByTime(5000);
    expect(stopNever).toHaveBeenCalledOnce();

    const used = fakeLive();
    const stopUsed = vi.fn();
    startDesktopLifecycle({ url: 'http://x', dataDir: tmp, live: used.live as never, onShutdown: stopUsed, idleGraceMs: 1000, startupGraceMs: 5000 });
    used.set(1);
    vi.advanceTimersByTime(6000);
    expect(stopUsed).not.toHaveBeenCalled();
    used.set(0);
    // A reload reconnects within the grace time
    vi.advanceTimersByTime(500);
    used.set(1);
    vi.advanceTimersByTime(2000);
    expect(stopUsed).not.toHaveBeenCalled();
    used.set(0);
    vi.advanceTimersByTime(1000);
    expect(stopUsed).toHaveBeenCalledOnce();
  });
});
