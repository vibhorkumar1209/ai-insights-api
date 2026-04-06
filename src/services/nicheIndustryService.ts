import { v4 as uuidv4 } from 'uuid';
import { NicheIndustryInput, NicheIndustryResult } from '../types';
import { researchNicheIndustries } from './parallelAI';
import { synthesizeNicheTopics } from './claudeAI';

// ── In-memory job store ────────────────────────────────────────────────────────

const jobs = new Map<string, NicheIndustryResult>();
const JOB_TTL_MS = 2 * 60 * 60 * 1000;

setInterval(() => {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs.entries()) {
    if (new Date(job.createdAt).getTime() < cutoff) jobs.delete(id);
  }
}, 30 * 60 * 1000);

// ── SSE subscribers ────────────────────────────────────────────────────────────

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

function update(jobId: string, patch: Partial<NicheIndustryResult>): NicheIndustryResult {
  const current = jobs.get(jobId)!;
  const updated = { ...current, ...patch };
  jobs.set(jobId, updated);
  return updated;
}

// ── Public API ─────────────────────────────────────────────────────────────────

export function createNicheIndustryJob(): string {
  const jobId = uuidv4();
  jobs.set(jobId, {
    jobId,
    status: 'pending',
    progress: 0,
    createdAt: new Date().toISOString(),
  });
  return jobId;
}

export function getNicheIndustryJob(jobId: string): NicheIndustryResult | undefined {
  return jobs.get(jobId);
}

// ── Main orchestrator ──────────────────────────────────────────────────────────

export async function runNicheIndustryAnalysis(
  jobId: string,
  input: NicheIndustryInput
): Promise<void> {
  try {
    // Step 1: Research via Parallel.AI
    let job = update(jobId, {
      status: 'researching',
      progress: 15,
      currentStep: 'Researching niche industry topics via Parallel.AI…',
    });
    emit(jobId, 'progress', job);

    const research = await researchNicheIndustries(input);

    // Step 2: Synthesize via Claude
    job = update(jobId, {
      status: 'synthesizing',
      progress: 60,
      currentStep: 'Synthesizing niche topic recommendations…',
    });
    emit(jobId, 'progress', job);

    const topics = await synthesizeNicheTopics(input, research);

    // Done
    job = update(jobId, {
      status: 'complete',
      progress: 100,
      currentStep: 'Complete',
      topics,
      completedAt: new Date().toISOString(),
    });
    emit(jobId, 'result', job);

  } catch (err) {
    const message = err instanceof Error ? err.message : 'Analysis failed';
    console.error(`[nicheIndustry] job ${jobId} failed:`, message);
    const job = update(jobId, { status: 'error', error: message });
    emit(jobId, 'error', job);
  }
}
