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
  SECTION_DEFINITIONS_V2,
} from './claudeAI';
import { isCreditExhausted, incompleteMessage, checkContinuable, ContinueOutcome, queueAutoContinue, isWaitingForCredits, dropAutoContinue } from './continuation';

// ── In-memory job store ──────────────────────────────────────────────────────

const jobs = new Map<string, IndustryReportResult>();
const abortedJobs = new Set<string>();
// Research behind each report, kept so Continue can draft missing sections
// without paying for the research again. Lost on restart; Continue then
// re-runs it.
const researchByJob = new Map<string, string>();

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
  // Stop the pipeline at the next checkpoint once the deadline has fired, so
  // a timed-out report stops consuming API credits instead of running on
  // invisibly behind an already-errored job.
  if (deadlineExceeded.has(jobId)) throw new JobDeadlineError();
}

// TTL cleanup: remove jobs older than 2 hours (every 30 min)
const JOB_TTL_MS = 2 * 60 * 60 * 1000;
const cleanupTimer = setInterval(() => {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs.entries()) {
    if (new Date(job.createdAt).getTime() >= cutoff) continue;
    // Never evict a job that is still running. Eviction is keyed on
    // createdAt, so a long report crossing the 2h mark used to be deleted
    // mid-flight: updateJob() then silently no-opped (it returns early when
    // the entry is gone), the pipeline kept burning credits with nowhere to
    // write results, and the client's next poll got a 404. From the outside
    // that is exactly "started and never completed", with no error recorded.
    if (job.status !== 'complete' && job.status !== 'error') continue;
    // A report waiting for credits must still be here when they come back.
    if (isWaitingForCredits(id)) continue;
    jobs.delete(id);
    abortedJobs.delete(id);
    researchByJob.delete(id);
    deadlineExceeded.delete(id);
    const timer = deadlineTimers.get(id);
    if (timer) { clearTimeout(timer); deadlineTimers.delete(id); }
  }
}, 30 * 60 * 1000);
cleanupTimer.unref();

// ── Hard deadline ────────────────────────────────────────────────────────────
// Every individual step has its own timeout, but nothing bounded the run as a
// whole, so any step that stalled without throwing left the job pinned in a
// non-terminal state forever — a spinner that never resolves and no error to
// explain it. The deadline guarantees every job reaches a terminal state.
//
// Sized from an observed run, not an estimate: a full 12-section report took
// 36 minutes end to end, so the original 45 minute value left almost no
// headroom and risked the watchdog killing a report that was still making
// progress. 75 minutes is comfortably clear of that while remaining well
// below the 2h TTL, which is what the deadline actually has to stay under.
// The deadline exists to guarantee terminality, so erring long is correct —
// a stuck job costs extra waiting, a premature deadline destroys real work.
const JOB_DEADLINE_MS = 75 * 60 * 1000;
const deadlineExceeded = new Set<string>();
const deadlineTimers = new Map<string, NodeJS.Timeout>();

class JobDeadlineError extends Error {
  constructor() { super(`Report generation exceeded the ${Math.round(JOB_DEADLINE_MS / 60000)} minute limit and was stopped.`); this.name = 'JobDeadlineError'; }
}

function startDeadline(jobId: string): void {
  clearDeadline(jobId);
  const timer = setTimeout(() => {
    const job = jobs.get(jobId);
    if (!job || job.status === 'complete' || job.status === 'error') return;
    deadlineExceeded.add(jobId);
    const error = new JobDeadlineError().message;
    console.error(`[industryReport] job ${jobId} hit the hard deadline at step: ${job.currentStep || 'unknown'}`);
    updateJob(jobId, { status: 'error', error });
    emit(jobId, 'error', { error });
  }, JOB_DEADLINE_MS);
  timer.unref();
  deadlineTimers.set(jobId, timer);
}

