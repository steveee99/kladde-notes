import fs from 'fs';
import os from 'os';
import type { DatabaseSync } from 'node:sqlite';
import { APP_VERSION, type AdminOverview } from '@kladde/shared';
import { INVITE_MAX_AGE_MS } from '../UserStore.js';
import type { JobLog } from './JobLog.js';

export interface OverviewSources {
  db: DatabaseSync;
  dbPath: string | null;
  dataDir: string;
  startedAt: number;
  jobs: JobLog;
  /** Users with an open event stream, with the number of their devices */
  online: () => Map<string, number>;
  connections: () => number;
  /** Database notes; expensive, kept for a minute */
  databases: () => number;
  lastBackupAt: () => number | null;
}

/** How long the counts that read every note are kept */
const COUNT_TTL_MS = 60_000;

interface CpuSample {
  at: number;
  idle: number;
  total: number;
  process: number;
}

function sampleCpu(): CpuSample {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    const t = cpu.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  const usage = process.cpuUsage();
  return { at: Date.now(), idle, total, process: (usage.user + usage.system) / 1000 };
}

function fileSize(file: string | null): number {
  if (!file) return 0;
  let size = 0;
  // The WAL holds changes not yet written into the database file
  for (const f of [file, `${file}-wal`]) {
    try {
      size += fs.statSync(f).size;
    } catch {
      // not there
    }
  }
  return size;
}

/** Builds the admin dashboard; CPU use is measured between two looks (the first against the server start) */
export function overviewBuilder(src: OverviewSources): () => AdminOverview {
  let last = sampleCpu();
  let databases: { at: number; n: number } | null = null;
  const one = (sql: string, ...args: (string | number)[]) => Number((src.db.prepare(sql).get(...args) as { n: number | null } | undefined)?.n ?? 0);

  return () => {
    const now = Date.now();
    const cpu = sampleCpu();
    const elapsed = cpu.at - last.at;
    const total = cpu.total - last.total;
    const system = total > 0 ? Math.min(1, Math.max(0, 1 - (cpu.idle - last.idle) / total)) : null;
    const processShare = elapsed > 0 ? Math.max(0, (cpu.process - last.process) / elapsed) : null;
    last = cpu;

    if (!databases || now - databases.at > COUNT_TTL_MS) databases = { at: now, n: src.databases() };

    let disk: AdminOverview['system']['disk'] = null;
    try {
      const s = fs.statfsSync(src.dataDir);
      disk = { total: s.blocks * s.bsize, free: s.bavail * s.bsize };
    } catch {
      // no statfs (in-memory database, unusual file systems)
    }

    const names = new Map<string, { username: string; avatar_id: string | null }>();
    const online = [...src.online()].filter(([, n]) => n > 0);
    for (const [id] of online) {
      const row = src.db.prepare('SELECT username, avatar_id FROM users WHERE id = ?').get(id) as { username: string; avatar_id: string | null } | undefined;
      if (row) names.set(id, row);
    }
    const mem = process.memoryUsage();
    const cpus = os.cpus();
    const load = os.loadavg();

    return {
      version: APP_VERSION,
      startedAt: src.startedAt,
      counts: {
        users: one('SELECT COUNT(*) AS n FROM users WHERE is_group = 0'),
        groups: one('SELECT COUNT(*) AS n FROM users WHERE is_group = 1'),
        notes: one('SELECT COUNT(*) AS n FROM notes WHERE deleted = 0'),
        databases: databases.n,
        shares: one('SELECT COUNT(*) AS n FROM shares'),
        attachments: one('SELECT COUNT(*) AS n FROM files'),
        invites: one('SELECT COUNT(*) AS n FROM invites WHERE used_by IS NULL AND created_at > ?', now - INVITE_MAX_AGE_MS),
      },
      online: {
        connections: src.connections(),
        users: online
          .filter(([id]) => names.has(id))
          .map(([id, devices]) => {
            const u = names.get(id)!;
            return { username: u.username, avatarUrl: u.avatar_id ? `/api/avatars/${u.avatar_id}` : null, devices };
          })
          .sort((a, b) => a.username.localeCompare(b.username)),
      },
      system: {
        platform: `${os.type()} ${os.release()}`,
        node: process.version,
        cpu: { cores: cpus.length, model: cpus[0]?.model.trim() ?? '', load: [load[0], load[1], load[2]], system, process: processShare },
        memory: { total: os.totalmem(), free: os.freemem(), rss: mem.rss, heap: mem.heapUsed },
        disk,
        storage: {
          database: fileSize(src.dbPath),
          notes: one('SELECT SUM(LENGTH(payload)) AS n FROM notes WHERE deleted = 0'),
          attachments: one('SELECT SUM(size) AS n FROM files'),
          history: one('SELECT SUM(LENGTH(payload)) AS n FROM note_versions') + one('SELECT SUM(LENGTH(payload)) AS n FROM note_releases'),
          trash: one('SELECT SUM(LENGTH(payload)) AS n FROM trash'),
        },
      },
      lastBackupAt: src.lastBackupAt(),
      jobs: src.jobs.list(),
    };
  };
}
