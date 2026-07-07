import { v4 as uuidv4 } from 'uuid';
import { GccSalesPlayInput, GccSalesPlayResult } from '@ai-insights/types';
import { synthesizeGccSalesPlayChunk, GCC_SALES_PLAY_CHUNK_COUNT } from './claudeAI';

// ── In-memory job store ────────────────────────────────────────────────────────

const jobs = new Map<string, GccSalesPlayResult>();
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

function update(jobId: string, patch: Partial<GccSalesPlayResult>): GccSalesPlayResult {
  const current = jobs.get(jobId)!;
  const updated = { ...current, ...patch };
  jobs.set(jobId, updated);
  return updated;
}

// ── Public API ─────────────────────────────────────────────────────────────────

export function createGccSalesPlayJob(input: GccSalesPlayInput): string {
  const jobId = uuidv4();
  jobs.set(jobId, {
    jobId,
    status: 'pending',
    progress: 0,
    targetCompany: input.targetCompany,
    advisoryFirm: input.advisoryFirm,
    targetGeoRegion: input.targetGeoRegion,
    coreIndustrySegment: input.coreIndustrySegment,
    content: '',
    createdAt: new Date().toISOString(),
  });
  return jobId;
}

export function getGccSalesPlayJob(jobId: string): GccSalesPlayResult | undefined {
  return jobs.get(jobId);
}

// ── Main runner — sequential chunked generation (8 modules across 4 Claude calls) ─

export async function runGccSalesPlayJob(jobId: string, input: GccSalesPlayInput): Promise<void> {
  try {
    let job = update(jobId, {
      status: 'drafting',
      progress: 5,
      currentStep: 'Starting account intelligence dossier…',
    });
    emit(jobId, 'progress', job);

    let content = '';
    for (let i = 0; i < GCC_SALES_PLAY_CHUNK_COUNT; i++) {
      const progress = Math.round(10 + (i / GCC_SALES_PLAY_CHUNK_COUNT) * 85);
      job = update(jobId, {
        currentStep: `Drafting section ${i + 1} of ${GCC_SALES_PLAY_CHUNK_COUNT}…`,
        progress,
      });
      emit(jobId, 'progress', job);

      let chunk;
      try {
        chunk = await synthesizeGccSalesPlayChunk(input, i);
      } catch (err) {
        console.warn(`[gccSalesPlay] Chunk ${i} failed, retrying once:`, err instanceof Error ? err.message : err);
        await new Promise((r) => setTimeout(r, 3000));
        chunk = await synthesizeGccSalesPlayChunk(input, i);
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
    const message = err instanceof Error ? err.message : 'GCC sales play generation failed';
    console.error(`[gccSalesPlay] job ${jobId} failed:`, message);
    const job = update(jobId, { status: 'error', error: message });
    emit(jobId, 'error', job);
  }
}
