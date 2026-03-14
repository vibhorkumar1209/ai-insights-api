import { v4 as uuidv4 } from 'uuid';
import { FinancialAnalysisResult, FinancialAnalysisInput } from '../types';
import { detectTicker, buildSearchString, fetchAnnualFinancials, fetchQuarterlyFinancials } from './yahooFinance';
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
      const tickerResult = await detectTicker(input.companyName, input.companyDomain).catch(() => null);
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
      ? `Fetching annual & quarterly financial data for ${buildSearchString(ticker, exchange || '')}…`
      : `Fetching financial data for ${input.companyName}…`,
  });
  emit(jobId, 'progress', job);

  let apiData: Partial<FinancialAnalysisResult> = {};

  if (ticker) {
    const searchString = buildSearchString(ticker, exchange || '');
    console.log('[financialAnalysis] Finance API search string:', searchString);

    // Fetch annual and quarterly data in parallel
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
      console.error('[financialAnalysis] Annual Finance API failed:', annualResult.reason);
    }

    if (quarterlyResult.status === 'fulfilled') {
      apiData.quarterlyHistory = quarterlyResult.value;
    } else {
      console.error('[financialAnalysis] Quarterly Finance API failed:', quarterlyResult.reason);
    }

    // Stream partial data so charts render while Claude synthesises
    job = update(jobId, { ...apiData, progress: 55 });
    emit(jobId, 'progress', job);
  } else {
    console.warn('[financialAnalysis] No ticker found — proceeding to Claude synthesis with empty Finance API data');
  }

  // ── Step 2: Claude synthesis ─────────────────────────────────────────────────
  // Pass empty parallelResearch — Claude uses Finance API data + training knowledge.
  // Segment/geo breakdown comes from Claude training data where available.
  job = update(jobId, {
    status: 'synthesizing',
    progress: 60,
    currentStep: 'Synthesising financial insights with AI…',
  });
  emit(jobId, 'progress', job);

  const insights = await synthesizeFinancialInsights(input, apiData, '');

  // Prefer Finance API structured arrays; fall back to Claude-extracted arrays
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

  const finalBalanceSheet =
    insights.balanceSheetExtracted?.length ? insights.balanceSheetExtracted : undefined;

  const finalCashFlow =
    insights.cashFlowExtracted?.length ? insights.cashFlowExtracted : undefined;

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
    keyHighlights:   insights.keyHighlights,
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
    estimatedRevenue:    privateData.estimatedRevenue,
    profitabilityMargin: privateData.profitabilityMargin,
    estimatedYoyGrowth:  privateData.estimatedYoyGrowth,
    fundingInfo:         privateData.fundingInfo,
    lastValuation:       privateData.lastValuation,
    privateInsights:     privateData.privateInsights,
  });
  emit(jobId, 'result', job);
}
