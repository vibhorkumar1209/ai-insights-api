import { v4 as uuidv4 } from 'uuid';
import { ChallengesGrowthInput, ChallengesGrowthResult } from '../types';
import { researchCompanyChallengesGrowth } from './parallelAI';
import { synthesizeChallengesGrowth } from './claudeAI';

// ── In-memory job store ───────────────────────────────────────────────────────

const jobs = new Map<string, ChallengesGrowthResult>();

const JOB_TTL_MS = 2 * 60 * 60 * 1000;
const cleanupTimer = setInterval(() => {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs.entries()) {
    if (new Date(job.createdAt).getTime() < cutoff) jobs.delete(id);
  }
}, 30 * 60 * 1000);
cleanupTimer.unref();

export function getChallengesGrowthJob(jobId: string): ChallengesGrowthResult | undefined {
  return jobs.get(jobId);
}

export function createChallengesGrowthJob(): string {
  const jobId = uuidv4();
  jobs.set(jobId, { jobId, status: 'pending', progress: 0, createdAt: new Date().toISOString() });
  return jobId;
}

function updateJob(jobId: string, update: Partial<ChallengesGrowthResult>) {
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

export async function runChallengesGrowth(
  jobId: string,
  input: ChallengesGrowthInput
): Promise<void> {
  const step = (msg: string, progress: number) => {
    updateJob(jobId, { currentStep: msg, progress, status: 'researching' });
    emit(jobId, 'progress', { currentStep: msg, progress });
  };

  try {
    updateJob(jobId, { companyName: input.companyName });

    step(`Researching ${input.companyName}...`, 10);
    const companyLabel = `${input.companyName}${input.companyDomain ? ` (website: ${input.companyDomain})` : ''}`;
    const research = await researchCompanyChallengesGrowth(companyLabel);

    step('Synthesizing challenges & growth analysis...', 65);
    updateJob(jobId, { status: 'synthesizing' });
    emit(jobId, 'progress', { progress: 65, currentStep: 'Synthesizing challenges & growth analysis...' });

    const rows = await synthesizeChallengesGrowth(input, research);

    const completed: Partial<ChallengesGrowthResult> = {
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
    updateJob(jobId, { status: 'error', error: errorMsg, progress: 0 });
    emit(jobId, 'error', { error: errorMsg });
  }
}
