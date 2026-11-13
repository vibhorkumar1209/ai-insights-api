import { v4 as uuidv4 } from 'uuid';
import { OutsourcingReportInput, OutsourcingReportResult } from '@ai-insights/types';
import { synthesizeOutsourcingReportChunk, OUTSOURCING_CHUNK_COUNT } from './claudeAI';
import { researchOutsourcingReport } from './parallelAI';
import { isCreditExhausted, incompleteMessage, checkContinuable, ContinueOutcome, queueAutoContinue, isWaitingForCredits, dropAutoContinue } from './continuation';

// ── In-memory job store ────────────────────────────────────────────────────────

const jobs = new Map<string, OutsourcingReportResult>();
// Input and research per job, kept so Continue can write the remaining
// sections without new research. Lost on restart; Continue then re-researches.
const inputs = new Map<string, OutsourcingReportInput>();
const researchByJob = new Map<string, string>();
const JOB_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

setInterval(() => {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs.entries()) {
    if (new Date(job.createdAt).getTime() >= cutoff || isWaitingForCredits(id)) continue;
    jobs.delete(id); inputs.delete(id); researchByJob.delete(id);
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

function update(jobId: string, patch: Partial<OutsourcingReportResult>): OutsourcingReportResult {
  const current = jobs.get(jobId)!;
  const updated = { ...current, ...patch };
  jobs.set(jobId, updated);
  return updated;
}

// ── Public API ─────────────────────────────────────────────────────────────────

export function createOutsourcingReportJob(input: OutsourcingReportInput): string {
  const jobId = uuidv4();
  jobs.set(jobId, {
    jobId,
    status: 'pending',
    progress: 0,
    vendorName: input.vendorName,
    targetIndustry: input.targetIndustry,
    geoFocus: input.geoFocus,
    focusTech: input.focusTech,
    focusSegment: input.focusSegment,
    content: '',
    createdAt: new Date().toISOString(),
  });
  return jobId;
}

export function getOutsourcingReportJob(jobId: string): OutsourcingReportResult | undefined {
  return jobs.get(jobId);
}

// ── Main runner — sequential chunked generation ─────────────────────────────
// Each finished chunk is kept (chunksDone). If a chunk fails, typically because
// AI credits ran out, the job stops with canContinue set, and
// continueOutsourcingReport later writes only the remaining chunks, appending them after
// the existing text. Nothing already written is regenerated.

export async function runOutsourcingReportJob(jobId: string, input: OutsourcingReportInput): Promise<void> {
  inputs.set(jobId, input);
  const job = update(jobId, { status: 'drafting', progress: 5, currentStep: `Researching ${input.vendorName}'s market and competitive landscape…`, chunksDone: 0 });
  emit(jobId, 'progress', job);
  await draftFrom(jobId, input);
}

async function researchFor(jobId: string, input: OutsourcingReportInput): Promise<string> {
  const cached = researchByJob.get(jobId);
  if (cached !== undefined) return cached;
  let research = '';
  try {
    research = await researchOutsourcingReport(input);
  } catch (err) {
    // Non-fatal: the chunks still generate, flagging facts as unconfirmed.
    console.warn('[outsourcingReport] Research step failed, proceeding without it:', err instanceof Error ? err.message : err);
  }
  researchByJob.set(jobId, research);
  return research;
}

async function draftFrom(jobId: string, input: OutsourcingReportInput): Promise<void> {
  try {
    const research = await researchFor(jobId, input);
    let job = jobs.get(jobId)!;
    let content = job.content || '';
    for (let i = job.chunksDone || 0; i < OUTSOURCING_CHUNK_COUNT; i++) {
      const progress = Math.round(10 + (i / OUTSOURCING_CHUNK_COUNT) * 85);
      job = update(jobId, { currentStep: `Drafting section ${i + 1} of ${OUTSOURCING_CHUNK_COUNT}…`, progress });
      emit(jobId, 'progress', job);

      let chunk;
      try {
        chunk = await synthesizeOutsourcingReportChunk(input, i, research);
      } catch (err) {
        if (isCreditExhausted(err)) throw err;
        console.warn(`[outsourcingReport] Chunk ${i} failed, retrying once:`, err instanceof Error ? err.message : err);
        await new Promise((r) => setTimeout(r, 3000));
        chunk = await synthesizeOutsourcingReportChunk(input, i, research);
      }

      content += (content ? '\n\n' : '') + chunk.markdown;
      job = update(jobId, { content, progress, chunksDone: i + 1 });
      emit(jobId, 'progress', job);
    }

    job = update(jobId, {
      status: 'complete', progress: 100, currentStep: 'Complete', content,
      canContinue: false, incompleteReason: undefined, error: undefined,
      completedAt: new Date().toISOString(),
    });
    emit(jobId, 'result', job);
  } catch (err) {
    const raw = err instanceof Error ? err.message : 'Outsourcing report generation failed';
    console.error(`[outsourcingReport] job ${jobId} failed:`, raw);
    const message = isCreditExhausted(err) ? incompleteMessage(err) : raw;
    const job = update(jobId, { status: 'error', error: message, canContinue: true, incompleteReason: incompleteMessage(err) });
    if (isCreditExhausted(err)) queueAutoContinue('industry-outsourcing-report', jobId, () => { continueOutsourcingReport(jobId); });
    emit(jobId, 'error', job);
  }
}

export function continueOutsourcingReport(jobId: string): ContinueOutcome {
  const blocked = checkContinuable(jobs.get(jobId));
  if (blocked) return blocked;
  const input = inputs.get(jobId);
  if (!input) return { ok: false, status: 409, error: 'The original request for this report is no longer available. Start a new report.' };
  dropAutoContinue(jobId);
  const job = update(jobId, { status: 'drafting', currentStep: 'Continuing report…', error: undefined });
  emit(jobId, 'progress', job);
  void draftFrom(jobId, input);
  return { ok: true, started: true };
}
