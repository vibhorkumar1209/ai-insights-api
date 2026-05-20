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

// ── Main orchestrator ─────────────────────────────────────────────────────────

export async function runVucaAnalysis(jobId: string): Promise<void> {
  const job = jobs.get(jobId);
  if (!job) throw new Error(`Job ${jobId} not found`);
  const { industry, geography, analysisDate } = job;

  try {
    // ── Step 1: Research ──────────────────────────────────────────────────────
    let current = update(jobId, {
      status: 'researching', progress: 5,
      currentStep: 'Researching industry VUCA drivers…',
    });
    emit(jobId, 'progress', current);

    const researchHB = startHeartbeat(jobId, 6, 55, 'Gathering market intelligence…');
    let combinedResearch = '';
    try {
      const queries = [
        `"${industry}" ${geography} market volatility risks disruptions 2024 2025 site:mckinsey.com OR site:bcg.com OR site:deloitte.com OR site:pwc.com OR site:ey.com OR site:bain.com OR site:accenture.com`,
        `"${industry}" ${geography} geopolitical uncertainty tariffs regulation technology investment 2024 2025 site:weforum.org OR site:imf.org OR site:worldbank.org OR site:gartner.com OR site:idc.com OR site:forrester.com`,
        `"${industry}" ${geography} IT spend technology budget digital transformation 2025 2026 analyst forecast`,
      ];

      for (let i = 0; i < queries.length; i++) {
        current = update(jobId, { progress: 10 + i * 12, currentStep: `Research batch ${i + 1}/3…` });
        emit(jobId, 'progress', current);
        try {
          const text = await runResearchQuery(queries[i]);
          combinedResearch += `\n\n=== BATCH ${i + 1} ===\n${text.slice(0, 10000)}`;
        } catch {
          combinedResearch += `\n\n=== BATCH ${i + 1} ===\nNo data retrieved.`;
        }
      }
    } finally {
      clearInterval(researchHB);
    }

    current = update(jobId, { progress: 55, currentStep: 'Research complete — building analysis…' });
    emit(jobId, 'progress', current);

    // ── Step 2: Synthesis ─────────────────────────────────────────────────────
    current = update(jobId, { status: 'synthesising', progress: 60, currentStep: 'Synthesising VUCA × 4W1H matrix…' });
    emit(jobId, 'progress', current);

    const synthHB = startHeartbeat(jobId, 61, 95, 'Generating tables…');
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
