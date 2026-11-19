import crypto from 'crypto';
import fs from 'fs';
import express from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { APP_VERSION } from '@kladde/shared';
import { pushOutcomes } from './push/webpush.js';

/**
 * Prometheus metrics (#92): off unless `METRICS_TOKEN` (bearer token on `/metrics`) or `METRICS_PORT`
 * (a separate listener for an internal network) is set. Labels only carry fixed values (route groups,
 * methods, status classes), never user names, note ids or paths.
 */

const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

/** Fixed route groups: anything else is counted as `other`, so a crafted path cannot add labels */
const API_GROUPS = new Set([
  'sync',
  'events',
  'files',
  'auth',
  'admin',
  'trash',
  'notes',
  'search',
  'import',
  'shortcuts',
  'calendar',
  'push',
  'mcp',
  'groups',
  'comments',
  'notifications',
  'activity',
  'presence',
  'me',
  'export',
  'confluence',
  'share',
  'public',
]);

export function routeGroup(path: string): string {
  if (path === '/mcp' || path.startsWith('/mcp/')) return 'mcp';
  if (path.startsWith('/oauth') || path.startsWith('/.well-known')) return 'oauth';
  if (path === '/health') return 'health';
  if (path === '/metrics') return 'metrics';
  const m = /^\/api\/([a-z-]+)/.exec(path);
  if (m) return API_GROUPS.has(m[1]) ? `api_${m[1].replace(/-/g, '_')}` : 'api_other';
  return 'static';
}

const statusClass = (status: number) => `${Math.floor(status / 100)}xx`;

class Histogram {
  readonly counts = new Map<string, { buckets: number[]; sum: number; count: number }>();
  observe(label: string, seconds: number): void {
    let h = this.counts.get(label);
    if (!h) this.counts.set(label, (h = { buckets: DURATION_BUCKETS.map(() => 0), sum: 0, count: 0 }));
    DURATION_BUCKETS.forEach((b, i) => {
      if (seconds <= b) h!.buckets[i]++;
    });
    h.sum += seconds;
    h.count++;
  }
}

/** Counters filled by the app while it runs; one per process */
export class Metrics {
  readonly requests = new Map<string, number>();
  readonly durations = new Histogram();
  syncPushes = 0;
  syncPulls = 0;
  syncChanges = 0;
  transcriptionsRunning = 0;
  transcriptions = { ok: 0, failed: 0 };

  countRequest(method: string, group: string, status: number, seconds: number): void {
    const m = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(method) ? method : 'OTHER';
    const key = `${m}\u0000${group}\u0000${statusClass(status)}`;
    this.requests.set(key, (this.requests.get(key) ?? 0) + 1);
    this.durations.observe(group, seconds);
  }

  /** Express middleware timing every request */
  middleware(): express.RequestHandler {
    return (req, res, next) => {
      const start = process.hrtime.bigint();
      // Routers strip their mount path from req.path: keep the full one
      const path = req.path;
      res.on('finish', () => {
        const group = routeGroup(path);
        if (path === '/api/sync' && res.statusCode < 400) {
          if (req.method === 'GET') this.syncPulls++;
          else if (req.method === 'POST') {
            this.syncPushes++;
            const changes = (req.body as { changes?: unknown } | undefined)?.changes;
            if (Array.isArray(changes)) this.syncChanges += Math.min(changes.length, 500);
          }
        }
        // Server-sent events stay open for hours: their duration says nothing
        if (group === 'api_events') return void this.countRequest(req.method, group, res.statusCode, 0);
        this.countRequest(req.method, group, res.statusCode, Number(process.hrtime.bigint() - start) / 1e9);
      });
      next();
    };
  }
}

/** Gauges read when Prometheus scrapes */
export interface MetricsSources {
  metrics: Metrics;
  db: DatabaseSync;
  dbPath: string | null;
  startedAt: number;
  sseConnections: () => number;
  attachmentQueue: () => number;
  ocr: boolean;
  transcription: boolean;
  lastBackupAt: () => number | null;
}

