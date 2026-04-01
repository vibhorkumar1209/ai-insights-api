import { v4 as uuidv4 } from 'uuid';
import { FinancialAnalysisResult, FinancialAnalysisInput } from '../types';
import { detectTicker, buildSearchString, fetchAnnualFinancials, fetchQuarterlyFinancials } from './yahooFinance';
import {
  fmpSearchTicker, fmpFetchProfile, fmpFetchIncomeStatement,
  fmpFetchBalanceSheet, fmpFetchCashFlow, fmpFetchQuarterly,
} from './fmpFinance';
import { researchPrivateCompany } from './parallelAI';
import { synthesizeFinancialInsights, synthesizePrivateCompany } from './claudeAI';

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

// ── Main orchestrator ──────────────────────────────────────────────────────────
// Flow:
//   PUBLIC  → detectTicker (Yahoo Finance, fast) → Finance API annual + quarterly
//             (parallel, up to 60 s each) → Claude synthesis
//   PRIVATE → Parallel.AI research (up to 3 min) → Claude synthesis
//
// Parallel.AI is NOT called on the public path, keeping public-company
// analysis under ~3 minutes total.

export async function runFinancialAnalysis(
  jobId: string,
  input: FinancialAnalysisInput
): Promise<void> {
  try {
    // ── Step 1: Ticker detection ───────────────────────────────────────────────
    let job = update(jobId, {
      status: 'detecting',
      progress: 10,
      currentStep: `Searching for ${input.companyName} on Google Finance…`,
    });
    emit(jobId, 'progress', job);

    let isPublic: boolean;
    let ticker: string | undefined;
    let exchange: string | undefined;

    if (input.isPublic === false) {
      // User explicitly forced private — skip ticker lookup
      isPublic = false;
    } else {
      // Try FMP ticker search first, then Yahoo Finance as fallback
      let fmpTicker: string | null = null;
      try {
        fmpTicker = await fmpSearchTicker(input.companyName);
        if (fmpTicker) console.log('[financialAnalysis] FMP ticker found:', fmpTicker);
      } catch (err) {
        console.warn('[financialAnalysis] FMP ticker search failed, trying Yahoo:', err);
      }

      const tickerResult = fmpTicker
        ? { ticker: fmpTicker, exchange: '' }
        : await detectTicker(input.companyName, input.companyDomain).catch(() => null);
      console.log('[financialAnalysis] ticker detection result:', tickerResult);

      if (input.isPublic === true) {
        // User forced public — accept even if ticker not found
        isPublic = true;
        ticker   = tickerResult?.ticker;
        exchange = tickerResult?.exchange;
      } else {
        // Auto-detect: public iff a ticker was found
        isPublic = !!tickerResult;
        ticker   = tickerResult?.ticker;
        exchange = tickerResult?.exchange;
      }
    }

    job = update(jobId, { isPublic, ticker, exchange, progress: 20 });
    emit(jobId, 'progress', job);

    if (isPublic) {
      await runPublicPath(jobId, input, ticker, exchange);
    } else {
      await runPrivatePath(jobId, input);
    }

  } catch (err) {
    const message = err instanceof Error ? err.message : 'Analysis failed';
    console.error(`[financialAnalysis] job ${jobId} failed:`, message);
    const job = update(jobId, { status: 'error', error: message });
    emit(jobId, 'error', job);
  }
}

// ── Public path ────────────────────────────────────────────────────────────────
// 1. Call Finance API annual + quarterly in parallel (up to 60 s each)
// 2. Synthesise with Claude (Finance API data + training knowledge for segment/geo)

