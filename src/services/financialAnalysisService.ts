import { v4 as uuidv4 } from 'uuid';
import { FinancialAnalysisResult, FinancialAnalysisInput } from '@ai-insights/types';
import { detectTicker, buildSearchString, fetchAnnualFinancials, fetchQuarterlyFinancials, fetchYahooQuoteSummaryFinancials, companyIdentityConfirmed } from './yahooFinance';
import { researchPrivateCompany, researchCompanySegments, isImplausibleNativeAmount, LAKH_CRORE_CURRENCIES } from './parallelAI';
import { synthesizeFinancialInsights, synthesizePrivateCompany, claudeLookupTicker, generateBusinessDescription } from './claudeAI';

// ── In-memory job store ────────────────────────────────────────────────────────

const jobs = new Map<string, FinancialAnalysisResult>();
const JOB_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

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
//   PUBLIC  → detectTicker (Yahoo Finance) → Yahoo quoteSummary → Puppeteer scraper
//             → Claude synthesis
//   PRIVATE → Parallel.AI research → Claude synthesis

export async function runFinancialAnalysis(
  jobId: string,
  input: FinancialAnalysisInput
): Promise<void> {
  try {
    // ── Step 1: Ticker detection ───────────────────────────────────────────────
    let job = update(jobId, {
      status: 'detecting',
      progress: 10,
      currentStep: `Searching for ${input.companyName} on Yahoo Finance…`,
    });
    emit(jobId, 'progress', job);

    let isPublic: boolean;
    let ticker: string | undefined;
    let exchange: string | undefined;

    if (input.isPublic === false) {
      isPublic = false;
    } else {
      // Yahoo Finance ticker search (handles brand names, domain hints, global exchanges)
      let tickerResult = await detectTicker(input.companyName, input.companyDomain).catch(() => null);
      console.log('[financialAnalysis] Yahoo detectTicker result:', JSON.stringify(tickerResult));

      // Last resort: ask Claude (knows brand→ticker mappings for LATAM/niche companies)
      if (!tickerResult) {
        console.log('[financialAnalysis] Yahoo found nothing — trying Claude lookup');
        const claudeTicker = await claudeLookupTicker(input.companyName, input.companyDomain).catch(() => null);
        if (claudeTicker) {
          tickerResult = claudeTicker;
          console.log('[financialAnalysis] Claude resolved ticker:', claudeTicker.ticker, 'on', claudeTicker.exchange);
        }
      }

      if (input.isPublic === true) {
        isPublic = true;
        ticker   = tickerResult?.ticker;
        exchange = tickerResult?.exchange;
      } else {
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
// 1. yahoo-finance2 quoteSummary (primary — fast, global)
// 2. Puppeteer scraper via Google Finance (fallback for tickers quoteSummary can't serve)
// 3. Claude synthesis (enriches with segment/geo insights from training + Parallel.AI)

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
      ? `Fetching financial data for ${ticker} via Yahoo Finance…`
      : `Fetching financial data for ${input.companyName}…`,
  });
  emit(jobId, 'progress', job);

  let apiData: Partial<FinancialAnalysisResult> = {};
  let segmentContext = '';

  if (ticker) {
    // ── Primary: yahoo-finance2 quoteSummary ───────────────────────────────────
    let dataSource: 'Yahoo Finance' | 'Google Finance' | undefined;
    try {
      console.log('[financialAnalysis] Trying yahoo-finance2 quoteSummary for:', ticker);
      const qs = await fetchYahooQuoteSummaryFinancials(ticker);
      if (qs.revenueHistory.length > 0) {
        apiData = {
          companyInfo:      qs.companyInfo,
          currency:         qs.currency,
          revenueHistory:   qs.revenueHistory,
          marginHistory:    qs.marginHistory,
          plStatement:      qs.plStatement,
          balanceSheet:     qs.balanceSheet,
          cashFlow:         qs.cashFlow,
          quarterlyHistory: qs.quarterlyHistory,
        };
        dataSource = 'Yahoo Finance';
        console.log('[financialAnalysis] yahoo-finance2 quoteSummary succeeded:', qs.revenueHistory.length, 'years');
      }
    } catch (err) {
      console.warn('[financialAnalysis] yahoo-finance2 quoteSummary failed:', err instanceof Error ? err.message : err);
    }

    // ── Fallback / backfill: Puppeteer scraper (Google Finance) ────────────────
    // Runs whenever Yahoo failed outright OR left specific fields empty (e.g.
    // revenue came through but quarterly didn't) — merges in only the missing
    // pieces rather than discarding whatever Yahoo did successfully return.
    const needsRevenue   = !apiData.revenueHistory?.length;
    const needsQuarterly = !apiData.quarterlyHistory?.length;
    if (needsRevenue || needsQuarterly) {
      const searchString = buildSearchString(ticker, exchange || '');
      console.log('[financialAnalysis] Google Finance backfill (needsRevenue:', needsRevenue, ', needsQuarterly:', needsQuarterly, '), search string:', searchString);

      const [annualResult, quarterlyResult] = await Promise.allSettled([
        needsRevenue ? fetchAnnualFinancials(searchString) : Promise.resolve(null),
        needsQuarterly ? fetchQuarterlyFinancials(searchString) : Promise.resolve(null),
      ]);

      if (needsRevenue && annualResult.status === 'fulfilled' && annualResult.value) {
        const a = annualResult.value;
        apiData = {
          ...apiData,
          companyInfo:    apiData.companyInfo    ?? a.companyInfo,
          currency:       apiData.currency        ?? a.currency,
          revenueHistory: a.revenueHistory,
          marginHistory:  a.marginHistory,
          plStatement:    apiData.plStatement     ?? a.plStatement,
        };
        dataSource = dataSource ?? 'Google Finance';
      } else if (needsRevenue) {
        console.error('[financialAnalysis] Google Finance annual backfill failed:', annualResult.status === 'rejected' ? annualResult.reason : 'no data');
      }

      if (needsQuarterly && quarterlyResult.status === 'fulfilled' && quarterlyResult.value) {
        apiData.quarterlyHistory = quarterlyResult.value;
      } else if (needsQuarterly) {
        console.warn('[financialAnalysis] Google Finance quarterly backfill failed:', quarterlyResult.status === 'rejected' ? quarterlyResult.reason : 'no data');
      }
    }

    if (dataSource) apiData.dataSource = dataSource;

    // ── Segment/geo research via Parallel.AI (non-blocking) ───────────────────
    // Runs when Yahoo doesn't provide segment breakdown (which is almost always)
    try {
      const currency = apiData.currency || 'USD';
      const segResearch = await researchCompanySegments(input.companyName, ticker, currency);
      if (segResearch && segResearch.trim().length > 50) {
        segmentContext = `\n### Segment & Geographic Revenue Research\n${segResearch}\n`;
        console.log('[financialAnalysis] Segment/geo research retrieved via Parallel.AI for:', ticker);
      }
    } catch (err) {
      console.warn('[financialAnalysis] Segment research failed (non-blocking):', err instanceof Error ? err.message : err);
    }

    // Stream partial data so charts render while Claude synthesises
    job = update(jobId, { ...apiData, progress: 55 });
    emit(jobId, 'progress', job);
  } else {
    console.warn('[financialAnalysis] No ticker found — proceeding to Claude synthesis with empty data');
  }

  // ── Ticker validation gate ─────────────────────────────────────────────────
  const hasMeaningfulData   = (apiData.revenueHistory?.some((r) => r.revenue && r.revenue !== 0)) ?? false;
  // Checks the fetched name actually matches the requested company, not just
  // that some name field is present — a hallucinated ticker (Claude is the
  // last-resort source above) can resolve to a real, unrelated company whose
  // data would otherwise sail through this gate as "confirmed". Prefers
  // domain-vs-domain comparison when available (see companyIdentityConfirmed)
  // since fuzzy name matching alone cannot distinguish two different
  // companies that share a name/prefix (e.g. "Croma" the Indian retailer vs.
  // "Croma Security Solutions Group plc", an unrelated UK firm).
  //
  // Only skip this check when the fetched profile carries no name/website at
  // all to compare against (companyIdentityConfirmed then has nothing to
  // check and would otherwise reject every quoteSummary-only response that
  // never populated companyInfo) — NOT based on hasMeaningfulData. A wrong
  // ticker that happens to resolve to a real, unrelated, revenue-reporting
  // company is the common case this exists to catch (e.g. "Croma" the Indian
  // retailer resolving to "Croma Security Solutions Group plc" — that ticker
  // has perfectly real, populated financials, just for the wrong company),
  // and hasMeaningfulData is true for exactly that case, so gating on it
  // let wrong-but-populated tickers straight through.
  const hasProfileToCheck = !!(apiData.companyInfo?.name || apiData.companyInfo?.website);
  const profileConfirmsName = companyIdentityConfirmed({
    requestedName: input.companyName,
    requestedDomain: input.companyDomain,
    fetchedName: apiData.companyInfo?.name,
    fetchedWebsite: apiData.companyInfo?.website,
  });
  if (ticker && hasProfileToCheck && !profileConfirmsName && input.isPublic !== true) {
    console.warn(`[financialAnalysis] Ticker ${ticker} resolved to "${apiData.companyInfo?.name}" which does not match requested company "${input.companyName}" — falling back to private path`);
    apiData = {};
    segmentContext = '';
    const job0 = update(jobId, { isPublic: false, ticker: undefined, exchange: undefined, companyInfo: undefined, revenueHistory: undefined, marginHistory: undefined, plStatement: undefined, balanceSheet: undefined, cashFlow: undefined, quarterlyHistory: undefined });
    emit(jobId, 'progress', job0);
    return runPrivatePath(jobId, input);
  }
  if (ticker && !hasMeaningfulData && !hasProfileToCheck && input.isPublic !== true) {
    console.warn(`[financialAnalysis] Ticker ${ticker} resolved but yielded no meaningful financial data — falling back to private path`);
    const job0 = update(jobId, { isPublic: false, ticker: undefined, exchange: undefined });
    emit(jobId, 'progress', job0);
    return runPrivatePath(jobId, input);
  }

  // ── Claude synthesis ───────────────────────────────────────────────────────
  job = update(jobId, {
    status: 'synthesizing',
    progress: 60,
    currentStep: 'Synthesising financial insights with AI…',
  });
  emit(jobId, 'progress', job);

  const insights = await synthesizeFinancialInsights(input, apiData, segmentContext, (accumulated) => {
    const synthProgress = Math.min(95, 60 + Math.floor((accumulated.length / 5000) * 35));
    const j = update(jobId, { progress: synthProgress });
    emit(jobId, 'progress', j);
  });

  // Claude free-extracts revenueHistoryExtracted from research text only when
  // Yahoo/Google Finance returned nothing — for lakh/crore-numbering
  // currencies (INR, NPR, PKR, BDT, LKR) this is exactly the failure mode
  // already guarded against in the private-company path (parallelAI.ts's
  // isImplausibleNativeAmount): a bare number stated without its magnitude
  // unit reads as a wildly wrong revenue figure. Apply the same check here —
  // one implausible year in the extracted array is enough to distrust the
  // whole array's unit handling, so drop it entirely rather than show a mix
  // of possibly-right and definitely-wrong figures.
  const extractedCurrency = (apiData.currency || 'USD').toUpperCase();
  let revenueHistoryExtracted = insights.revenueHistoryExtracted;
  if (revenueHistoryExtracted?.length && LAKH_CRORE_CURRENCIES.has(extractedCurrency)) {
    const hasImplausible = revenueHistoryExtracted.some((r) => isImplausibleNativeAmount(r.revenue, extractedCurrency));
    if (hasImplausible) {
      console.warn(`[financialAnalysis] Discarding Claude-extracted revenueHistory for ${input.companyName} — implausible ${extractedCurrency} magnitude (likely missing Lakh/Crore unit)`);
      revenueHistoryExtracted = undefined;
    }
  }

  // Prefer API-sourced structured arrays; fall back to Claude-extracted arrays
  const finalRevenueHistory =
    (apiData.revenueHistory?.length ?? 0) > 0
      ? apiData.revenueHistory
      : revenueHistoryExtracted?.length ? revenueHistoryExtracted : undefined;

  const finalMarginHistory =
    (apiData.marginHistory?.length ?? 0) > 0
      ? apiData.marginHistory
      : insights.marginHistoryExtracted?.length ? insights.marginHistoryExtracted : undefined;

  const finalPlStatement =
    (apiData.plStatement?.length ?? 0) > 0
      ? apiData.plStatement
      : insights.plStatementExtracted?.length ? insights.plStatementExtracted : undefined;

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
    dataSource:      apiData.dataSource ?? 'Yahoo Finance',
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
    geoRevenue:      insights.geoRevenue?.length ? insights.geoRevenue : undefined,
  });
  emit(jobId, 'result', job);
}

