import { v4 as uuidv4 } from 'uuid';
import { FinancialAnalysisResult, FinancialAnalysisInput } from '../types';
import { detectTicker, buildSearchString, fetchAnnualFinancials, fetchQuarterlyFinancials } from './yahooFinance';
import { researchPublicCompanyFinancials, researchPrivateCompany } from './parallelAI';
import { synthesizeFinancialInsights, synthesizePrivateCompany } from './claudeAI';

// ── Helper: parse public/private + ticker from Parallel.AI research text ──────

function parseListingFromResearch(
  text: string
): { isPublic: boolean; ticker: string | null; exchange: string | null } {
  const t = text || '';

  // Signals that clearly indicate a PUBLIC company
  const publicPatterns = [
    /publicly (listed|traded|quoted)/i,
    /listed on (the )?(NYSE|NASDAQ|LSE|NSE|BSE|TSX|ASX|SGX|HKEX)/i,
    /(NYSE|NASDAQ|LSE|NSE):\s*[A-Z]{1,5}/,
    /ticker[:\s]+[A-Z]{1,5}/i,
    /stock (ticker|symbol)[:\s]+[A-Z]{1,5}/i,
    /trades? (under|as)[:\s]+[A-Z]{1,5}/i,
    /\(([A-Z]{2,5})\)\s*(on|at|–|-)\s*(NYSE|NASDAQ|LSE)/i,
  ];

  // Signals that clearly indicate a PRIVATE company
  const privatePatterns = [
    /private(ly)? (held|owned|company|firm)/i,
    /not (publicly|stock) (listed|traded)/i,
    /PE[- ]backed|VC[- ]backed|bootstrapped/i,
    /privately[- ]held/i,
    /not listed on any (stock )?exchange/i,
    /remains private/i,
  ];

  const publicScore = publicPatterns.filter((p) => p.test(t)).length;
  const privateScore = privatePatterns.filter((p) => p.test(t)).length;

  // Require a clear public signal OR at least 2:0 public:private ratio
  const isPublic = publicScore > 0 && publicScore >= privateScore;

  // Extract ticker symbol
  let ticker: string | null = null;
  const tickerPatterns: RegExp[] = [
    /(NYSE|NASDAQ|LSE|NSE|BSE|TSX|ASX):\s*([A-Z]{1,5})\b/,
    /ticker[:\s]+([A-Z]{1,5})\b/i,
    /stock (ticker|symbol)[:\s]+([A-Z]{1,5})\b/i,
    /symbol[:\s]+([A-Z]{1,5})\b/i,
    /trades? under[:\s]+([A-Z]{1,5})\b/i,
    /\(([A-Z]{2,5})\)/, // e.g. "(AAPL)"
  ];

  for (const p of tickerPatterns) {
    const m = t.match(p);
    // Two-group patterns have the ticker in group 2; single-group in group 1
    const candidate = m?.[2] ?? m?.[1];
    if (candidate && /^[A-Z]{1,5}$/.test(candidate)) {
      ticker = candidate;
      break;
    }
  }

  // Extract exchange name
  let exchange: string | null = null;
  if (/NASDAQ/i.test(t)) exchange = 'NASDAQ';
  else if (/NYSE/i.test(t)) exchange = 'NYSE';
  else if (/LSE|London Stock Exchange/i.test(t)) exchange = 'LSE';
  else if (/\bNSE\b/i.test(t)) exchange = 'NSE';
  else if (/\bBSE\b/i.test(t)) exchange = 'BSE';

  return { isPublic, ticker, exchange };
}

// ── In-memory job store ────────────────────────────────────────────────────────

const jobs = new Map<string, FinancialAnalysisResult>();
const JOB_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

