import { v4 as uuidv4 } from 'uuid';
import { OutsourcingReportInput, OutsourcingReportResult } from '@ai-insights/types';
import { synthesizeOutsourcingReportChunk, OUTSOURCING_CHUNK_COUNT } from './claudeAI';

// ── In-memory job store ────────────────────────────────────────────────────────

const jobs = new Map<string, OutsourcingReportResult>();
const JOB_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

setInterval(() => {
  const cutoff = Date.now() - JOB_TTL_MS;
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

// ── Main runner — sequential chunked generation (8 steps across 4 Claude calls) ─

export async function runOutsourcingReportJob(jobId: string, input: OutsourcingReportInput): Promise<void> {
  try {
    let job = update(jobId, {
      status: 'drafting',
      progress: 5,
      currentStep: 'Starting strategic blueprint generation…',
    });
    emit(jobId, 'progress', job);

    let content = '';
    for (let i = 0; i < OUTSOURCING_CHUNK_COUNT; i++) {
      const progress = Math.round(10 + (i / OUTSOURCING_CHUNK_COUNT) * 85);
      job = update(jobId, {
        currentStep: `Drafting section ${i + 1} of ${OUTSOURCING_CHUNK_COUNT}…`,
        progress,
      });
      emit(jobId, 'progress', job);

      let chunk;
      try {
        chunk = await synthesizeOutsourcingReportChunk(input, i);
      } catch (err) {
        console.warn(`[outsourcingReport] Chunk ${i} failed, retrying once:`, err instanceof Error ? err.message : err);
        await new Promise((r) => setTimeout(r, 3000));
        chunk = await synthesizeOutsourcingReportChunk(input, i);
      }

      content += (content ? '\n\n' : '') + chunk.markdown;
      job = update(jobId, { content, progress });
      emit(jobId, 'progress', job);
    }

    job = update(jobId, {
      status: 'complete',
      progress: 100,
      currentStep: 'Complete',
      content,
      completedAt: new Date().toISOString(),
    });
    emit(jobId, 'result', job);

  } catch (err) {
    const message = err instanceof Error ? err.message : 'Outsourcing report generation failed';
    console.error(`[outsourcingReport] job ${jobId} failed:`, message);
    const job = update(jobId, { status: 'error', error: message });
    emit(jobId, 'error', job);
  }
}
