import { v4 as uuidv4 } from 'uuid';
import { ObjectionHandlingInput, ObjectionHandlingResult } from '@ai-insights/types';
import { researchObjectionHandling } from './parallelAI';
import { synthesizeObjectionHandling } from './claudeAI';

// ── In-memory job store ────────────────────────────────────────────────────────

const jobs = new Map<string, ObjectionHandlingResult>();

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

function update(jobId: string, patch: Partial<ObjectionHandlingResult>): ObjectionHandlingResult {
  const current = jobs.get(jobId);
  if (!current) throw new Error(`Job ${jobId} not found`);
  const updated = { ...current, ...patch };
  jobs.set(jobId, updated);
  return updated;
}

export function getObjectionHandlingJob(jobId: string): ObjectionHandlingResult | undefined {
  return jobs.get(jobId);
}

export function createObjectionHandlingJob(input: ObjectionHandlingInput): string {
  const jobId = uuidv4();
  const job: ObjectionHandlingResult = {
    jobId,
    status: 'pending',
    progress: 0,
    yourCompany:    input.yourCompany,
    competitorName: input.competitorName,
    targetAccount:  input.targetAccount,
    targetIndustry: input.targetIndustry,
    isIncumbent:    input.isIncumbent,
    createdAt: new Date().toISOString(),
  };
  jobs.set(jobId, job);
  return jobId;
}

export async function runObjectionHandling(
  jobId: string,
  input: ObjectionHandlingInput
): Promise<void> {
  try {
    // ── Step 1: Research ─────────────────────────────────────────────────────
    let job = update(jobId, {
      status: 'researching',
      progress: 5,
      currentStep: `Researching competitive intelligence on ${input.competitorName} at ${input.targetAccount}…`,
    });
    emit(jobId, 'progress', job);

    let research = '';
    try {
      const researchTimeout = new Promise<string>((_, reject) => {
        const t = setTimeout(() => reject(new Error('Research timeout')), 50000);
        t.unref?.();
      });
      research = await Promise.race([
        researchObjectionHandling(
          input.yourCompany,
          input.competitorName,
          input.targetAccount,
          input.targetIndustry,
          input.isIncumbent,
          input.competitorWeaknesses
        ),
        researchTimeout,
      ]);
    } catch (err) {
      console.warn('[objectionHandling] Research failed, continuing with empty research:', err instanceof Error ? err.message : err);
    }

    job = update(jobId, {
      status: 'synthesizing',
      progress: 50,
      currentStep: `Synthesising ${input.isIncumbent ? 'incumbent displacement' : 'competitive'} objection playbook…`,
    });
    emit(jobId, 'progress', job);

    // ── Step 2: Synthesize ───────────────────────────────────────────────────
    const result = await synthesizeObjectionHandling(input, research);

    job = update(jobId, {
      status: 'complete',
      progress: 100,
      currentStep: 'Complete',
      execSummary:                  result.execSummary,
      objections:                   result.objections,
      incumbentDisplacementTactics: result.incumbentDisplacementTactics,
      battleCard:                   result.battleCard,
      completedAt: new Date().toISOString(),
    });
    emit(jobId, 'result', job);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Unknown error';
    console.error('[objectionHandling] Fatal error:', errorMsg);
    const job = update(jobId, {
      status: 'error',
      progress: 0,
      error: errorMsg,
    });
    emit(jobId, 'error', job);
  }
}