// Cleanup stale jobs every 30 minutes
setInterval(() => {
  const cutoff = Date.now() - JOB_TTL_MS;
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

// ── Job helpers ───────────────────────────────────────────────────────────────

function update(jobId: string, patch: Partial<FinancialAnalysisResult>): FinancialAnalysisResult {
  const current = jobs.get(jobId)!;
  const updated = { ...current, ...patch };
  jobs.set(jobId, updated);
  return updated;
}

// ── Public API ─────────────────────────────────────────────────────────────────

export function createFinancialJob(input: FinancialAnalysisInput): string {
  const jobId = uuidv4();
  jobs.set(jobId, {
    jobId,
    status: 'pending',
    progress: 0,
    companyName: input.companyName,
    createdAt: new Date().toISOString(),
  });
  return jobId;
}

export function getFinancialJob(jobId: string): FinancialAnalysisResult | undefined {
  return jobs.get(jobId);
}

// ── Main orchestrator ─────────────────────────────────────────────────────────

export async function runFinancialAnalysis(
  jobId: string,
  input: FinancialAnalysisInput
): Promise<void> {
  try {
    // ── Step 1: Launch Yahoo Finance detection AND Parallel.AI research IN PARALLEL
    // This is the key architectural change: Parallel.AI is now the primary source
    // for both public/private detection AND comprehensive financial data.
    // Yahoo Finance runs simultaneously to provide structured chart arrays.
    let job = update(jobId, {
      status: 'detecting',
      progress: 5,
      currentStep: 'Researching company listing status and financial data…',
    });
    emit(jobId, 'progress', job);

    // Fire both tasks at the same time
    const [yahooDetectResult, parallelResearchResult] = await Promise.allSettled([
      detectTicker(input.companyName, input.companyDomain),
      researchPublicCompanyFinancials(input.companyName, input.companyDomain),
    ]);

    const yahooTicker = yahooDetectResult.status === 'fulfilled' ? yahooDetectResult.value : null;
    const parallelResearch =
      parallelResearchResult.status === 'fulfilled' ? parallelResearchResult.value : '';

    // Parse listing status from Parallel.AI research text
    const parallelListing = parseListingFromResearch(parallelResearch);

    console.log('[financialAnalysis] Yahoo ticker:', yahooTicker);
    console.log('[financialAnalysis] Parallel.AI listing:', parallelListing);

    // Determine final public/private status — priority:
    //   1. User-supplied override (isPublic explicitly set)
    //   2. Yahoo Finance detected a ticker → public
    //   3. Parallel.AI research says public
    //   4. Both say nothing → private
    let isPublic: boolean;
    let ticker: string | undefined;
    let exchange: string | undefined;

    if (input.isPublic !== undefined) {
      isPublic = input.isPublic;
      // Still need ticker even if user said public
      if (isPublic) {
        ticker = yahooTicker?.ticker ?? parallelListing.ticker ?? undefined;
        exchange = yahooTicker?.exchange ?? parallelListing.exchange ?? undefined;
      }
    } else {
      isPublic = !!(yahooTicker || parallelListing.isPublic);
      // Prefer Yahoo ticker (validated against live exchange) over Parallel.AI parse
      ticker = yahooTicker?.ticker ?? (parallelListing.isPublic ? parallelListing.ticker ?? undefined : undefined);
      exchange = yahooTicker?.exchange ?? (parallelListing.isPublic ? parallelListing.exchange ?? undefined : undefined);
    }

    job = update(jobId, { isPublic, ticker, exchange, progress: 30 });
    emit(jobId, 'progress', job);

    // ── PUBLIC PATH ────────────────────────────────────────────────────────────
    if (isPublic) {
      // Step 2: Build the TICKER:EXCHANGE search string for the custom Finance API
      // Then fetch annual + quarterly data in parallel alongside Parallel.AI research
      let apiData: Partial<FinancialAnalysisResult> = {};
      let searchString: string | undefined;

      if (ticker) {
        searchString = buildSearchString(ticker, exchange || '');
        job = update(jobId, {
          status: 'fetching',
          progress: 35,
          currentStep: `Fetching financial data for ${searchString}…`,
        });
        emit(jobId, 'progress', job);

        try {
          // Fetch annual + quarterly in parallel
          const [annualResult, quarterlyResult] = await Promise.allSettled([
            fetchAnnualFinancials(searchString),
            fetchQuarterlyFinancials(searchString),
          ]);

          if (annualResult.status === 'fulfilled') {
            const a = annualResult.value;
            apiData = {
              companyInfo:    a.companyInfo,
              currency:       a.currency,
              revenueHistory: a.revenueHistory,
              marginHistory:  a.marginHistory,
              plStatement:    a.plStatement,
            };
          } else {
            console.error(`[financialAnalysis] Annual API failed for ${searchString}:`, annualResult.reason);
          }

          if (quarterlyResult.status === 'fulfilled') {
            apiData.quarterlyHistory = quarterlyResult.value;
          } else {
            console.error(`[financialAnalysis] Quarterly API failed for ${searchString}:`, quarterlyResult.reason);
          }

          // Stream partial data so charts appear early
          job = update(jobId, { ...apiData, progress: 55 });
          emit(jobId, 'progress', job);
        } catch (err) {
          console.error(`[financialAnalysis] Finance API fetch failed for ${searchString}:`, err);
        }
      }

      // Step 3: Claude synthesis — enriches with segment/geo + key highlights + insights
      // Parallel.AI research text is the source for segment/geo data and narrative context
      job = update(jobId, {
        status: 'synthesizing',
        progress: 65,
        currentStep: 'Synthesising financial insights and extracting chart data…',
      });
      emit(jobId, 'progress', job);

      const insights = await synthesizeFinancialInsights(input, apiData, parallelResearch);

      // Prefer API structured arrays; fall back to Claude-extracted arrays if API returned nothing
      const finalRevenueHistory =
        (apiData.revenueHistory?.length ?? 0) > 0
          ? apiData.revenueHistory
          : insights.revenueHistoryExtracted?.length
            ? insights.revenueHistoryExtracted
            : undefined;

      const finalMarginHistory =
        (apiData.marginHistory?.length ?? 0) > 0
          ? apiData.marginHistory
          : insights.marginHistoryExtracted?.length
            ? insights.marginHistoryExtracted
            : undefined;

      const finalPlStatement =
        (apiData.plStatement?.length ?? 0) > 0
          ? apiData.plStatement
          : insights.plStatementExtracted?.length
            ? insights.plStatementExtracted
            : undefined;

      const finalBalanceSheet =
        (apiData.balanceSheet?.length ?? 0) > 0
          ? apiData.balanceSheet
          : insights.balanceSheetExtracted?.length
            ? insights.balanceSheetExtracted
            : undefined;

      const finalCashFlow =
        (apiData.cashFlow?.length ?? 0) > 0
          ? apiData.cashFlow
          : insights.cashFlowExtracted?.length
            ? insights.cashFlowExtracted
            : undefined;

      const completedAt = new Date().toISOString();
      job = update(jobId, {
        status: 'complete',
        progress: 100,
        currentStep: 'Complete',
        completedAt,
        companyInfo:     apiData.companyInfo,
        currency:        apiData.currency,
        quarterlyHistory: apiData.quarterlyHistory?.length ? apiData.quarterlyHistory : undefined,
        revenueHistory:  finalRevenueHistory,
        marginHistory:   finalMarginHistory,
        plStatement:     finalPlStatement,
        balanceSheet:    finalBalanceSheet,
        cashFlow:        finalCashFlow,
        revenueInsight:  insights.revenueInsight,
        marginInsight:   insights.marginInsight,
        segmentInsight:  insights.segmentInsight,
        geoInsight:      insights.geoInsight,
        plInsight:       insights.plInsight,
        bsInsight:       insights.bsInsight,
        cfInsight:       insights.cfInsight,
        keyHighlights:   insights.keyHighlights,
        segmentRevenue:  insights.segmentRevenue?.length ? insights.segmentRevenue : undefined,
        geoRevenue:      insights.geoRevenue?.length ? insights.geoRevenue : undefined,
      });
      emit(jobId, 'result', job);

    } else {
      // ── PRIVATE PATH ────────────────────────────────────────────────────────
      // Parallel.AI research already ran — pass it to the private synthesizer
      // to avoid a second Parallel.AI call for the same company.
      await runPrivatePath(jobId, input, parallelResearch);
    }

  } catch (err) {
    const message = err instanceof Error ? err.message : 'Analysis failed';
    console.error(`[financialAnalysis] job ${jobId} failed:`, message);
    const job = update(jobId, { status: 'error', error: message });
    emit(jobId, 'error', job);
  }
}

async function runPrivatePath(
  jobId: string,
  input: FinancialAnalysisInput,
  existingResearch: string
): Promise<void> {
  let job = update(jobId, {
    isPublic: false,
    status: 'researching',
    progress: 35,
    currentStep: 'Analysing private company financial profile…',
  });
  emit(jobId, 'progress', job);

  // Reuse the research already gathered in the parallel detection step.
  // Fall back to a targeted private-company search only if the existing research is empty.
  let research = existingResearch;
  if (!research || research.trim().length < 100) {
    job = update(jobId, { currentStep: 'Fetching private company research…' });
    emit(jobId, 'progress', job);
    research = await researchPrivateCompany(input.companyName, input.companyDomain);
  }

  job = update(jobId, { progress: 70, currentStep: 'Synthesising financial estimates…', status: 'synthesizing' });
  emit(jobId, 'progress', job);

  const privateData = await synthesizePrivateCompany(input, research);

  const completedAt = new Date().toISOString();
  job = update(jobId, {
    status: 'complete',
    progress: 100,
    currentStep: 'Complete',
    completedAt,
    estimatedRevenue:    privateData.estimatedRevenue,
    profitabilityMargin: privateData.profitabilityMargin,
    estimatedYoyGrowth:  privateData.estimatedYoyGrowth,
    fundingInfo:         privateData.fundingInfo,
    lastValuation:       privateData.lastValuation,
    privateInsights:     privateData.privateInsights,
  });
  emit(jobId, 'result', job);
}
