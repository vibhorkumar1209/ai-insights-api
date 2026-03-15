import { v4 as uuidv4 } from 'uuid';
import { IndustryReportInput, IndustryReportResult, ReportSection } from '../types';
import { researchIndustryReport } from './parallelAI';
import {
  extractReportScope,
  synthesizeMarketSizing,
  draftSectionsBatch,
  synthesizeExecutiveSummary,
} from './claudeAI';

// ── In-memory job store ──────────────────────────────────────────────────────

const jobs = new Map<string, IndustryReportResult>();

// TTL cleanup: remove jobs older than 2 hours (every 30 min)
const JOB_TTL_MS = 2 * 60 * 60 * 1000;
const cleanupTimer = setInterval(() => {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs.entries()) {
    if (new Date(job.createdAt).getTime() < cutoff) jobs.delete(id);
  }
}, 30 * 60 * 1000);
cleanupTimer.unref();

// ── Public API helpers ───────────────────────────────────────────────────────

export function createIndustryReportJob(input: IndustryReportInput): string {
  const jobId = uuidv4();
  jobs.set(jobId, {
    jobId,
    status: 'pending',
    progress: 0,
    query: input.query,
    createdAt: new Date().toISOString(),
  });
  return jobId;
}

export function getIndustryReportJob(jobId: string): IndustryReportResult | undefined {
  return jobs.get(jobId);
}

// ── SSE subscriber registry ──────────────────────────────────────────────────

type SSECallback = (event: string, data: unknown) => void;
const subscribers = new Map<string, SSECallback[]>();

export function subscribeToJob(jobId: string, cb: SSECallback) {
  subscribers.set(jobId, [...(subscribers.get(jobId) || []), cb]);
}

export function unsubscribeFromJob(jobId: string, cb: SSECallback) {
  subscribers.set(jobId, (subscribers.get(jobId) || []).filter((fn) => fn !== cb));
}

function emit(jobId: string, event: string, data: unknown) {
  (subscribers.get(jobId) || []).forEach((cb) => {
    try { cb(event, data); } catch { /* ignore closed connections */ }
  });
}

function updateJob(jobId: string, updates: Partial<IndustryReportResult>) {
  const existing = jobs.get(jobId);
  if (existing) jobs.set(jobId, { ...existing, ...updates });
}

// ── Main runner ──────────────────────────────────────────────────────────────

export async function runIndustryReport(
  jobId: string,
  input: IndustryReportInput
): Promise<void> {
  const step = (msg: string, progress: number, status: IndustryReportResult['status'] = 'researching') => {
    updateJob(jobId, { currentStep: msg, progress, status });
    emit(jobId, 'progress', { currentStep: msg, progress, status });
  };

  try {
    // ── Step 1: Scope extraction (0-10%) ──
    step('Extracting report scope...', 5, 'scoping');
    const scope = await extractReportScope(input);
    updateJob(jobId, { scope });
    step('Scope extracted', 10, 'scoping');

    // ── Step 2: Parallel research (10-50%) ──
    step('Researching market data...', 15, 'researching');
    const researchResults = await researchIndustryReport(scope.searchQueries);
    const allResearch = researchResults.join('\n\n--- NEXT RESEARCH SOURCE ---\n\n');
    step('Research complete', 50, 'researching');

    // ── Step 3: Market sizing (50-60%) ──
    step('Analysing market size...', 55, 'sizing');
    const marketSizing = await synthesizeMarketSizing(scope, allResearch);
    updateJob(jobId, { marketSizing });
    step('Market sizing complete', 60, 'sizing');

    // ── Step 4: Section drafting (60-85%) — 3 batches ──
    step('Drafting report sections (1/3)...', 62, 'drafting');
    const batch1 = await draftSectionsBatch(scope, allResearch, marketSizing, ['introduction', 'market_size', 'segmentation']);
    updateJob(jobId, { sections: batch1 });
    step('Drafting report sections (2/3)...', 72, 'drafting');

    const batch2 = await draftSectionsBatch(scope, allResearch, marketSizing, ['dynamics_trends', 'technology', 'competitive']);
    const sectionsAfter2 = [...batch1, ...batch2];
    updateJob(jobId, { sections: sectionsAfter2 });
    step('Drafting report sections (3/3)...', 80, 'drafting');

    const batch3 = await draftSectionsBatch(scope, allResearch, marketSizing, ['regulatory', 'forecast']);
    const allSections: ReportSection[] = [...sectionsAfter2, ...batch3];
    updateJob(jobId, { sections: allSections });
    step('All sections drafted', 85, 'drafting');

    // ── Step 5: Executive summary (85-100%) ──
    step('Generating executive summary...', 90, 'summarizing');
    const executiveSummary = await synthesizeExecutiveSummary(scope, marketSizing, allSections);

    // ── Complete ──
    updateJob(jobId, {
      status: 'complete',
      progress: 100,
      currentStep: 'Complete',
      executiveSummary,
      completedAt: new Date().toISOString(),
    });
    emit(jobId, 'result', jobs.get(jobId));

  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Unknown error';
    console.error(`[industryReport] Job ${jobId} failed:`, errorMsg);
    updateJob(jobId, { status: 'error', error: errorMsg });
    emit(jobId, 'error', { error: errorMsg });
  }
}
