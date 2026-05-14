import { v4 as uuidv4 } from 'uuid';
import { SalesPlayResult, SalesPlayInput } from '@ai-insights/types';
import { synthesizeSalesPlay } from './claudeAI';

// ── In-memory job store ────────────────────────────────────────────────────────

const jobs = new Map<string, SalesPlayResult>();

const JOB_TTL_MS = 2 * 60 * 60 * 1000;
const cleanupTimer = setInterval(() => {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs.entries()) {
    if (new Date(job.createdAt).getTime() < cutoff) jobs.delete(id);
  }
}, 30 * 60 * 1000);
cleanupTimer.unref();

// ── Event pub/sub (SSE delivery) ──────────────────────────────────────────────

type Listener = (event: string, data: unknown) => void;
const listeners = new Map<string, Set<Listener>>();

function emit(jobId: string, event: string, data: unknown) {
  const subs = listeners.get(jobId);
  if (subs) subs.forEach((fn) => { try { fn(event, data); } catch { /* closed */ } });
}

export function subscribeToJob(jobId: string, fn: Listener) {
  if (!listeners.has(jobId)) listeners.set(jobId, new Set());
  listeners.get(jobId)!.add(fn);
}

export function unsubscribeFromJob(jobId: string, fn: Listener) {
  listeners.get(jobId)?.delete(fn);
}

// ── Job helpers ───────────────────────────────────────────────────────────────

function update(jobId: string, patch: Partial<SalesPlayResult>): SalesPlayResult {
  const current = jobs.get(jobId);
  if (!current) throw new Error(`Job ${jobId} not found`);
  const updated = { ...current, ...patch };
  jobs.set(jobId, updated);
  return updated;
}

export function getSalesPlayJob(jobId: string): SalesPlayResult | undefined {
  return jobs.get(jobId);
}

// ── Job lifecycle ─────────────────────────────────────────────────────────────

export function createSalesPlayJob(input: SalesPlayInput): string {
  const jobId = uuidv4();
  const job: SalesPlayResult = {
    jobId,
    status: 'pending',
    progress: 0,
    yourCompany:    input.yourCompany,
    competitorName: input.competitorName,
    targetAccount:  input.targetAccount,
    targetIndustry: input.targetIndustry,
    createdAt: new Date().toISOString(),
  };
  jobs.set(jobId, job);
  return jobId;
}

export async function runSalesPlay(
  jobId: string,
  input: SalesPlayInput
): Promise<void> {
  try {
    // ── Step 1: Synthesise (using Claude training knowledge — no external research)
    let job = update(jobId, {
      status: 'synthesizing',
      progress: 10,
      currentStep: `Building Sales Play for ${input.targetAccount}…`,
    });
    emit(jobId, 'progress', job);

    const result = await synthesizeSalesPlay(input, '');

    const completedAt = new Date().toISOString();
    job = update(jobId, {
      status: 'complete',
      progress: 100,
      currentStep: 'Complete',
      completedAt,
      priorityTable:        result.priorityTable,
      industrySolutions:    result.industrySolutions,
      techSummary:          result.techSummary,
      technologyPartners:   result.technologyPartners,
      siPartners:           result.siPartners,
      caseStudies:          result.caseStudies,
      priorityMapping:      result.priorityMapping,
      competitiveStatement: result.competitiveStatement,
      objectionRebuttals:   result.objectionRebuttals,
      callToAction:         result.callToAction,
    });
    emit(jobId, 'result', job);

  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.error('[salesPlay] Job failed:', msg);
    const job = update(jobId, { status: 'error', error: msg, progress: 0 });
    emit(jobId, 'error', job);
  }
}