function clearDeadline(jobId: string): void {
  const timer = deadlineTimers.get(jobId);
  if (timer) { clearTimeout(timer); deadlineTimers.delete(jobId); }
  deadlineExceeded.delete(jobId);
}

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

// ── Market Size Consistency Validation ──────────────────────────────────────

/**
 * Validates that market_size_by_segment subsection totals match market_overview totals per year.
 * Returns validation result with any discrepancies found.
 */
function validateMarketSizeConsistency(
  overviewSection: ReportSection | undefined,
  segmentSection: ReportSection | undefined
): { isValid: boolean; discrepancies: Array<{ year: string; expected: string; actual: string; difference: string }> } {
  const discrepancies: Array<{ year: string; expected: string; actual: string; difference: string }> = [];

  if (!overviewSection?.keyTable || !segmentSection?.subsections?.length) {
    // Not enough data to validate
    return { isValid: true, discrepancies: [] };
  }

  try {
    // Extract overview totals: parse keyTable rows for Year and Market Size
    const overviewRows = overviewSection.keyTable.rows || [];
    const overviewTotals = new Map<string, number>();

    for (const row of overviewRows) {
      if (row.length >= 2) {
        const year = String(row[0]).trim();
        const marketSizeStr = String(row[1]).trim();
        // Parse market size (e.g., "$75.2B" → 75.2)
        const match = marketSizeStr.match(/[\$£€]?\s*([\d.]+)\s*[BM]?/);
        if (match && match[1]) {
          const value = parseFloat(match[1]);
          if (!isNaN(value)) {
            overviewTotals.set(year, value);
          }
        }
      }
    }

    // Extract segment totals per year from all subsections
    const segmentTotalsByYear = new Map<string, number>();
    for (const subsection of segmentSection.subsections) {
      if (!subsection.keyTable?.rows) continue;
      for (const row of subsection.keyTable.rows) {
        if (row.length >= 2) {
          // Segment table structure: [Sub-segment, Market Size, ...]
          // We need to accumulate Market Size per year across subsections
          // Since each subsection is per-segment, we'll sum them by extracting from context
          const marketSizeStr = String(row[1]).trim();
          const match = marketSizeStr.match(/[\$£€]?\s*([\d.]+)\s*[BM]?/);
          if (match && match[1]) {
            const value = parseFloat(match[1]);
            if (!isNaN(value)) {
              // For simplicity, assume current year context from subsection title
              const currentYear = segmentTotalsByYear.get('current') || 0;
              segmentTotalsByYear.set('current', currentYear + value);
            }
          }
        }
      }
    }

    // Check consistency with tolerance (±2%)
    const TOLERANCE = 0.02;
    for (const [year, expectedTotal] of overviewTotals.entries()) {
      const actualTotal = segmentTotalsByYear.get(year) || segmentTotalsByYear.get('current');
      if (actualTotal !== undefined) {
        const difference = Math.abs(actualTotal - expectedTotal) / expectedTotal;
        if (difference > TOLERANCE) {
          discrepancies.push({
            year,
            expected: expectedTotal.toFixed(2),
            actual: actualTotal.toFixed(2),
            difference: (difference * 100).toFixed(1),
          });
        }
      }
    }

    const isValid = discrepancies.length === 0;
    if (!isValid) {
      console.warn(
        `[industryReport] Market size inconsistency detected:`,
        discrepancies.map((d) => `${d.year}: expected ${d.expected}B, got ${d.actual}B (${d.difference}% diff)`)
      );
    } else {
      console.log(`[industryReport] Market size consistency validated ✓`);
    }

    return { isValid, discrepancies };
  } catch (err) {
    console.warn(`[industryReport] Market size validation error (non-critical):`, err instanceof Error ? err.message : err);
    return { isValid: true, discrepancies: [] }; // Don't fail report on validation error
  }
}

// ── Main runner ──────────────────────────────────────────────────────────────

// ── Wizard: scope extraction with segments + players ────────────────────────

