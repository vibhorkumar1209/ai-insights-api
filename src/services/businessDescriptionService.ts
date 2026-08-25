import { v4 as uuidv4 } from 'uuid';
import { BusinessDescriptionInput, BusinessDescriptionResult } from '@ai-insights/types';
import { researchCompanyOverview } from './parallelAI';
import { generateBusinessDescription } from './claudeAI';

// ── In-memory job store ───────────────────────────────────────────────────────
//
// Converts what used to be a single blocking POST (research call, up to ~90s,
// then a Claude call, up to ~120s — worst case ~5 minutes with a research
// retry) into the same async job + SSE pattern every other module uses.
// The synchronous version had no progress feedback and was one dropped
// connection away from silently losing the entire result — gateway/proxy
// timeouts on a multi-minute unary HTTP request are the "susceptible to
// failure" behaviour this was built to fix.

const jobs = new Map<string, BusinessDescriptionResult>();

const JOB_TTL_MS = 2 * 60 * 60 * 1000;
const cleanupTimer = setInterval(() => {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs.entries()) {
    if (new Date(job.createdAt).getTime() < cutoff) jobs.delete(id);
  }
}, 30 * 60 * 1000);
cleanupTimer.unref();

// ── Duplicate-submission dedupe ────────────────────────────────────────────
//
// This endpoint was observed being hit 200+ times for the exact same
// company within ~26 minutes on production (every few seconds at first,
// tapering as each run took longer) — whatever the caller (a stuck client
// retry loop, a misbehaving script, or repeated manual resubmission), every
// one of those was a wasted Claude + Parallel.AI call for an answer that
// was already in flight or already sitting in the job store. Rather than
// try to prove or police who/what is calling it, dedupe at the source: an
// identical companyName+domain request within DEDUPE_WINDOW_MS gets back
// the existing job instead of starting a new one.
const recentByKey = new Map<string, string>(); // normalized key → jobId
const DEDUPE_WINDOW_MS = 3 * 60 * 1000;

function dedupeKey(companyName: string, domain?: string): string {
  return `${companyName.trim().toLowerCase()}|${(domain || '').trim().toLowerCase()}`;
}

export function getBusinessDescriptionJob(jobId: string): BusinessDescriptionResult | undefined {
  return jobs.get(jobId);
}

/**
 * Returns an existing jobId if an identical (companyName+domain) request is
 * still pending/running/recently-completed, otherwise creates and returns a
 * new one. Callers should treat the returned jobId as "the job to poll" in
 * both cases — a 202 response with a pre-existing jobId behaves identically
 * to a fresh one from the client's perspective.
 */
export function createBusinessDescriptionJob(input: BusinessDescriptionInput): { jobId: string; isNew: boolean } {
  const key = dedupeKey(input.companyName, input.domain);
  const existingId = recentByKey.get(key);
  if (existingId) {
    const existing = jobs.get(existingId);
    if (existing && existing.status !== 'error') {
      console.log(`[businessDescription] Deduping repeat request for "${input.companyName}" — reusing job ${existingId}`);
      return { jobId: existingId, isNew: false };
    }
    recentByKey.delete(key);
  }

  const jobId = uuidv4();
  jobs.set(jobId, { jobId, status: 'pending', progress: 0, createdAt: new Date().toISOString() });
  recentByKey.set(key, jobId);
  setTimeout(() => {
    if (recentByKey.get(key) === jobId) recentByKey.delete(key);
  }, DEDUPE_WINDOW_MS).unref();
  return { jobId, isNew: true };
}

function updateJob(jobId: string, update: Partial<BusinessDescriptionResult>) {
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

export async function runBusinessDescription(
  jobId: string,
  input: BusinessDescriptionInput
): Promise<void> {
  const step = (msg: string, progress: number, status: BusinessDescriptionResult['status']) => {
    updateJob(jobId, { currentStep: msg, progress, status });
    emit(jobId, 'progress', { currentStep: msg, progress });
  };

  try {
    updateJob(jobId, { companyName: input.companyName, domain: input.domain });

    step(`Researching ${input.companyName}...`, 15, 'researching');
    let research = '';
    try {
      research = await researchCompanyOverview(input.companyName, input.domain);
    } catch (err) {
      console.warn('[businessDescription] Research failed, proceeding with training knowledge:', err);
    }

    step('Writing business description...', 65, 'synthesizing');
    const description = await generateBusinessDescription(input.companyName, input.domain, research);

    const completed: Partial<BusinessDescriptionResult> = {
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
    console.error(`[businessDescription] job ${jobId} failed:`, errorMsg);
    updateJob(jobId, { status: 'error', error: errorMsg, progress: 0 });
    emit(jobId, 'error', { error: errorMsg });
  }
}
