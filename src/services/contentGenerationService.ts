import { v4 as uuidv4 } from 'uuid';
import { ContentGenerationInput, ContentGenerationResult } from '@ai-insights/types';
import { synthesizeContent } from './claudeAI';

// In-memory job store
const jobs = new Map<string, ContentGenerationResult>();

// Subscription management for SSE
const subscribers = new Map<string, Set<(event: string, data: unknown) => void>>();

// ── Job Management ────────────────────────────────────────────────────────────

export function createContentGenerationJob(): string {
  const jobId = uuidv4();
  jobs.set(jobId, {
    jobId,
    status: 'pending',
    progress: 0,
    createdAt: new Date().toISOString(),
  });
  return jobId;
}

export function getContentGenerationJob(jobId: string): ContentGenerationResult | undefined {
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
        console.error('[contentGenerationService] Subscriber error:', err);
      }
    });
  }
}

function updateJob(jobId: string, updates: Partial<ContentGenerationResult>): void {
  const job = jobs.get(jobId);
  if (job) {
    jobs.set(jobId, { ...job, ...updates });
  }
}

// ── Main Flow ─────────────────────────────────────────────────────────────────

export async function runContentGeneration(
  jobId: string,
  input: ContentGenerationInput
): Promise<void> {
  const job = jobs.get(jobId);
  if (!job) return;

  try {
    updateJob(jobId, {
      status: 'generating',
      progress: 10,
      currentStep: 'Crafting your content…',
    });
    emit(jobId, 'progress', jobs.get(jobId));

    const result = await synthesizeContent(input);

    updateJob(jobId, {
      status: 'complete',
      progress: 100,
      title: result.title,
      content: result.content,
      hashtags: result.hashtags,
      completedAt: new Date().toISOString(),
    });

    emit(jobId, 'result', jobs.get(jobId));
  } catch (error) {
    console.error('[contentGenerationService] Error:', error);
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
