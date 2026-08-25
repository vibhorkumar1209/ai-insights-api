import { v4 as uuidv4 } from 'uuid';
import { VucaAnalysisJob } from '@ai-insights/types';
import { runVucaSynthesis } from './claudeAI.js';
import { runResearchQuery, getSearchRecencyInstruction } from './parallelAI.js';

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

    // 40s per batch — resolving withTimeout always moves forward even if Parallel.AI rejects or hangs
    const BATCH_TIMEOUT = 40_000;
    const researchHB = startHeartbeat(jobId, 6, clientMode ? 35 : 45, 'Searching for market intelligence…');
    let combinedResearch = '';

    try {
      const recency = getSearchRecencyInstruction();
      const industryQueries = [
        `${recency}${industry} ${geography} VUCA risks volatility uncertainty geopolitical disruption supply chain wars tariffs ${new Date().getFullYear() - 1} ${new Date().getFullYear()}`,
        `${recency}${industry} ${geography} IT spend technology investment digital transformation forecast ${new Date().getFullYear()} ${new Date().getFullYear() + 1} Gartner IDC Forrester McKinsey`,
      ];

      current = update(jobId, { progress: 10, currentStep: 'Running VUCA & IT spend queries in parallel…' });
      emit(jobId, 'progress', current);

      const t0 = Date.now();
      const industryResults = await Promise.all(
        industryQueries.map((q) => withTimeout(runResearchQuery(q).catch(() => ''), BATCH_TIMEOUT, ''))
      );
      console.log(`[vuca] industry batches done in ${Date.now() - t0}ms`);
      industryResults.forEach((text, i) => {
        if (text) combinedResearch += `\n\n=== INDUSTRY BATCH ${i + 1} ===\n${text.slice(0, 7000)}`;
      });
    } finally {
      clearInterval(researchHB);
    }

    // ── Step 1b: Company research (client mode only) ──────────────────────────
    let companyProfile = '';
    if (clientMode && companyName && companyDomain) {
      current = update(jobId, { progress: 42, currentStep: `Researching ${companyName} products & solutions…` });
      emit(jobId, 'progress', current);

      const companyHB = startHeartbeat(jobId, 43, 50, `Analysing ${companyName} portfolio…`);
      try {
        const recencyC = getSearchRecencyInstruction();
        const q1 = `${recencyC}site:${companyDomain} products solutions services technology offerings`;
        const q2 = `${recencyC}"${companyName}" IT products software services portfolio customers case studies ${new Date().getFullYear() - 1} ${new Date().getFullYear()}`;

        const t0 = Date.now();
        const [r1, r2] = await Promise.all([
          withTimeout(runResearchQuery(q1).catch(() => ''), BATCH_TIMEOUT, ''),
          withTimeout(runResearchQuery(q2).catch(() => ''), BATCH_TIMEOUT, ''),
        ]);
        console.log(`[vuca] company research done in ${Date.now() - t0}ms, r1=${r1.length}, r2=${r2.length}`);

        companyProfile = [
          r1 ? `=== ${companyDomain} website ===\n${r1.slice(0, 4000)}` : '',
          r2 ? `=== ${companyName} profile ===\n${r2.slice(0, 4000)}` : '',
        ].filter(Boolean).join('\n\n');

        if (companyProfile) {
          update(jobId, { companyProfile: companyProfile.slice(0, 500) });
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
      // Previously swallowed here and substituted an empty result — the job
      // still completed with status:'complete' and every table blank, which
      // is worse than a normal error: the user sees a "finished" report with
      // no visible sign anything failed. Re-throw so the outer catch below
      // marks the job status:'error' instead, which the frontend already
      // has a display path for.
      console.error(`[vucaAnalysis] synthesis error for ${jobId}:`, synthErr);
      throw synthErr;
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