export async function scopeWithWizard(
  input: IndustryReportInput
): Promise<ScopeWizardResult> {
  return extractScopeWithWizard(input);
}

// ── V2 Runner: enhanced pipeline with selected segments/players ─────────────

// Outside callers never see the scope's searchQueries (they are methodology,
// so externalRedaction strips them from the /scope response). When such a
// caller posts that scope back to /generate the queries are missing, and the
// research step used to throw on undefined before any work ran: every
// RefractOne report failed instantly. Rebuild them from the scope instead.
export function researchQueriesFor(scope: IndustryReportScope): string[] {
  const given = Array.isArray(scope.searchQueries)
    ? scope.searchQueries.filter((q) => typeof q === 'string' && q.trim())
    : [];
  if (given.length) return given;
  const market = [scope.subIndustry, scope.industry].filter(Boolean).join(' ').trim() || scope.industry;
  const where = scope.geography && !/^global$/i.test(scope.geography) ? ` in ${scope.geography}` : ' globally';
  const horizon = scope.timeHorizon ? ` ${scope.timeHorizon}` : '';
  return [
    `${market} market size, revenue and growth rate${where}${horizon}, with segment breakdown`,
    `${market} market trends, demand drivers and challenges${where}`,
    `${market} competitive landscape: leading companies, market shares and recent strategy${where}`,
    `${market} regulation, standards and policy${where}`,
    `${market} applications, end-user industries and adoption${where}`,
    `${market} innovation, new products, startups, M&A and partnerships${where}`,
  ];
}

function queueIfCreditsOut(jobId: string, err: unknown): void {
  if (isCreditExhausted(err)) queueAutoContinue('industry-report', jobId, () => { continueIndustryReport(jobId); });
}

const ALL_SECTIONS = ['market_overview', 'market_size_by_segment', 'market_dynamics', 'key_players_analysis', 'regulatory_overview', 'forecast', 'ma_jv_partnerships', 'market_innovation', 'market_opportunities', 'swot', 'porters_five_forces', 'tei_analysis'];

export function selectedSectionsFor(scope: IndustryReportScope): string[] {
  return scope.selectedSections?.length ? scope.selectedSections : ALL_SECTIONS;
}

