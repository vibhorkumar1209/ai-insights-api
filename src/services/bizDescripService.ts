import { v4 as uuidv4 } from 'uuid';
import { BizDescripInput, BizDescripResult } from '@ai-insights/types';
import { generateBizDescrip } from './claudeAI';

// ── In-memory job store ───────────────────────────────────────────────────────
//
// New, separate module from Business Description (blocked as of 2026-08-27 —
// see routes/businessDescription.ts) — not a re-enable of it. Claude-only:
// a single call, no Parallel.AI/Gemini research step, so this is fast (a
// single Claude round-trip) and has none of the multi-provider surface the
// blocked module had. Still uses the async job + SSE pattern every other
// module uses (rather than a blocking request) for consistency and because
// it costs nothing here — the single Claude call already completes in a few
// seconds.

const jobs = new Map<string, BizDescripResult>();

const JOB_TTL_MS = 2 * 60 * 60 * 1000;
const cleanupTimer = setInterval(() => {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs.entries()) {
    if (new Date(job.createdAt).getTime() < cutoff) jobs.delete(id);
  }
}, 30 * 60 * 1000);
cleanupTimer.unref();

export function getBizDescripJob(jobId: string): BizDescripResult | undefined {
  return jobs.get(jobId);
}

export function createBizDescripJob(): string {
  const jobId = uuidv4();
  jobs.set(jobId, { jobId, status: 'pending', progress: 0, createdAt: new Date().toISOString() });
  return jobId;
}

function updateJob(jobId: string, update: Partial<BizDescripResult>) {
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

export async function runBizDescrip(jobId: string, input: BizDescripInput): Promise<void> {
  try {
    updateJob(jobId, {
      companyName: input.companyName,
      companyDomain: input.companyDomain,
      linkedinUrl: input.linkedinUrl,
      status: 'synthesizing',
      progress: 30,
      currentStep: `Writing description for ${input.companyName}...`,
    });
    emit(jobId, 'progress', { progress: 30, currentStep: `Writing description for ${input.companyName}...` });

    const description = await generateBizDescrip(input.companyName, input.companyDomain, input.linkedinUrl);

    const completed: Partial<BizDescripResult> = {
      status: 'complete',
      progress: 100,
      currentStep: 'Complete',
      description,
      completedAt: new Date().toISOString(),
    };
    updateJob(jobId, completed);
    emit(jobId, 'result', { ...jobs.get(jobId) });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Description generation failed';
    console.error(`[bizDescrip] job ${jobId} failed:`, errorMsg);
    updateJob(jobId, { status: 'error', error: errorMsg, progress: 0 });
    emit(jobId, 'error', { error: errorMsg });
  }
}
