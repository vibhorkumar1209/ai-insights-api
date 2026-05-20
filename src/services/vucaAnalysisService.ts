import { v4 as uuidv4 } from 'uuid';
import { VucaAnalysisJob } from '@ai-insights/types';
import { runVucaSynthesis } from './claudeAI.js';
import { runResearchQuery } from './parallelAI.js';

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

// ── Promise.race wrapper — hard wall-clock cap on any async call ──────────────
// AbortController + node-fetch doesn't reliably cancel on Render free tier.
// Promise.race ALWAYS moves forward after timeoutMs regardless of underlying state.
// The dangling Promise resolves/rejects on its own (TCP timeout ~2-4 min).
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), timeoutMs)),
  ]);
}

// ── Main orchestrator ─────────────────────────────────────────────────────────

export async function runVucaAnalysis(jobId: string): Promise<void> {
  const job = jobs.get(jobId);
  if (!job) throw new Error(`Job ${jobId} not found`);
  const { industry, geography, analysisDate } = job;

  try {
    // ── Step 1: Research via Parallel.AI ─────────────────────────────────────
    let current = update(jobId, {
      status: 'researching', progress: 5,
      currentStep: 'Searching web for VUCA intelligence…',
    });
    emit(jobId, 'progress', current);

    const BATCH_TIMEOUT = 50_000; // 50s per batch — resolves with '' on timeout
    const queries = [
      `${industry} ${geography} market volatility disruption risks 2024 2025 McKinsey BCG Deloitte analysis`,
      `${industry} ${geography} geopolitical uncertainty tariffs regulation digital transformation 2025`,
      `${industry} ${geography} IT spend technology investment trends forecast 2025 2026 Gartner IDC Forrester`,
    ];

    const researchHB = startHeartbeat(jobId, 6, 48, 'Searching for market intelligence…');
    let combinedResearch = '';
    try {
      for (let i = 0; i < queries.length; i++) {
        current = update(jobId, { progress: 8 + i * 12, currentStep: `Web search ${i + 1}/3: ${['volatility & risks', 'geopolitical & regulatory', 'IT spend & technology'][i]}…` });
        emit(jobId, 'progress', current);

        const t0 = Date.now();
        const text = await withTimeout(runResearchQuery(queries[i]), BATCH_TIMEOUT, '');
        const elapsed = Date.now() - t0;
        console.log(`[vuca] batch ${i + 1} done in ${elapsed}ms, len=${text.length}`);

        if (text) combinedResearch += `\n\n=== SEARCH ${i + 1}: ${queries[i].slice(0, 60)} ===\n${text.slice(0, 8000)}`;
      }
    } finally {
      clearInterval(researchHB);
    }

    const sourcesFound = combinedResearch.length > 100;
    console.log(`[vuca] research done, combined len=${combinedResearch.length}, sources=${sourcesFound}`);

    current = update(jobId, { progress: 50, currentStep: `Research complete (${sourcesFound ? 'web sources found' : 'using training knowledge'}) — synthesising…` });
    emit(jobId, 'progress', current);

    // ── Step 2: Synthesis ─────────────────────────────────────────────────────
    current = update(jobId, { status: 'synthesising', progress: 55, currentStep: 'Building VUCA × 4W1H matrix…' });
    emit(jobId, 'progress', current);

    const synthHB = startHeartbeat(jobId, 56, 95, 'Generating intelligence tables…');
    let results: Pick<VucaAnalysisJob, 'vuca4w1hMatrix' | 'itSpendImpact' | 'itSpendSummaryTotal' | 'geopoliticalStress'>;
    try {
      results = await runVucaSynthesis(industry, geography, analysisDate!, combinedResearch);
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