async function runPublicPath(
  jobId: string,
  input: FinancialAnalysisInput,
  ticker: string | undefined,
  exchange: string | undefined
): Promise<void> {
  let job = update(jobId, {
    status: 'fetching',
    progress: 25,
    currentStep: ticker
      ? `Fetching financial data for ${ticker} via FMP…`
      : `Fetching financial data for ${input.companyName}…`,
  });
  emit(jobId, 'progress', job);

  let apiData: Partial<FinancialAnalysisResult> = {};
  let usedFMP = false;

  if (ticker) {
    // ── Primary: FMP (Financial Modeling Prep) ──────────────────────────────────
    console.log('[financialAnalysis] Trying FMP as primary source for:', ticker);
    const [fmpProfile, fmpIncome, fmpBS, fmpCF, fmpQuarterly] = await Promise.allSettled([
      fmpFetchProfile(ticker),
      fmpFetchIncomeStatement(ticker, 5),
      fmpFetchBalanceSheet(ticker),
      fmpFetchCashFlow(ticker),
      fmpFetchQuarterly(ticker),
    ]);

    const profileData   = fmpProfile.status === 'fulfilled' ? fmpProfile.value : null;
    const incomeData    = fmpIncome.status === 'fulfilled' ? fmpIncome.value : null;
    const bsData        = fmpBS.status === 'fulfilled' ? fmpBS.value : null;
    const cfData        = fmpCF.status === 'fulfilled' ? fmpCF.value : null;
    const quarterlyData = fmpQuarterly.status === 'fulfilled' ? fmpQuarterly.value : null;

    // FMP is considered successful if we got at least income statement data
    if (incomeData) {
      usedFMP = true;
      console.log('[financialAnalysis] FMP data retrieved successfully');
      apiData = {
        companyInfo:     profileData?.companyInfo,
        currency:        incomeData.currency || profileData?.currency || 'USD',
        revenueHistory:  incomeData.revenueHistory,
        marginHistory:   incomeData.marginHistory,
        plStatement:     incomeData.plStatement,
        balanceSheet:    bsData || undefined,
        cashFlow:        cfData || undefined,
        quarterlyHistory: quarterlyData?.quarterly,
      };
    } else {
      console.warn('[financialAnalysis] FMP income statement empty — falling back to Yahoo Finance');
    }

    // ── Fallback: Yahoo Finance ────────────────────────────────────────────────
    if (!usedFMP) {
      const searchString = buildSearchString(ticker, exchange || '');
      console.log('[financialAnalysis] Yahoo Finance fallback, search string:', searchString);

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
        console.error('[financialAnalysis] Yahoo Finance annual fetch failed:', annualResult.reason);
      }

      if (quarterlyResult.status === 'fulfilled') {
        apiData.quarterlyHistory = quarterlyResult.value;
      } else {
        console.error('[financialAnalysis] Yahoo Finance quarterly fetch failed:', quarterlyResult.reason);
      }
    }

    // Stream partial data so charts render while Claude synthesises
    job = update(jobId, { ...apiData, progress: 55 });
    emit(jobId, 'progress', job);
  } else {
    console.warn('[financialAnalysis] No ticker found — proceeding to Claude synthesis with empty data');
  }

  // ── Step 2: Claude synthesis ─────────────────────────────────────────────────
  // When FMP provided BS/CF, pass them through so Claude knows not to extract.
  // Claude uses Finance API data + training knowledge for segments/geo.
  job = update(jobId, {
    status: 'synthesizing',
    progress: 60,
    currentStep: 'Synthesising financial insights with AI…',
  });
  emit(jobId, 'progress', job);

  const insights = await synthesizeFinancialInsights(input, apiData, '');

  // Prefer API-sourced structured arrays; fall back to Claude-extracted arrays
  const finalRevenueHistory =
    (apiData.revenueHistory?.length ?? 0) > 0
      ? apiData.revenueHistory
      : insights.revenueHistoryExtracted?.length ? insights.revenueHistoryExtracted : undefined;

  const finalMarginHistory =
    (apiData.marginHistory?.length ?? 0) > 0
      ? apiData.marginHistory
      : insights.marginHistoryExtracted?.length ? insights.marginHistoryExtracted : undefined;

  const finalPlStatement =
    (apiData.plStatement?.length ?? 0) > 0
      ? apiData.plStatement
      : insights.plStatementExtracted?.length ? insights.plStatementExtracted : undefined;

  // For BS/CF: FMP provides these directly; Claude is fallback only
  const finalBalanceSheet =
    (apiData.balanceSheet?.length ?? 0) > 0
      ? apiData.balanceSheet
      : insights.balanceSheetExtracted?.length ? insights.balanceSheetExtracted : undefined;

  const finalCashFlow =
    (apiData.cashFlow?.length ?? 0) > 0
      ? apiData.cashFlow
      : insights.cashFlowExtracted?.length ? insights.cashFlowExtracted : undefined;

  const completedAt = new Date().toISOString();
  job = update(jobId, {
    status:          'complete',
    progress:        100,
    currentStep:     'Complete',
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
    keyHighlights:      insights.keyHighlights,
    chartInsights:      insights.chartInsights?.length ? insights.chartInsights : undefined,
    geoSegmentInsights: insights.geoSegmentInsights?.length ? insights.geoSegmentInsights : undefined,
    segmentRevenue:  insights.segmentRevenue?.length ? insights.segmentRevenue : undefined,
    geoRevenue:      insights.geoRevenue?.length     ? insights.geoRevenue     : undefined,
  });
  emit(jobId, 'result', job);
}

// ── Private path ───────────────────────────────────────────────────────────────
// 1. Parallel.AI research (Crunchbase / Tracxn / LinkedIn / news)
// 2. Claude synthesis → estimated revenue, margins, funding info

async function runPrivatePath(
  jobId: string,
  input: FinancialAnalysisInput
): Promise<void> {
  let job = update(jobId, {
    isPublic:    false,
    status:      'researching',
    progress:    25,
    currentStep: `Researching ${input.companyName}'s financial profile via Parallel.AI…`,
  });
  emit(jobId, 'progress', job);

  let research = '';
  try {
    research = await researchPrivateCompany(input.companyName, input.companyDomain);
  } catch (err) {
    console.error('[financialAnalysis] Private research failed:', err);
  }

  job = update(jobId, {
    status:      'synthesizing',
    progress:    70,
    currentStep: 'Synthesising financial estimates with AI…',
  });
  emit(jobId, 'progress', job);

  const privateData = await synthesizePrivateCompany(input, research);

  const completedAt = new Date().toISOString();
  job = update(jobId, {
    status:              'complete',
    progress:            100,
    currentStep:         'Complete',
    completedAt,
    estimatedRevenue:     privateData.estimatedRevenue,
    profitabilityMargin:  privateData.profitabilityMargin,
    estimatedYoyGrowth:   privateData.estimatedYoyGrowth,
    fundingInfo:          privateData.fundingInfo,
    lastValuation:        privateData.lastValuation,
    privateInsights:      privateData.privateInsights,
    privateKeyHighlights: privateData.privateKeyHighlights,
  });
  emit(jobId, 'result', job);
}
