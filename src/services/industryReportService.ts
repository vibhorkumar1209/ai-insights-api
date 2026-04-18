import { v4 as uuidv4 } from 'uuid';
import {
  IndustryReportInput, IndustryReportResult, IndustryReportScope,
  ReportSection, ScopeWizardResult,
} from '@ai-insights/types';
import { researchIndustryReport } from './parallelAI';
import {
  extractScopeWithWizard,
  synthesizeMarketSizing,
  draftSectionsBatchV2,
  synthesizeExecutiveSummary,
} from './claudeAI';

// ── In-memory job store ──────────────────────────────────────────────────────

const jobs = new Map<string, IndustryReportResult>();
const abortedJobs = new Set<string>();

export function abortJob(jobId: string): boolean {
  const job = jobs.get(jobId);
  if (!job) return false;
  if (job.status === 'complete' || job.status === 'error') return false;
  abortedJobs.add(jobId);
  updateJob(jobId, { status: 'error', error: 'Report generation was cancelled by user.' });
  emit(jobId, 'error', { error: 'Report generation was cancelled by user.' });
  return true;
}

function isJobAborted(jobId: string): boolean {
  return abortedJobs.has(jobId);
}

class JobAbortedError extends Error {
  constructor() { super('Job aborted'); this.name = 'JobAbortedError'; }
}

function checkAbort(jobId: string) {
  if (isJobAborted(jobId)) throw new JobAbortedError();
}

// TTL cleanup: remove jobs older than 2 hours (every 30 min)
const JOB_TTL_MS = 2 * 60 * 60 * 1000;
const cleanupTimer = setInterval(() => {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs.entries()) {
    if (new Date(job.createdAt).getTime() < cutoff) {
      jobs.delete(id);
      abortedJobs.delete(id);
    }
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

// ── Wizard: scope extraction with segments + players ────────────────────────

export async function scopeWithWizard(
  input: IndustryReportInput
): Promise<ScopeWizardResult> {
  return extractScopeWithWizard(input);
}

// ── V2 Runner: enhanced pipeline with selected segments/players ─────────────

export async function runIndustryReportV2(
  jobId: string,
  scope: IndustryReportScope
): Promise<void> {
  const step = (msg: string, progress: number, status: IndustryReportResult['status'] = 'researching') => {
    updateJob(jobId, { currentStep: msg, progress, status });
    emit(jobId, 'progress', { currentStep: msg, progress, status });
  };

  try {
    // ── Step 1: Update scope on job ──
    updateJob(jobId, { scope });
    step('Scope configured', 5, 'scoping');
    checkAbort(jobId);

    // ── Step 2: Research (5-50%) — sequential, 2 queries, progress per query ──
    step('Researching market data (1/2)...', 10, 'researching');
    const researchResults = await researchIndustryReport(scope.searchQueries, (done, total) => {
      if (done < total) step(`Researching market data (${done + 1}/${total})...`, 10 + Math.round(done * 35), 'researching');
    });
    const allResearch = researchResults.join('\n\n--- NEXT RESEARCH SOURCE ---\n\n');
    step('Research complete', 50, 'researching');
    checkAbort(jobId);

    // ── Step 3: Market sizing (50-60%) ──
    step('Analysing market size...', 55, 'sizing');
    const marketSizing = await synthesizeMarketSizing(scope, allResearch);
    updateJob(jobId, { marketSizing });
    step('Market sizing complete', 60, 'sizing');
    checkAbort(jobId);

    // ── Step 4: Section drafting (60-88%) — dynamic batches ──
    const selected = scope.selectedSections?.length
      ? scope.selectedSections
      : ['market_overview', 'market_size_by_segment', 'market_dynamics', 'competition_analysis', 'regulatory_overview', 'forecast', 'swot', 'porters_five_forces', 'tei_analysis'];

    // Group into batches — each batch with 1-2 sections max to reduce JSON complexity
    const batchDefs = [
      ['market_overview'],             // combo chart + 4 subsections
      ['market_size_by_segment'],      // per-segment tables + charts (heavy)
      ['market_dynamics'],             // 4 tables
      ['competition_analysis'],        // 10 profiles + BCG matrix (heavy)
      ['regulatory_overview'],         // 4 tables
      ['forecast'],                    // 3 charts + 2 tables
      ['swot'],                        // SWOT only
      ['porters_five_forces'],         // Porter's only
      ['tei_analysis'],                // TEI only
    ];
    const batches = batchDefs
      .map((ids) => ids.filter((id) => selected.includes(id)))
      .filter((b) => b.length > 0);

    const draftStart = 60, draftEnd = 88;
    const draftStep = batches.length > 0 ? (draftEnd - draftStart) / batches.length : 0;
    let allSections: ReportSection[] = [];

    for (let i = 0; i < batches.length; i++) {
      step(`Drafting report sections (${i + 1}/${batches.length})...`, Math.round(draftStart + i * draftStep), 'drafting');
      try {
        const batchResult = await draftSectionsBatchV2(scope, allResearch, marketSizing, batches[i]);
        allSections = [...allSections, ...batchResult];
      } catch (batchErr) {
        // Retry each section individually if batch fails
        console.warn(`[industryReport] Batch [${batches[i].join(', ')}] failed, retrying individually:`, batchErr instanceof Error ? batchErr.message : batchErr);
        for (const sectionId of batches[i]) {
          checkAbort(jobId);
          try {
            const singleResult = await draftSectionsBatchV2(scope, allResearch, marketSizing, [sectionId]);
            allSections = [...allSections, ...singleResult];
          } catch (singleErr) {
            console.error(`[industryReport] Section ${sectionId} failed even individually:`, singleErr instanceof Error ? singleErr.message : singleErr);
            // Skip this section rather than fail the whole report
          }
        }
      }
      updateJob(jobId, { sections: allSections });
      checkAbort(jobId);
    }
    step('All sections drafted', 88, 'drafting');

    // ── Step 5: Executive summary (88-100%) ──
    step('Generating executive summary...', 92, 'summarizing');
    const executiveSummary = await synthesizeExecutiveSummary(scope, marketSizing, allSections);
    checkAbort(jobId);

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
    if (err instanceof JobAbortedError) {
      console.log(`[industryReport] V2 Job ${jobId} aborted by user.`);
      abortedJobs.delete(jobId);
      return;
    }
    const errorMsg = err instanceof Error ? err.message : 'Unknown error';
    console.error(`[industryReport] V2 Job ${jobId} failed:`, errorMsg);
    updateJob(jobId, { status: 'error', error: errorMsg });
    emit(jobId, 'error', { error: errorMsg });
  }
}

// ── Job manager for error handling utilities ──────────────────────────────────

export function getJobManager() {
  return {
    updateJob,
    emit,
    getJob: getIndustryReportJob,
  };
}