function fileSize(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

const esc = (v: string) => v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');

/** The metrics in the Prometheus text format (version 0.0.4) */
export function renderMetrics(src: MetricsSources, now = Date.now()): string {
  const out: string[] = [];
  const metric = (name: string, type: 'counter' | 'gauge' | 'histogram', help: string, rows: [Record<string, string>, number][]) => {
    out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    for (const [labels, value] of rows) {
      const l = Object.entries(labels)
        .map(([k, v]) => `${k}="${esc(v)}"`)
        .join(',');
      out.push(`${name}${l ? `{${l}}` : ''} ${Number.isFinite(value) ? value : 0}`);
    }
  };
  const { metrics: m, db } = src;
  const one = (sql: string) => Number((db.prepare(sql).get() as { n: number | null } | undefined)?.n ?? 0);

  metric('kladde_info', 'gauge', 'Version of the running Kladde server.', [[{ version: APP_VERSION }, 1]]);
  metric('kladde_start_time_seconds', 'gauge', 'Start time of the server process (Unix seconds).', [[{}, Math.floor(src.startedAt / 1000)]]);
  metric('kladde_uptime_seconds', 'gauge', 'Seconds since the server started.', [[{}, Math.floor((now - src.startedAt) / 1000)]]);

  metric(
    'kladde_http_requests_total',
    'counter',
    'HTTP requests by method, route group and status class.',
    [...m.requests].map(([key, n]) => {
      const [method, route, status] = key.split('\u0000');
      return [{ method, route, status }, n];
    })
  );
  out.push('# HELP kladde_http_request_duration_seconds Duration of HTTP requests by route group.', '# TYPE kladde_http_request_duration_seconds histogram');
  for (const [route, h] of m.durations.counts) {
    DURATION_BUCKETS.forEach((b, i) => out.push(`kladde_http_request_duration_seconds_bucket{route="${esc(route)}",le="${b}"} ${h.buckets[i]}`));
    out.push(`kladde_http_request_duration_seconds_bucket{route="${esc(route)}",le="+Inf"} ${h.count}`);
    out.push(`kladde_http_request_duration_seconds_sum{route="${esc(route)}"} ${h.sum}`);
    out.push(`kladde_http_request_duration_seconds_count{route="${esc(route)}"} ${h.count}`);
  }

  metric('kladde_sync_pushes_total', 'counter', 'Sync pushes (uploads of changed notes) from the apps.', [[{}, m.syncPushes]]);
  metric('kladde_sync_pulls_total', 'counter', 'Sync pulls (downloads of changes) from the apps.', [[{}, m.syncPulls]]);
  metric('kladde_sync_changes_total', 'counter', 'Note changes received through sync pushes.', [[{}, m.syncChanges]]);
  metric('kladde_sse_connections', 'gauge', 'Open live-update (server-sent events) connections.', [[{}, src.sseConnections()]]);
  metric(
    'kladde_push_notifications_total',
    'counter',
    'Web Push messages by outcome.',
    (['sent', 'gone', 'failed'] as const).map((o) => [{ outcome: o }, pushOutcomes[o]])
  );
  metric('kladde_attachment_index_queue', 'gauge', `Attachments waiting for text extraction${src.ocr ? ' (with OCR)' : ''}.`, [[{}, src.attachmentQueue()]]);
  if (src.transcription) {
    metric('kladde_transcriptions_running', 'gauge', 'Voice note transcriptions in progress.', [[{}, m.transcriptionsRunning]]);
    metric('kladde_transcriptions_total', 'counter', 'Finished voice note transcriptions by outcome.', [
      [{ outcome: 'ok' }, m.transcriptions.ok],
      [{ outcome: 'failed' }, m.transcriptions.failed],
    ]);
  }

  metric('kladde_users', 'gauge', 'Accounts (without groups).', [[{}, one('SELECT COUNT(*) AS n FROM users WHERE is_group = 0')]]);
  metric('kladde_notes', 'gauge', 'Notes that are not deleted.', [[{}, one('SELECT COUNT(*) AS n FROM notes WHERE deleted = 0')]]);
  metric('kladde_attachments', 'gauge', 'Stored attachments.', [[{}, one('SELECT COUNT(*) AS n FROM files')]]);
  metric('kladde_attachments_bytes', 'gauge', 'Size of the stored attachments in bytes.', [[{}, one('SELECT SUM(size) AS n FROM files')]]);
  if (src.dbPath) {
    const size = fileSize(src.dbPath) + fileSize(`${src.dbPath}-wal`) + fileSize(`${src.dbPath}-shm`);
    metric('kladde_database_bytes', 'gauge', 'Size of the database files (with WAL) in bytes.', [[{}, size]]);
  }
  const lastBackup = src.lastBackupAt();
  if (lastBackup !== null) metric('kladde_last_backup_timestamp_seconds', 'gauge', 'Time of the newest backup (Unix seconds).', [[{}, Math.floor(lastBackup / 1000)]]);
  return `${out.join('\n')}\n`;
}

/** `METRICS_TOKEN`: the bearer token for `/metrics` on the app's port; too short is refused (no metrics) */
export function metricsTokenFromEnv(env: NodeJS.ProcessEnv): string | null {
  const token = env.METRICS_TOKEN?.trim();
  if (!token) return null;
  if (token.length < 16) {
    console.warn('METRICS_TOKEN ist kürzer als 16 Zeichen, /metrics bleibt aus.');
    return null;
  }
  return token;
}

/** `METRICS_PORT` (and `METRICS_HOST`, default 127.0.0.1): a separate listener without a token */
export function metricsListenFromEnv(env: NodeJS.ProcessEnv): { port: number; host: string } | null {
  const raw = env.METRICS_PORT?.trim();
  if (!raw) return null;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.warn(`METRICS_PORT „${raw}“ ist kein gültiger Port, /metrics bleibt aus.`);
    return null;
  }
  return { port, host: env.METRICS_HOST?.trim() || '127.0.0.1' };
}

const sameSecret = (a: string, b: string) => {
  const x = crypto.createHash('sha256').update(a).digest();
  const y = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(x, y);
};

/** The `/metrics` handler; with a token only for `Authorization: Bearer <token>` */
export function metricsHandler(src: MetricsSources, token: string | null): express.RequestHandler {
  return (req, res) => {
    if (token !== null) {
      const header = String(req.headers.authorization ?? '');
      const given = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
      if (!given || !sameSecret(given, token)) {
        res.setHeader('WWW-Authenticate', 'Bearer realm="kladde-metrics"');
        res.status(401).type('text/plain').send('Unauthorized\n');
        return;
      }
    }
    res.setHeader('Cache-Control', 'no-store');
    res.type('text/plain; version=0.0.4; charset=utf-8').send(renderMetrics(src));
  };
}

/** A minimal app for the internal metrics port */
export function metricsApp(src: MetricsSources): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.get('/metrics', metricsHandler(src, null));
  app.use((_req, res) => res.status(404).type('text/plain').send('Not found\n'));
  return app;
}
