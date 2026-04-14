import { v4 as uuidv4 } from 'uuid';
import { KeyBuyersInput, KeyBuyersResult } from '../types';
import { researchKeyBuyers } from './parallelAI';
import { synthesizeKeyBuyers } from './claudeAI';

// ── In-memory job store ───────────────────────────────────────────────────────

const jobs = new Map<string, KeyBuyersResult>();

const JOB_TTL_MS = 2 * 60 * 60 * 1000;
const cleanupTimer = setInterval(() => {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs.entries()) {
    if (new Date(job.createdAt).getTime() < cutoff) jobs.delete(id);
  }
}, 30 * 60 * 1000);
cleanupTimer.unref();

export function getKeyBuyersJob(jobId: string): KeyBuyersResult | undefined {
  return jobs.get(jobId);
}

export function createKeyBuyersJob(): string {
  const jobId = uuidv4();
  jobs.set(jobId, { jobId, status: 'pending', progress: 0, createdAt: new Date().toISOString() });
  return jobId;
}

function updateJob(jobId: string, update: Partial<KeyBuyersResult>) {
  const current = jobs.get(jobId);
  if (current) jobs.set(jobId, { ...current, ...update });
}

// ── SSE subscriber registry ───────────────────────────────────────────────────

type SSECallback = (event: string, data: unknown) => void;
const subscribers = new Map<string, SSECallback[]>();

export function subscribeToJob(jobId: string, cb: SSECallback) {
  subscribers.set(jobId, [...(subscribers.get(jobId) || []), cb]);
}

export function unsubscribeFromJob(jobId: string, cb: SSECallback) {
  subscribers.set(jobId, (subscribers.get(jobId) || []).filter((fn) => fn !== cb));
}

function emit(jobId: string, event: string, data: unknown) {
  (subscribers.get(jobId) || []).forEach((cb) => {
    try { cb(event, data); } catch { /* ignore closed connections */ }
  });
}

// ── Main runner ───────────────────────────────────────────────────────────────

export async function runKeyBuyers(
  jobId: string,
  input: KeyBuyersInput
): Promise<void> {
  const step = (msg: string, progress: number, status: KeyBuyersResult['status'] = 'researching') => {
    updateJob(jobId, { currentStep: msg, progress, status });
    emit(jobId, 'progress', { currentStep: msg, progress });
  };

  try {
    updateJob(jobId, { companyName: input.companyName });

    step(`Researching ${input.companyName}'s key executives and their public statements…`, 10);
    const research = await researchKeyBuyers(input.companyName, input.companyDomain);

    step('Synthesising executive insights into structured analysis…', 65, 'synthesizing');

    const rows = await synthesizeKeyBuyers(input, research);

    const completed: Partial<KeyBuyersResult> = {
      status: 'complete',
      progress: 100,
      currentStep: 'Complete',
      rows,
      completedAt: new Date().toISOString(),
    };

    updateJob(jobId, completed);
    emit(jobId, 'result', { ...jobs.get(jobId) });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Unknown error';
    console.error(`[keyBuyers] job ${jobId} failed:`, errorMsg);
    updateJob(jobId, { status: 'error', error: errorMsg, progress: 0 });
    emit(jobId, 'error', { error: errorMsg });
  }
}
