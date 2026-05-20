import { v4 as uuidv4 } from 'uuid';
import { VucaAnalysisJob } from '@ai-insights/types';
import { runVucaSynthesis } from './claudeAI.js';

// ── In-memory job store ───────────────────────────────────────────────────────

const jobs = new Map<string, VucaAnalysisJob>();
const JOB_TTL_MS = 2 * 60 * 60 * 1000;
setInterval(() => {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs.entries()) {
    if (job.createdAt && new Date(job.createdAt).getTime() < cutoff) jobs.delete(id);
  }
}, 30 * 60 * 1000).unref();

// ── SSE subscribers ───────────────────────────────────────────────────────────

type SSECallback = (event: string, data: unknown) => void;
const subscribers = new Map<string, SSECallback[]>();

export function subscribeToVucaJob(jobId: string, cb: SSECallback): void {
  const list = subscribers.get(jobId) || [];
  list.push(cb);
  subscribers.set(jobId, list);
}
export function unsubscribeFromVucaJob(jobId: string, cb: SSECallback): void {
  const list = (subscribers.get(jobId) || []).filter((c) => c !== cb);
  if (list.length > 0) subscribers.set(jobId, list);
  else subscribers.delete(jobId);
}
function emit(jobId: string, event: string, data: unknown): void {
  (subscribers.get(jobId) || []).forEach((cb) => {
    try { cb(event, data); } catch { /* ignore */ }
  });
}
function update(jobId: string, patch: Partial<VucaAnalysisJob>): VucaAnalysisJob {
  const current = jobs.get(jobId)!;
  const updated = { ...current, ...patch };
  jobs.set(jobId, updated);
  return updated;
}

// ── Public API ────────────────────────────────────────────────────────────────

export function createVucaJob(params: { industry: string; geography: string }): string {
  const jobId = uuidv4();
  jobs.set(jobId, {
    jobId, status: 'pending', progress: 0,
    industry: params.industry, geography: params.geography,
    analysisDate: new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' }),
    createdAt: new Date().toISOString(),
  });
  return jobId;
}
export function getVucaJob(jobId: string): VucaAnalysisJob | undefined {
  return jobs.get(jobId);
}

// ── Heartbeat ─────────────────────────────────────────────────────────────────

function startHeartbeat(jobId: string, base: number, max: number, label: string) {
  let p = base;
  return setInterval(() => {
    p = Math.min(p + 1, max);
    emit(jobId, 'progress', update(jobId, { progress: p, currentStep: label }));
  }, 15_000);
}

// ── Main orchestrator ─────────────────────────────────────────────────────────

export async function runVucaAnalysis(jobId: string): Promise<void> {
  const job = jobs.get(jobId);
  if (!job) throw new Error(`Job ${jobId} not found`);
  const { industry, geography, analysisDate } = job;

  try {
    // VUCA is knowledge-based (geopolitics, market dynamics) — no Parallel.AI needed.
    // Parallel.AI's node-fetch AbortController doesn't reliably timeout on Render free tier,
    // causing 10+ minute hangs. Claude training knowledge is sufficient for VUCA analysis.

    let current = update(jobId, {
      status: 'synthesising', progress: 10,
      currentStep: 'Building VUCA × 4W1H analysis…',
    });
    emit(jobId, 'progress', current);

    const synthHB = startHeartbeat(jobId, 11, 95, 'Generating intelligence tables…');
    let results: Pick<VucaAnalysisJob, 'vuca4w1hMatrix' | 'itSpendImpact' | 'itSpendSummaryTotal' | 'geopoliticalStress'>;
    try {
      results = await runVucaSynthesis(industry, geography, analysisDate!, '');
    } catch (synthErr) {
      console.error(`[vucaAnalysis] synthesis error for ${jobId}:`, synthErr);
      results = { vuca4w1hMatrix: [], itSpendImpact: [], itSpendSummaryTotal: { netDelta: 'N/A', dominantDirection: '▲ EXPAND' }, geopoliticalStress: [] };
    } finally {
      clearInterval(synthHB);
    }

    // ── Done ──────────────────────────────────────────────────────────────────
    current = update(jobId, {
      status: 'complete', progress: 100, currentStep: 'Complete',
      ...results,
      completedAt: new Date().toISOString(),
    });
    emit(jobId, 'result', current);

  } catch (err) {
    const message = err instanceof Error ? err.message : 'Analysis failed';
    console.error(`[vucaAnalysis] job ${jobId} failed:`, message);
    emit(jobId, 'error', update(jobId, { status: 'error', error: message }));
  }
}
