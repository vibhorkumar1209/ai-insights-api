import { v4 as uuidv4 } from 'uuid';
import { SpendInput, SpendResult } from '@ai-insights/types';
import { geminiSpendLookup } from './parallelAI';

// ── In-memory job store ────────────────────────────────────────────────────────

const jobs = new Map<string, SpendResult>();

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

function update(jobId: string, patch: Partial<SpendResult>): SpendResult {
  const current = jobs.get(jobId)!;
  const updated = { ...current, ...patch };
  jobs.set(jobId, updated);
  return updated;
}

// ── Public API ─────────────────────────────────────────────────────────────────

export function createSpendJob(input: SpendInput): string {
  const jobId = uuidv4();
  jobs.set(jobId, {
    jobId,
    status: 'pending',
    progress: 0,
    companyName: input.companyName,
    companyDomain: input.companyDomain,
    geography: input.geography,
    createdAt: new Date().toISOString(),
  });
  return jobId;
}

export function getSpendJob(jobId: string): SpendResult | undefined {
  return jobs.get(jobId);
}

// ── Main runner ────────────────────────────────────────────────────────────────

export async function runSpendJob(jobId: string, input: SpendInput): Promise<void> {
  try {
    let job = update(jobId, {
      status: 'researching',
      progress: 25,
      currentStep: `Researching ${input.companyName}'s IT, R&D, and AI spend…`,
    });
    emit(jobId, 'progress', job);

    const result = await geminiSpendLookup(input.companyName, input.companyDomain, input.geography);

    if (!result) {
      job = update(jobId, {
        status: 'error',
        error: `Could not research spend data for ${input.companyName}.`,
      });
      emit(jobId, 'error', job);
      return;
    }

    job = update(jobId, {
      status: 'synthesizing',
      progress: 75,
      currentStep: 'Finalising spend breakdown…',
    });
    emit(jobId, 'progress', job);

    job = update(jobId, {
      status: 'complete',
      progress: 100,
      currentStep: 'Complete',
      completedAt: new Date().toISOString(),
      itSpend: result.itSpend,
      rdSpend: result.rdSpend,
      aiSpend: result.aiSpend,
    });
    emit(jobId, 'result', job);

  } catch (err) {
    const message = err instanceof Error ? err.message : 'Spend research failed';
    console.error(`[spend] job ${jobId} failed:`, message);
    const job = update(jobId, { status: 'error', error: message });
    emit(jobId, 'error', job);
  }
}