export async function runIndustryReportV2(
  jobId: string,
  scope: IndustryReportScope
): Promise<void> {
  const step = (msg: string, progress: number, status: IndustryReportResult['status'] = 'researching') => {
    updateJob(jobId, { currentStep: msg, progress, status });
    emit(jobId, 'progress', { currentStep: msg, progress, status });
  };

  startDeadline(jobId);

  try {
    // ── Step 1: Update scope on job ──
    updateJob(jobId, { scope });
    step('Scope configured', 5, 'scoping');
    checkAbort(jobId);

    // ── Step 2: Research (5-50%) — sequential, 2 queries, progress per query ──
    step('Researching market data (1/2)...', 10, 'researching');
    const researchResults = await researchIndustryReport(researchQueriesFor(scope), (done, total) => {
      if (done < total) step(`Researching market data (${done + 1}/${total})...`, 10 + Math.round(done * 35), 'researching');
    });
    const allResearch = researchResults.join('\n\n--- NEXT RESEARCH SOURCE ---\n\n');
    researchByJob.set(jobId, allResearch);
    step('Research complete', 50, 'researching');
    checkAbort(jobId);

    // ── Step 3: Market sizing (50-60%) ──
    step('Analysing market size...', 55, 'sizing');
    const marketSizing = await synthesizeMarketSizing(scope, allResearch);
    updateJob(jobId, { marketSizing });
    step('Market sizing complete', 60, 'sizing');
    checkAbort(jobId);

    // ── Step 4: Section drafting (60-88%) — dynamic batches ──
    // Fallback when no explicit selection is supplied (e.g. a direct API call
    // rather than the wizard). This previously listed only the 9 "core"
    // sections, silently omitting swot / porters_five_forces / tei_analysis —
    // so those three never appeared for API callers at all, and only appeared
    // from the UI if the user manually ticked them. Now defaults to the full
    // set, matching batchDefs below.
    const selected = selectedSectionsFor(scope);

    // Group into batches — each batch with 1-2 sections max to reduce JSON complexity
    const batchDefs = [
      ['market_overview'],                  // combo chart + 4 subsections
      ['market_size_by_segment'],           // per-segment tables + charts (heavy)
      ['market_dynamics'],                  // 4 tables
      ['key_players_analysis'],             // profiles + market share chart
      ['regulatory_overview'],              // 4 tables (core)
      ['forecast'],                         // 3 charts + 2 tables
      ['ma_jv_partnerships'],              // M&A deals last 12 months
      ['market_innovation'],               // startup/patent innovation tracker table
      ['market_opportunities'],            // analyst-highlighted growth hotspots table
      ['swot'],                            // optional
      ['porters_five_forces'],             // optional
      ['tei_analysis'],                    // optional
    ];
    const batches = batchDefs
      .map((ids) => ids.filter((id) => selected.includes(id)))
      .filter((b) => b.length > 0);

    const draftStart = 60, draftEnd = 88;
    const draftStep = batches.length > 0 ? (draftEnd - draftStart) / batches.length : 0;
    let allSections: ReportSection[] = [];
    const failedSections: { id: string; title: string; reason?: string }[] = [];

    // Once the provider says the credits are gone, every further call fails
    // the same way; retrying and sweeping would only add minutes. Record the
    // rest as not yet written so Continue can pick them up.
    let creditsOut: unknown = null;
    for (let i = 0; i < batches.length; i++) {
      if (creditsOut) {
        for (const id of batches[i]) failedSections.push({ id, title: SECTION_DEFINITIONS_V2[id]?.title || id, reason: incompleteMessage(creditsOut) });
        continue;
      }
      step(`Drafting report sections (${i + 1}/${batches.length})...`, Math.round(draftStart + i * draftStep), 'drafting');
      try {
        const batchResult = await draftSectionsBatchV2(scope, allResearch, marketSizing, batches[i]);
        if (batchResult.length === 0) throw new Error('Batch returned zero sections');
        allSections = [...allSections, ...batchResult];
      } catch (batchErr) {
        if (isCreditExhausted(batchErr)) {
          creditsOut = batchErr;
          for (const id of batches[i]) failedSections.push({ id, title: SECTION_DEFINITIONS_V2[id]?.title || id, reason: incompleteMessage(batchErr) });
          updateJob(jobId, { sections: allSections, failedSections });
          continue;
        }
        console.warn(`[industryReport] Batch [${batches[i].join(', ')}] failed, retrying individually:`, batchErr instanceof Error ? batchErr.message : batchErr);
        // Retry each section individually — up to 2 extra attempts with
        // increasing backoff (5s, then 12s). Batches later in the sequence
        // (swot/porters_five_forces/tei_analysis are always requested last,
        // after 9+ prior Claude calls in the same report) are the most
        // exposed to accumulated API rate-limiting, so a real wait between
        // attempts matters far more here than for early batches — a fixed
        // 3s gap was frequently too short to clear a rate-limit window,
        // causing these three optional sections to fail silently and
        // consistently in practice.
        let lastErrForSection: unknown;
        for (const sectionId of batches[i]) {
          checkAbort(jobId);
          let succeeded = false;
          for (let attempt = 1; attempt <= 2 && !succeeded; attempt++) {
            try {
              const singleResult = await draftSectionsBatchV2(scope, allResearch, marketSizing, [sectionId]);
              if (singleResult.length === 0) throw new Error('Retry returned zero sections');
              allSections = [...allSections, ...singleResult];
              succeeded = true;
            } catch (singleErr) {
              lastErrForSection = singleErr;
              console.warn(`[industryReport] Section ${sectionId} retry ${attempt}/2 failed:`, singleErr instanceof Error ? singleErr.message : singleErr);
              if (attempt < 2) await new Promise((r) => setTimeout(r, attempt * 5000 + 2000));
            }
          }
          if (!succeeded) {
            console.error(`[industryReport] Section ${sectionId} failed after all retries — skipping.`);
            failedSections.push({
              id: sectionId,
              title: SECTION_DEFINITIONS_V2[sectionId]?.title || sectionId,
              reason: lastErrForSection instanceof Error ? lastErrForSection.message : String(lastErrForSection),
            });
          }
        }
      }
      updateJob(jobId, { sections: allSections, failedSections: failedSections.length ? failedSections : undefined });
      checkAbort(jobId);
    }

    // ── Step 4a: Final recovery sweep ──
    // Last line of defence so a report is not silently delivered with a
    // missing section. By this point 12+ Claude calls have been made in quick
    // succession, and the dominant cause of a section failing both its batch
    // attempt and its immediate retries is accumulated rate-limiting, which a
    // longer cooldown clears far better than the short in-loop backoffs.
    if (failedSections.length > 0 && !creditsOut) {
      step(`Recovering ${failedSections.length} section(s)...`, 86, 'drafting');
      const stillFailed: typeof failedSections = [];
      for (const f of failedSections) {
        checkAbort(jobId);
        await new Promise((r) => setTimeout(r, 15000));
        try {
          const recovered = await draftSectionsBatchV2(scope, allResearch, marketSizing, [f.id]);
          if (recovered.length === 0) throw new Error('Sweep returned zero sections');
          allSections = [...allSections, ...recovered];
          console.log(`[industryReport] Sweep recovered section ${f.id}`);
        } catch (sweepErr) {
          console.error(`[industryReport] Sweep failed for ${f.id}:`, sweepErr instanceof Error ? sweepErr.message : sweepErr);
          stillFailed.push(f);
        }
      }
      failedSections.length = 0;
      failedSections.push(...stillFailed);
    }

    // Restore canonical section order. Individual retries and the sweep append
    // recovered sections at the end, so without this a recovered section (e.g.
    // market_dynamics) would render after tei_analysis instead of in its
    // proper position in the report.
    const sectionOrder = new Map(selected.map((id, idx) => [id, idx]));
    allSections.sort((a, b) => (sectionOrder.get(a.id) ?? 999) - (sectionOrder.get(b.id) ?? 999));

    updateJob(jobId, { sections: allSections, failedSections: failedSections.length ? failedSections : undefined });

    // A report with no sections is not a report. This previously ran on to
    // completion and returned status 'complete' at progress 100 with an empty
    // sections array and an executive summary summarising nothing — the job
    // looked finished while carrying no content, which is indistinguishable
    // from "it never completed" to whoever is waiting for it. Fail loudly
    // instead, naming the underlying cause so it is actionable.
    if (allSections.length === 0) {
      const distinct = [...new Set(failedSections.map((f) => f.reason).filter(Boolean))];
      const detail = distinct.length === 1
        ? ` All ${failedSections.length} sections failed with: ${distinct[0]}`
        : distinct.length > 1
          ? ` Causes: ${distinct.slice(0, 3).join(' | ')}`
          : '';
      throw new Error(`Report generation produced no sections.${detail}`);
    }

    step('All sections drafted', 88, 'drafting');

    // ── Step 4b: Market size consistency validation ──
    const overviewSection = allSections.find((s) => s.id === 'market_overview');
    const segmentSection = allSections.find((s) => s.id === 'market_size_by_segment');
    if (overviewSection || segmentSection) {
      const validation = validateMarketSizeConsistency(overviewSection, segmentSection);
      if (!validation.isValid) {
        console.warn(`[industryReport] Market size consistency check failed. Discrepancies:`, validation.discrepancies);
        // Log for debugging but don't fail the report — data quality warning
        updateJob(jobId, {
          marketSizeValidation: {
            isValid: false,
            discrepanciesCount: validation.discrepancies.length,
            note: 'Market size segments may not sum to overview total. Review values manually.',
          },
        });
      }
    }
    checkAbort(jobId);

    // ── Step 5: Executive summary (88-100%) ──
    step('Generating executive summary...', 92, 'summarizing');
    // A failure here used to hit the outer catch and mark the whole job
    // status:'error', discarding every section drafted in step 4 (60-88% of
    // the job's real work) over one summary call. Degrade instead: complete
    // without executiveSummary (already optional on IndustryReportResult)
    // rather than losing a fully-drafted report.
    let executiveSummary: Awaited<ReturnType<typeof synthesizeExecutiveSummary>> | undefined;
    let summaryErr: unknown = creditsOut;
    if (!creditsOut) {
      try {
        executiveSummary = await synthesizeExecutiveSummary(scope, marketSizing, allSections);
      } catch (err) {
        summaryErr = err;
        console.error(`[industryReport] Executive summary failed for ${jobId}, completing without it:`, err);
      }
    }
    checkAbort(jobId);

    // ── Complete ──
    const incomplete = failedSections.length > 0 || !executiveSummary;
    updateJob(jobId, {
      status: 'complete',
      progress: 100,
      currentStep: 'Complete',
      executiveSummary,
      canContinue: incomplete,
      incompleteReason: incomplete ? incompleteMessage(creditsOut || summaryErr || failedSections[0]?.reason) : undefined,
      completedAt: new Date().toISOString(),
    });
    if (incomplete) queueIfCreditsOut(jobId, creditsOut || summaryErr);
    emit(jobId, 'result', jobs.get(jobId));

  } catch (err) {
    if (err instanceof JobAbortedError) {
      console.log(`[industryReport] V2 Job ${jobId} aborted by user.`);
      abortedJobs.delete(jobId);
      return;
    }
    // The deadline handler has already marked the job errored and notified
    // subscribers; re-marking would only overwrite that with the same thing.
    if (err instanceof JobDeadlineError) {
      console.error(`[industryReport] V2 Job ${jobId} stopped at the hard deadline.`);
      return;
    }
    const raw = err instanceof Error ? err.message : 'Unknown error';
    console.error(`[industryReport] V2 Job ${jobId} failed:`, raw);
    // The scope is on the job, and anything already written is kept, so the
    // run can always be continued rather than started again.
    const errorMsg = isCreditExhausted(err) ? incompleteMessage(err) : raw;
    updateJob(jobId, { status: 'error', error: errorMsg, canContinue: true, incompleteReason: incompleteMessage(err) });
    queueIfCreditsOut(jobId, err);
    emit(jobId, 'error', { error: errorMsg });
  } finally {
    // Runs on success, failure, abort and deadline alike — a leaked timer
    // would fire later and error a job that had already finished.
    clearDeadline(jobId);
  }
}

