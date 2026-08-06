import { v4 as uuidv4 } from 'uuid';
import { ItJobInput, ItJobResult } from '@ai-insights/types';
import { extractItJobDetails } from './claudeAI';

// ── In-memory job store ────────────────────────────────────────────────────────

const jobs = new Map<string, ItJobResult>();

setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [id, job] of jobs.entries()) {
    if (new Date(job.createdAt).getTime() < cutoff) jobs.delete(id);
  }
}, 30 * 60 * 1000);

// ── SSE subscriber registry ────────────────────────────────────────────────────

type SSECallback = (event: string, data: unknown) => void;
const subscribers = new Map<string, SSECallback[]>();

export function subscribeToJob(jobId: string, cb: SSECallback): void {
  const list = subscribers.get(jobId) || [];
  list.push(cb);
  subscribers.set(jobId, list);
}

export function unsubscribeFromJob(jobId: string, cb: SSECallback): void {
  const list = (subscribers.get(jobId) || []).filter((c) => c !== cb);
  if (list.length > 0) subscribers.set(jobId, list);
  else subscribers.delete(jobId);
}

function emit(jobId: string, event: string, data: unknown): void {
  (subscribers.get(jobId) || []).forEach((cb) => cb(event, data));
}

function update(jobId: string, patch: Partial<ItJobResult>): ItJobResult {
  const current = jobs.get(jobId)!;
  const updated = { ...current, ...patch };
  jobs.set(jobId, updated);
  return updated;
}

// ── Public API ─────────────────────────────────────────────────────────────────

export function createItJobJob(input: ItJobInput): string {
  const jobId = uuidv4();
  jobs.set(jobId, {
    jobId,
    status: 'pending',
    progress: 0,
    jobTitleInput: input.jobTitle,
    jobDescriptionInput: input.jobDescription,
    createdAt: new Date().toISOString(),
  });
  return jobId;
}

export function getItJobJob(jobId: string): ItJobResult | undefined {
  return jobs.get(jobId);
}

// ── Main runner ──────────────────────────────────────────────────────────────
// A single fast, deterministic extraction call — no research/grounding needed
// since the input job posting IS the source data, not something to look up.

export async function runItJobExtraction(jobId: string, input: ItJobInput): Promise<void> {
  try {
    let job = update(jobId, {
      status: 'processing',
      progress: 30,
      currentStep: 'Extracting structured job details…',
    });
    emit(jobId, 'progress', job);

    const extraction = await extractItJobDetails(input);

    job = update(jobId, {
      status: 'complete',
      progress: 100,
      currentStep: 'Complete',
      extraction,
      completedAt: new Date().toISOString(),
    });
    emit(jobId, 'result', job);

  } catch (err) {
    const message = err instanceof Error ? err.message : 'IT Jobs extraction failed';
    console.error(`[itJob] job ${jobId} failed:`, message);
    const job = update(jobId, { status: 'error', error: message });
    emit(jobId, 'error', job);
  }
}