// ── Private path ───────────────────────────────────────────────────────────────

async function runPrivatePath(
  jobId: string,
  input: FinancialAnalysisInput
): Promise<void> {
  let job = update(jobId, {
    isPublic:    false,
    status:      'researching',
    progress:    15,
    currentStep: `Verifying ${input.companyName}'s identity at ${input.companyDomain}…`,
  });
  emit(jobId, 'progress', job);

  // Verify company identity FIRST, rooted in the domain, before researching financials.
  // Company names are frequently shared by unrelated businesses — pure company-name
  // research/synthesis without an anchored identity check has previously returned
  // financials for the wrong company entirely.
  let verifiedDescription = '';
  try {
    verifiedDescription = await generateBusinessDescription(input.companyName, input.companyDomain);
    if (verifiedDescription.includes('No business description can be ascertained')) {
      verifiedDescription = '';
    }
  } catch (err) {
    console.warn('[financialAnalysis] Identity verification failed, proceeding without it:', err);
  }

  job = update(jobId, {
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

  const privateData = await synthesizePrivateCompany(input, research, verifiedDescription, (accumulated) => {
    const synthProgress = Math.min(95, 70 + Math.floor((accumulated.length / 4000) * 25));
    const j = update(jobId, { progress: synthProgress });
    emit(jobId, 'progress', j);
  });

  const completedAt = new Date().toISOString();
  job = update(jobId, {
    status:              'complete',
    progress:            100,
    currentStep:         'Complete',
    completedAt,
    dataSource:          'Parallel.AI',
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

// ── Job manager for error handling utilities ──────────────────────────────────

export function getJobManager() {
  return {
    updateJob: update,
    emit,
    getJob: getFinancialJob,
  };
}
