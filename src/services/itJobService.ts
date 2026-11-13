import { v4 as uuidv4 } from 'uuid';
import { ItJobInput, ItJobResult } from '@ai-insights/types';
import { synthesizeItJobsChunk, IT_JOBS_CHUNK_COUNT, IT_JOBS_TABLE_HEADER } from './claudeAI';
import { researchItJobs } from './parallelAI';
import { isCreditExhausted, incompleteMessage, checkContinuable, ContinueOutcome, queueAutoContinue, isWaitingForCredits, dropAutoContinue } from './continuation';

// ── In-memory job store ────────────────────────────────────────────────────────

const jobs = new Map<string, ItJobResult>();
// Kept so Continue can redo only the regions that failed. Lost on restart;
// Continue then re-researches and redrafts every region.
const inputs = new Map<string, ItJobInput>();
const researchByJob = new Map<string, string>();
const blocksByJob = new Map<string, (string | null)[]>();

setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [id, job] of jobs.entries()) {
    if (new Date(job.createdAt).getTime() >= cutoff || isWaitingForCredits(id)) continue;
    jobs.delete(id); inputs.delete(id); researchByJob.delete(id); blocksByJob.delete(id);
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

// ── Row post-processing: guaranteed reverse-chronological order + dd-mm-yyyy ──
// The synthesis prompt asks each region chunk to self-order newest-first and
// to use YYYY-MM-DD internally, but three separate chunks (one per region)
// can't enforce a single globally-correct order across their combined output,
// and trusting the model to also hand-convert date formats risks silent
// mistakes. Both are done deterministically here instead: parse each row's
// Date cell, sort all rows (across all regions) by that ISO date descending
// — plain string comparison sorts ISO dates correctly — then convert the
// Date cell to dd-mm-yyyy for display. Rows with no verifiable date sort last,
// in their original relative order.

function splitTableRow(row: string): string[] {
  return row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

function isIsoDate(cell: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(cell);
}

function isoToDDMMYYYY(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}-${m}-${y}`;
}

function sortAndFormatRows(rowBlocks: string[]): string {
  const rows = rowBlocks
    .join('\n')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('|'));

  const parsed = rows.map((raw) => ({ raw, cells: splitTableRow(raw) }));
  const dated = parsed.filter((r) => isIsoDate(r.cells[0]));
  const undated = parsed.filter((r) => !isIsoDate(r.cells[0]));
  dated.sort((a, b) => b.cells[0].localeCompare(a.cells[0])); // ISO strings sort correctly lexicographically

  return [...dated, ...undated]
    .map((r) => {
      const cells = [...r.cells];
      if (isIsoDate(cells[0])) cells[0] = isoToDDMMYYYY(cells[0]);
      return `| ${cells.join(' | ')} |`;
    })
    .join('\n');
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
    linkedinHandle: input.linkedinHandle,
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
  inputs.set(jobId, input);
  blocksByJob.set(jobId, new Array(IT_JOBS_CHUNK_COUNT).fill(null));
  await draftRegions(jobId, input);
}

async function draftRegions(jobId: string, input: ItJobInput): Promise<void> {
  try {
    let research = researchByJob.get(jobId);
    if (research === undefined) {
      let job = update(jobId, {
        status: 'researching',
        progress: 5,
        currentStep: `Crawling ${input.companyName}'s careers portal and LinkedIn jobs…`,
      });
      emit(jobId, 'progress', job);
      research = '';
      let debugInfo: Record<string, unknown> | undefined;
      try {
        const result = await researchItJobs(input);
        research = result.text;
        debugInfo = result.diagnostics;
      } catch (err) {
        console.warn('[itJob] Research step failed, proceeding without it:', err instanceof Error ? err.message : err);
      }
      researchByJob.set(jobId, research);
      job = update(jobId, { debugInfo });
    }

    let job = update(jobId, {
      status: 'drafting',
      progress: 25,
      currentStep: 'Mapping roles across AMER, APAC, and EMEA…',
    });
    emit(jobId, 'progress', job);

    // One slot per region; a region left null failed and can be continued.
    const blocks = blocksByJob.get(jobId) ?? new Array(IT_JOBS_CHUNK_COUNT).fill(null);
    blocksByJob.set(jobId, blocks);
    let creditsOut: unknown = null;
    for (let i = 0; i < IT_JOBS_CHUNK_COUNT; i++) {
      if (blocks[i] !== null || creditsOut) continue;
      const progress = Math.round(30 + (i / IT_JOBS_CHUNK_COUNT) * 60);
      job = update(jobId, { currentStep: `Drafting region ${i + 1} of ${IT_JOBS_CHUNK_COUNT}…`, progress });
      emit(jobId, 'progress', job);

      let chunk;
      try {
        chunk = await synthesizeItJobsChunk(input, i, research);
      } catch (err) {
        if (isCreditExhausted(err)) { creditsOut = err; continue; }
        console.warn(`[itJob] Chunk ${i} failed, retrying once:`, err instanceof Error ? err.message : err);
        await new Promise((r) => setTimeout(r, 3000));
        try {
          chunk = await synthesizeItJobsChunk(input, i, research);
        } catch (err2) {
          if (isCreditExhausted(err2)) creditsOut = err2;
          console.error(`[itJob] Chunk ${i} failed after retry — skipping this region:`, err2 instanceof Error ? err2.message : err2);
          continue;
        }
      }
      blocks[i] = chunk.markdown || '';

      const done = blocks.filter((b): b is string => !!b);
      job = update(jobId, { content: `${IT_JOBS_TABLE_HEADER}\n${sortAndFormatRows(done)}`, progress });
      emit(jobId, 'progress', job);
    }

    const rowBlocks = blocks.filter((b): b is string => !!b);
    const missingChunks = blocks.map((b, i) => (b === null ? i : -1)).filter((i) => i >= 0);
    const content = rowBlocks.length > 0
      ? `${IT_JOBS_TABLE_HEADER}\n${sortAndFormatRows(rowBlocks)}`
      : `${IT_JOBS_TABLE_HEADER}\n| — | — | No verifiable open IT/Software Engineering roles found within the last 6 months. | — | — | — | — |`;
    const incomplete = missingChunks.length > 0;

    job = update(jobId, {
      status: 'complete',
      progress: 100,
      currentStep: 'Complete',
      content,
      missingChunks: incomplete ? missingChunks : undefined,
      canContinue: incomplete,
      incompleteReason: incomplete ? incompleteMessage(creditsOut) : undefined,
      error: undefined,
      completedAt: new Date().toISOString(),
    });
    if (creditsOut) queueAutoContinue('it-jobs', jobId, () => { continueItJobSearch(jobId); });
    emit(jobId, 'result', job);

  } catch (err) {
    const message = err instanceof Error ? err.message : 'IT Jobs search failed';
    console.error(`[itJob] job ${jobId} failed:`, message);
    const job = update(jobId, { status: 'error', error: isCreditExhausted(err) ? incompleteMessage(err) : message, canContinue: true, incompleteReason: incompleteMessage(err) });
    if (isCreditExhausted(err)) queueAutoContinue('it-jobs', jobId, () => { continueItJobSearch(jobId); });
    emit(jobId, 'error', job);
  }
}

export function continueItJobSearch(jobId: string): ContinueOutcome {
  const blocked = checkContinuable(jobs.get(jobId));
  if (blocked) return blocked;
  const input = inputs.get(jobId);
  if (!input) return { ok: false, status: 409, error: 'The original request for this search is no longer available. Start a new search.' };
  dropAutoContinue(jobId);
  update(jobId, { status: 'drafting', currentStep: 'Continuing…', error: undefined });
  void draftRegions(jobId, input);
  return { ok: true, started: true };
}
