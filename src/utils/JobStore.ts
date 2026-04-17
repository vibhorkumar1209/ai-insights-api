/**
 * Generic in-memory job store with TTL (time-to-live) cleanup.
 * Can be reused across different async job types (industry report, financial analysis, etc.)
 */

export interface Job {
  jobId: string;
  status: string;
  createdAt: string;
  [key: string]: unknown;
}

export interface JobStoreConfig {
  ttlMs?: number; // How long to keep completed jobs (default: 2 hours)
  cleanupIntervalMs?: number; // How often to run cleanup (default: 30 minutes)
}

export class JobStore<T extends Job> {
  private jobs = new Map<string, T>();
  private abortedJobs = new Set<string>();
  private cleanupTimer: NodeJS.Timeout | null = null;
  private ttlMs: number;
  private cleanupIntervalMs: number;

  constructor(config: JobStoreConfig = {}) {
    this.ttlMs = config.ttlMs || 2 * 60 * 60 * 1000; // 2 hours default
    this.cleanupIntervalMs = config.cleanupIntervalMs || 30 * 60 * 1000; // 30 minutes default

    // Start TTL cleanup
    this.startCleanup();
  }

  /**
   * Create a new job entry
   */
  create(jobId: string, initial: Omit<T, 'jobId' | 'createdAt'>): T {
    const job: T = {
      jobId,
      createdAt: new Date().toISOString(),
      ...initial,
    } as T;

    this.jobs.set(jobId, job);
    return job;
  }

  /**
   * Get a job by ID
   */
  get(jobId: string): T | undefined {
    return this.jobs.get(jobId);
  }

  /**
   * Update a job with partial data
   */
  update(jobId: string, updates: Partial<T>): T | undefined {
    const existing = this.jobs.get(jobId);
    if (!existing) return undefined;

    const updated: T = { ...existing, ...updates } as T;
    this.jobs.set(jobId, updated);
    return updated;
  }

  /**
   * Mark a job as aborted (cannot be aborted again if terminal)
   */
  abort(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job) return false;

    const status = String(job.status);
    if (status === 'complete' || status === 'error') return false;

    this.abortedJobs.add(jobId);
    return true;
  }

  /**
   * Check if a job is marked for abortion
   */
  isAborted(jobId: string): boolean {
    return this.abortedJobs.has(jobId);
  }

  /**
   * Clear abortion flag (e.g., after handling the abort)
   */
  clearAbort(jobId: string): void {
    this.abortedJobs.delete(jobId);
  }

  /**
   * Delete a job
   */
  delete(jobId: string): boolean {
    this.abortedJobs.delete(jobId);
    return this.jobs.delete(jobId);
  }

  /**
   * Get all jobs
   */
  getAll(): T[] {
    return Array.from(this.jobs.values());
  }

  /**
   * Start automatic TTL cleanup
   */
  private startCleanup(): void {
    this.cleanupTimer = setInterval(() => {
      const cutoff = Date.now() - this.ttlMs;
      for (const [id, job] of this.jobs.entries()) {
        const createdTime = new Date(job.createdAt).getTime();
        if (createdTime < cutoff) {
          this.delete(id);
        }
      }
    }, this.cleanupIntervalMs);

    // Don't keep process alive just for cleanup
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }
  }

  /**
   * Stop cleanup (for testing or graceful shutdown)
   */
  stopCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /**
   * Clear all jobs
   */
  clear(): void {
    this.jobs.clear();
    this.abortedJobs.clear();
  }
}
