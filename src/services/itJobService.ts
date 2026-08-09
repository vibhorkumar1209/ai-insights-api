import { v4 as uuidv4 } from 'uuid';
import { ItJobInput, ItJobResult } from '@ai-insights/types';
import { synthesizeItJobsChunk, IT_JOBS_CHUNK_COUNT, IT_JOBS_TABLE_HEADER } from './claudeAI';
import { researchItJobs } from './parallelAI';

// ── In-memory job store ────────────────────────────────────────────────────────

const jobs = new Map<string, ItJobResult>();

setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
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

function update(jobId: string, patch: Partial<ItJobResult>): ItJobResult {
  const current = jobs.get(jobId)!;
  const updated = { ...current, ...patch };
  jobs.set(jobId, updated);
  return updated;
}

// ── Public API ─────────────────────────────────────────────────────────────────

export function createItJobJob(input: ItJobInput): string {
  const jobId = uuidv4();
  jobs.set(jobId, {
    jobId,
    status: 'pending',
    progress: 0,
    companyName: input.companyName,
    companyDomain: input.companyDomain,
    createdAt: new Date().toISOString(),
  });
  return jobId;
}

export function getItJobJob(jobId: string): ItJobResult | undefined {
  return jobs.get(jobId);
}

// ── Main runner ──────────────────────────────────────────────────────────────
// Research once (Careers Portal + LinkedIn Jobs + region-specific + specialized
// domain queries, dual-engine Gemini + Parallel.AI), then draft 3 sequential
// region chunks (AMER/APAC/EMEA) so no single region crowds out the others —
// each chunk returns only its rows, appended under one shared table header.

export async function runItJobSearch(jobId: string, input: ItJobInput): Promise<void> {
  try {
    let job = update(jobId, {
      status: 'researching',
      progress: 5,
      currentStep: `Crawling ${input.companyName}'s careers portal and LinkedIn jobs…`,
    });
    emit(jobId, 'progress', job);

    let research = '';
    try {
      research = await researchItJobs(input);
    } catch (err) {
      console.warn('[itJob] Research step failed, proceeding without it:', err instanceof Error ? err.message : err);
    }

    job = update(jobId, {
      status: 'drafting',
      progress: 25,
      currentStep: 'Mapping roles across AMER, APAC, and EMEA…',
    });
    emit(jobId, 'progress', job);

    const rowBlocks: string[] = [];
    for (let i = 0; i < IT_JOBS_CHUNK_COUNT; i++) {
      const progress = Math.round(30 + (i / IT_JOBS_CHUNK_COUNT) * 60);
      job = update(jobId, {
        currentStep: `Drafting region ${i + 1} of ${IT_JOBS_CHUNK_COUNT}…`,
        progress,
      });
      emit(jobId, 'progress', job);

      let chunk;
      try {
        chunk = await synthesizeItJobsChunk(input, i, research);
      } catch (err) {
        console.warn(`[itJob] Chunk ${i} failed, retrying once:`, err instanceof Error ? err.message : err);
        await new Promise((r) => setTimeout(r, 3000));
        try {
          chunk = await synthesizeItJobsChunk(input, i, research);
        } catch (err2) {
          console.error(`[itJob] Chunk ${i} failed after retry — skipping this region:`, err2 instanceof Error ? err2.message : err2);
          continue;
        }
      }
      if (chunk.markdown) rowBlocks.push(chunk.markdown);

      const contentSoFar = `${IT_JOBS_TABLE_HEADER}\n${rowBlocks.join('\n')}`;
      job = update(jobId, { content: contentSoFar, progress });
      emit(jobId, 'progress', job);
    }

    const content = rowBlocks.length > 0
      ? `${IT_JOBS_TABLE_HEADER}\n${rowBlocks.join('\n')}`
      : `${IT_JOBS_TABLE_HEADER}\n| — | — | No verifiable open IT/Software Engineering roles found within the last 6 months. | — | — | — | — |`;

    job = update(jobId, {
      status: 'complete',
      progress: 100,
      currentStep: 'Complete',
      content,
      completedAt: new Date().toISOString(),
    });
    emit(jobId, 'result', job);

  } catch (err) {
    const message = err instanceof Error ? err.message : 'IT Jobs search failed';
    console.error(`[itJob] job ${jobId} failed:`, message);
    const job = update(jobId, { status: 'error', error: message });
    emit(jobId, 'error', job);
  }
}
