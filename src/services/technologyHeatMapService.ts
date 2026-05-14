import { v4 as uuidv4 } from 'uuid';
import { TechHeatMapInput, TechHeatMapResult } from '@ai-insights/types';
import { synthesizeTechHeatMap } from './claudeAI';

// In-memory job store
const jobs = new Map<string, TechHeatMapResult>();

// Subscription management for SSE
const subscribers = new Map<string, Set<(event: string, data: unknown) => void>>();

// ── Job Management ────────────────────────────────────────────────────────────

export function createTechnologyHeatMapJob(): string {
  const jobId = uuidv4();
  jobs.set(jobId, {
    jobId,
    status: 'pending',
    progress: 0,
    createdAt: new Date().toISOString(),
  });
  return jobId;
}

export function getTechnologyHeatMapJob(jobId: string): TechHeatMapResult | undefined {
  return jobs.get(jobId);
}

export function subscribeToJob(
  jobId: string,
  callback: (event: string, data: unknown) => void
): void {
  if (!subscribers.has(jobId)) {
    subscribers.set(jobId, new Set());
  }
  subscribers.get(jobId)!.add(callback);
}

export function unsubscribeFromJob(
  jobId: string,
  callback: (event: string, data: unknown) => void
): void {
  const subs = subscribers.get(jobId);
  if (subs) {
    subs.delete(callback);
  }
}

function emit(jobId: string, event: string, data: unknown): void {
  const subs = subscribers.get(jobId);
  if (subs) {
    subs.forEach((cb) => {
      try {
        cb(event, data);
      } catch (err) {
        console.error('[technologyHeatMapService] Subscriber error:', err);
      }
    });
  }
}

function updateJob(jobId: string, updates: Partial<TechHeatMapResult>): void {
  const job = jobs.get(jobId);
  if (job) {
    jobs.set(jobId, { ...job, ...updates });
  }
}

// ── Main Flow ─────────────────────────────────────────────────────────────────

export async function runTechnologyHeatMap(jobId: string, input: TechHeatMapInput): Promise<void> {
  const job = jobs.get(jobId);
  if (!job) return;

  try {
    // Step 1: researching
    updateJob(jobId, {
      status: 'researching',
      progress: 10,
      currentStep: 'Analysing investment landscape...',
    });
    emit(jobId, 'progress', jobs.get(jobId));

    // Step 2: synthesize
    const result = await synthesizeTechHeatMap(input);

    // Step 3: complete
    updateJob(jobId, {
      status: 'complete',
      progress: 100,
      industry: input.industry,
      geography: input.geography,
      headline: result.headline,
      rows: result.rows,
      completedAt: new Date().toISOString(),
    });

    emit(jobId, 'result', jobs.get(jobId));
  } catch (error) {
    console.error('[technologyHeatMapService] Error:', error);
    updateJob(jobId, {
      status: 'error',
      error: error instanceof Error ? error.message : 'Unknown error',
      completedAt: new Date().toISOString(),
    });
    emit(jobId, 'error', jobs.get(jobId));
  }
}

// ── Cleanup ───────────────────────────────────────────────────────────────────

setInterval(() => {
  if (jobs.size > 100) {
    const sortedJobs = Array.from(jobs.entries()).sort(
      (a, b) => new Date(b[1].createdAt).getTime() - new Date(a[1].createdAt).getTime()
    );
    sortedJobs.slice(100).forEach(([id]) => {
      jobs.delete(id);
      subscribers.delete(id);
    });
  }
}, 60 * 60 * 1000);
