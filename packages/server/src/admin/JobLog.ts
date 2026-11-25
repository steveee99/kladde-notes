import type { AdminJob } from '@kladde/shared';

/** Jobs kept for the admin dashboard */
const KEEP = 50;

/**
 * The server's recent jobs for the admin dashboard: device syncs that sent changes and the background jobs (backups,
 * trash purge). Kept in memory only, so the list starts empty after a restart; it holds no note names or contents.
 */
export class JobLog {
  private readonly jobs: AdminJob[] = [];

  add(job: AdminJob): void {
    this.jobs.unshift(job);
    if (this.jobs.length > KEEP) this.jobs.length = KEEP;
  }

  list(limit = 20): AdminJob[] {
    return this.jobs.slice(0, limit);
  }
}
