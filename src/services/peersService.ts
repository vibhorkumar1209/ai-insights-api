import { v4 as uuidv4 } from 'uuid';
import { PeersInput, PeersResult } from '@ai-insights/types';
import { researchCompanyOverview } from './parallelAI';
import { discoverCompetitorsFast } from './claudeAI';

// ── In-memory job store ───────────────────────────────────────────────────────
//
// Converts what used to be a single blocking POST (research call, up to ~90s,
// then a full business-description Claude call used only as a disambiguation
// signal, up to ~120s, then the competitors Claude call, up to ~120s — worst
// case 5+ minutes with no progress feedback and no retry on a dropped
// connection) into the same async job + SSE pattern every other module uses.
// Also drops the intermediate business-description call entirely:
// discoverCompetitorsFast (claudeAI.ts) already anchors identity strongly
// using the domain + raw research text directly when no verifiedDescription
// is supplied, so that whole extra sequential Claude round-trip was adding
// real latency without a proportional accuracy benefit.

const jobs = new Map<string, PeersResult>();

const JOB_TTL_MS = 2 * 60 * 60 * 1000;
const cleanupTimer = setInterval(() => {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs.entries()) {
    if (new Date(job.createdAt).getTime() < cutoff) jobs.delete(id);
  }
}, 30 * 60 * 1000);
cleanupTimer.unref();

export function getPeersJob(jobId: string): PeersResult | undefined {
  return jobs.get(jobId);
}

export function createPeersJob(): string {
  const jobId = uuidv4();
  jobs.set(jobId, { jobId, status: 'pending', progress: 0, createdAt: new Date().toISOString() });
  return jobId;
}

function updateJob(jobId: string, update: Partial<PeersResult>) {
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

export async function runPeersJob(jobId: string, input: PeersInput): Promise<void> {
  const step = (msg: string, progress: number, status: PeersResult['status']) => {
    updateJob(jobId, { currentStep: msg, progress, status });
    emit(jobId, 'progress', { currentStep: msg, progress });
  };

  try {
    updateJob(jobId, { targetCompany: input.targetCompany, industryContext: input.industryContext });

    step(`Researching ${input.targetCompany}...`, 20, 'researching');
    // Same bounded-wait reasoning as businessDescriptionService.ts: a peer
    // list doesn't need the full ~180s worst-case research budget a deep
    // report would justify. Cap at 40s and proceed with training knowledge
    // past that — discoverCompetitorsFast still anchors on domain identity
    // either way.
    let research = '';
    try {
      research = await Promise.race([
        researchCompanyOverview(input.targetCompany, input.companyDomain),
        new Promise<string>((resolve) => setTimeout(() => resolve(''), 40_000)),
      ]);
    } catch (err) {
      console.warn('[peers] Research failed, proceeding with training knowledge:', err);
    }

    step('Identifying peer companies...', 60, 'synthesizing');
    const competitors = await discoverCompetitorsFast(
      input.targetCompany,
      input.industryContext,
      input.companyDomain,
      research
    );

    const completed: Partial<PeersResult> = {
      status: 'complete',
      progress: 100,
      currentStep: 'Complete',
      competitors,
      completedAt: new Date().toISOString(),
    };
    updateJob(jobId, completed);
    emit(jobId, 'result', { ...jobs.get(jobId) });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Peer discovery failed';
    console.error(`[peers] job ${jobId} failed:`, errorMsg);
    updateJob(jobId, { status: 'error', error: errorMsg, progress: 0 });
    emit(jobId, 'error', { error: errorMsg });
  }
}
