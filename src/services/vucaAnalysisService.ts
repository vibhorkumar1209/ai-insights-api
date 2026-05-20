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

export function createVucaJob(params: {
  industry: string;
  geography: string;
  companyName?: string;
  companyDomain?: string;
}): string {
  const jobId = uuidv4();
  jobs.set(jobId, {
    jobId, status: 'pending', progress: 0,
    industry: params.industry, geography: params.geography,
    companyName: params.companyName,
    companyDomain: params.companyDomain,
    clientMode: !!(params.companyName && params.companyDomain),
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

// ── Promise.race wrapper — hard wall-clock cap, always resolves ───────────────
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
  const { industry, geography, analysisDate, companyName, companyDomain } = job;
  const clientMode = !!(companyName && companyDomain);

  try {
    // ── Step 1: Research via Parallel.AI ─────────────────────────────────────
    let current = update(jobId, {
      status: 'researching', progress: 5,
      currentStep: 'Searching web for VUCA intelligence…',
    });
    emit(jobId, 'progress', current);

    const BATCH_TIMEOUT = 50_000;
    const researchHB = startHeartbeat(jobId, 6, clientMode ? 38 : 48, 'Searching for market intelligence…');
    let combinedResearch = '';

    try {
      const industryQueries = [
        `${industry} ${geography} market volatility disruption risks 2024 2025 McKinsey BCG Deloitte analysis`,
        `${industry} ${geography} geopolitical uncertainty tariffs regulation digital transformation 2025`,
        `${industry} ${geography} IT spend technology investment trends forecast 2025 2026 Gartner IDC Forrester`,
      ];

      for (let i = 0; i < industryQueries.length; i++) {
        current = update(jobId, {
          progress: 8 + i * 10,
          currentStep: `Web search ${i + 1}/${clientMode ? 4 : 3}: ${['volatility & risks', 'geopolitical & regulatory', 'IT spend & technology'][i]}…`,
        });
        emit(jobId, 'progress', current);

        const t0 = Date.now();
        const text = await withTimeout(runResearchQuery(industryQueries[i]), BATCH_TIMEOUT, '');
        console.log(`[vuca] industry batch ${i + 1} done in ${Date.now() - t0}ms, len=${text.length}`);
        if (text) combinedResearch += `\n\n=== INDUSTRY BATCH ${i + 1} ===\n${text.slice(0, 7000)}`;
      }
    } finally {
      clearInterval(researchHB);
    }

    // ── Step 1b: Company research (client mode only) ──────────────────────────
    let companyProfile = '';
    if (clientMode && companyName && companyDomain) {
      current = update(jobId, { progress: 40, currentStep: `Researching ${companyName} products & solutions…` });
      emit(jobId, 'progress', current);

      const companyHB = startHeartbeat(jobId, 41, 50, `Analysing ${companyName} portfolio…`);
      try {
        // Query 1: company products from their website
        const q1 = `site:${companyDomain} products solutions services technology offerings`;
        const q2 = `"${companyName}" ${companyDomain} IT products software services portfolio customers case studies 2024 2025`;

        const t0 = Date.now();
        const [r1, r2] = await Promise.all([
          withTimeout(runResearchQuery(q1), BATCH_TIMEOUT, ''),
          withTimeout(runResearchQuery(q2), BATCH_TIMEOUT, ''),
        ]);
        console.log(`[vuca] company research done in ${Date.now() - t0}ms, r1=${r1.length}, r2=${r2.length}`);

        companyProfile = [
          r1 ? `=== ${companyDomain} website ===\n${r1.slice(0, 4000)}` : '',
          r2 ? `=== ${companyName} profile ===\n${r2.slice(0, 4000)}` : '',
        ].filter(Boolean).join('\n\n');

        if (companyProfile) {
          update(jobId, { companyProfile: companyProfile.slice(0, 500) }); // store summary
        }
      } finally {
        clearInterval(companyHB);
      }
    }

    const sourcesFound = combinedResearch.length > 100;
    console.log(`[vuca] all research done, industry=${combinedResearch.length}, company=${companyProfile.length}`);

    current = update(jobId, {
      progress: 52,
      currentStep: `Research complete (${sourcesFound ? 'web sources found' : 'training knowledge'})${clientMode ? ` + ${companyName} portfolio` : ''} — synthesising…`,
    });
    emit(jobId, 'progress', current);

    // ── Step 2: Synthesis ─────────────────────────────────────────────────────
    current = update(jobId, {
      status: 'synthesising', progress: 55,
      currentStep: clientMode
        ? `Building client-specific analysis for ${companyName}…`
        : 'Building VUCA × 4W1H matrix…',
    });
    emit(jobId, 'progress', current);

    const synthHB = startHeartbeat(jobId, 56, 95, 'Generating intelligence tables…');
    let results: Pick<VucaAnalysisJob, 'vuca4w1hMatrix' | 'itSpendImpact' | 'itSpendSummaryTotal' | 'clientITImpact' | 'geopoliticalStress'>;
    try {
      const companyCtx = clientMode && companyName && companyDomain
        ? { name: companyName, domain: companyDomain, profile: companyProfile || `${companyName} — IT products/services company at ${companyDomain}` }
        : undefined;

      results = await runVucaSynthesis(industry, geography, analysisDate!, combinedResearch, companyCtx);
    } catch (synthErr) {
      console.error(`[vucaAnalysis] synthesis error for ${jobId}:`, synthErr);
      results = {
        vuca4w1hMatrix: [], itSpendImpact: [],
        itSpendSummaryTotal: { netDelta: 'N/A', dominantDirection: '▲ EXPAND' },
        clientITImpact: [], geopoliticalStress: [],
      };
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