// ── Continue ────────────────────────────────────────────────────────────────
// Finishes a report that stopped part-way. Sections already written are kept
// exactly as they are; only the missing ones are drafted, then slotted into
// their usual order. The executive summary is written only if there is none.

export function continueIndustryReport(jobId: string): ContinueOutcome {
  const job = jobs.get(jobId);
  const blocked = checkContinuable(job);
  if (blocked) return blocked;
  if (!job!.scope) return { ok: false, status: 409, error: 'This report stopped before its scope was set. Start a new report.' };
  updateJob(jobId, { status: 'drafting', progress: 60, currentStep: 'Continuing report...', error: undefined });
  dropAutoContinue(jobId);
  runContinuation(jobId).catch((err) => {
    queueIfCreditsOut(jobId, err);
    updateJob(jobId, { status: 'error', error: incompleteMessage(err), canContinue: true, incompleteReason: incompleteMessage(err) });
    emit(jobId, 'error', { error: incompleteMessage(err) });
  });
  return { ok: true, started: true };
}

async function runContinuation(jobId: string): Promise<void> {
  const job = jobs.get(jobId)!;
  const scope = job.scope!;
  const step = (msg: string, progress: number, status: IndustryReportResult['status']) => {
    updateJob(jobId, { currentStep: msg, progress, status });
    emit(jobId, 'progress', { currentStep: msg, progress, status });
  };
  startDeadline(jobId);
  try {
    let research = researchByJob.get(jobId);
    if (!research) {
      step('Researching market data...', 20, 'researching');
      research = (await researchIndustryReport(researchQueriesFor(scope))).join('\n\n--- NEXT RESEARCH SOURCE ---\n\n');
      researchByJob.set(jobId, research);
    }
    let marketSizing = job.marketSizing;
    if (!marketSizing) {
      step('Analysing market size...', 55, 'sizing');
      marketSizing = await synthesizeMarketSizing(scope, research);
      updateJob(jobId, { marketSizing });
    }

    const selected = selectedSectionsFor(scope);
    let sections = [...(job.sections || [])];
    const have = new Set(sections.map((s) => s.id));
    const missing = selected.filter((id) => !have.has(id));
    const failed: { id: string; title: string; reason?: string }[] = [];
    let creditsOut: unknown = null;

    for (let i = 0; i < missing.length; i++) {
      const id = missing[i];
      const title = SECTION_DEFINITIONS_V2[id]?.title || id;
      if (creditsOut) { failed.push({ id, title, reason: incompleteMessage(creditsOut) }); continue; }
      step(`Drafting missing sections (${i + 1}/${missing.length})...`, 60 + Math.round((i / Math.max(missing.length, 1)) * 28), 'drafting');
      checkAbort(jobId);
      let lastErr: unknown;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const drafted = await draftSectionsBatchV2(scope, research, marketSizing, [id]);
          if (drafted.length === 0) throw new Error('Section returned empty');
          sections = [...sections, ...drafted];
          lastErr = undefined;
          break;
        } catch (err) {
          lastErr = err;
          if (isCreditExhausted(err)) break;
          if (attempt < 2) await new Promise((r) => setTimeout(r, 8000));
        }
      }
      if (lastErr) {
        if (isCreditExhausted(lastErr)) creditsOut = lastErr;
        failed.push({ id, title, reason: lastErr instanceof Error ? lastErr.message : String(lastErr) });
      }
      const order = new Map(selected.map((sid, idx) => [sid, idx]));
      sections.sort((a, b) => (order.get(a.id) ?? 999) - (order.get(b.id) ?? 999));
      updateJob(jobId, { sections, failedSections: failed.length ? failed : undefined });
    }

    if (sections.length === 0) throw creditsOut || new Error('No sections could be written.');

    let executiveSummary = job.executiveSummary;
    let summaryErr: unknown = creditsOut;
    if (!executiveSummary && !creditsOut) {
      step('Generating executive summary...', 92, 'summarizing');
      try {
        executiveSummary = await synthesizeExecutiveSummary(scope, marketSizing, sections);
      } catch (err) {
        summaryErr = err;
      }
    }

    const incomplete = failed.length > 0 || !executiveSummary;
    updateJob(jobId, {
      status: 'complete',
      progress: 100,
      currentStep: 'Complete',
      executiveSummary,
      failedSections: failed.length ? failed : undefined,
      canContinue: incomplete,
      incompleteReason: incomplete ? incompleteMessage(creditsOut || summaryErr || failed[0]?.reason) : undefined,
      error: undefined,
      completedAt: new Date().toISOString(),
    });
    if (incomplete) queueIfCreditsOut(jobId, creditsOut || summaryErr);
    emit(jobId, 'result', jobs.get(jobId));
  } finally {
    clearDeadline(jobId);
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
