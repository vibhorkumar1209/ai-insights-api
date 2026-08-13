import { v4 as uuidv4 } from 'uuid';
import { FirmographicInput, FirmographicResult } from '@ai-insights/types';
import { detectTicker, fetchAnnualFinancials, fetchYahooQuoteSummaryFinancials, buildSearchString, formatRevenueUSD, companyIdentityConfirmed } from './yahooFinance';
import { claudeLookupTicker } from './claudeAI';
import { geminiRevenueLookup, geminiFirmographicLookup } from './parallelAI';

// ── In-memory job store ────────────────────────────────────────────────────────

const jobs = new Map<string, FirmographicResult>();

setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
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

function update(jobId: string, patch: Partial<FirmographicResult>): FirmographicResult {
  const current = jobs.get(jobId)!;
  const updated = { ...current, ...patch };
  jobs.set(jobId, updated);
  return updated;
}

// ── Public API ─────────────────────────────────────────────────────────────────

export function createFirmographicJob(input: FirmographicInput): string {
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

export function getFirmographicJob(jobId: string): FirmographicResult | undefined {
  return jobs.get(jobId);
}

// ── Firmographic enrichment (founded year, HQ, employees, website, LinkedIn) ──
// Runs after revenue is resolved, regardless of which source produced it.

async function enrichAndComplete(
  jobId: string,
  input: FirmographicInput,
  revenueFields: Partial<FirmographicResult>
): Promise<void> {
  let job = update(jobId, {
    ...revenueFields,
    status: 'enriching',
    progress: 85,
    currentStep: `Researching ${input.companyName}'s company profile…`,
  });
  emit(jobId, 'progress', job);

  const firmographic = await geminiFirmographicLookup(input.companyName, input.companyDomain).catch(() => null);

  job = update(jobId, {
    status:               'complete',
    progress:             100,
    currentStep:          'Complete',
    completedAt:          new Date().toISOString(),
    foundedYear:          firmographic?.foundedYear,
    headquartersCity:     firmographic?.headquartersCity,
    headquartersState:    firmographic?.headquartersState,
    headquartersCountry:  firmographic?.headquartersCountry,
    employeeRange:        firmographic?.employeeRange,
    website:              firmographic?.website,
    linkedinUrl:          firmographic?.linkedinUrl,
    firmographicSource:   firmographic?.source,
  });
  emit(jobId, 'result', job);
}

// ── Main runner ────────────────────────────────────────────────────────────────

export async function runFirmographicJob(jobId: string, input: FirmographicInput): Promise<void> {
  try {
    // Step 1: Ticker detection — Yahoo (detectTicker) first, Claude as fallback.
    // Previously this was Claude-first "to skip yahoo-finance2 (rate-limited)",
    // but that made this module diverge from financialAnalysisService.ts (which
    // has always tried Yahoo first) in a way that silently broke it: Claude's
    // ticker lookup is an unverified LLM guess with no confirmation step, and
    // for "Tata Consumer Product" it hallucinated "TATACONSUMER.NS" (does not
    // exist — the real ticker is "TATACONSUM.NS"), so every downstream fetch
    // failed and the module reported no revenue at all, while Financial
    // Analysis — trying Yahoo first — resolved the correct ticker immediately
    // and returned full financials for the same company. Matching the order
    // used there fixes this class of failure and also makes the two modules
    // resolve to the same ticker (and therefore the same revenue figures,
    // since both call the same fetchYahooQuoteSummaryFinancials/
    // fetchAnnualFinancials functions once a ticker is known).
    let job = update(jobId, {
      status: 'detecting',
      progress: 20,
      currentStep: `Looking up ${input.companyName}…`,
    });
    emit(jobId, 'progress', job);

    let tickerResult = await detectTicker(input.companyName, input.companyDomain).catch(() => null);

    // Claude as fallback — doesn't hit Yahoo's crumb endpoint, so it's a
    // useful last resort if Yahoo's search genuinely has nothing, but its
    // guess is unverified and should not be tried first.
    if (!tickerResult) {
      tickerResult = await claudeLookupTicker(input.companyName, input.companyDomain).catch(() => null);
    }

    const ticker   = tickerResult?.ticker;
    const exchange = tickerResult?.exchange;
    const isPublic = !!tickerResult;

    job = update(jobId, { ticker, exchange, isPublic, progress: 40 });
    emit(jobId, 'progress', job);

    if (isPublic && ticker) {
      // Step 2: Fetch revenue from Yahoo Finance or Google Finance
      job = update(jobId, {
        status: 'fetching',
        progress: 55,
        currentStep: `Fetching revenue for ${ticker} from Yahoo Finance…`,
      });
      emit(jobId, 'progress', job);

      // Try Yahoo Finance (yahoo-finance2 quoteSummary) first.
      const yahooData = await fetchYahooQuoteSummaryFinancials(ticker).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[firmographic] Yahoo Finance failed for ${ticker} (${msg}) — trying Google Finance`);
        return null;
      });

      let data = yahooData;
      let source: 'Yahoo Finance' | 'Google Finance' = 'Yahoo Finance';

      // Fall back to Google Finance (Puppeteer scraper) if Yahoo has no data.
      if (!data || data.revenueHistory.length === 0) {
        job = update(jobId, {
          currentStep: `Fetching revenue for ${ticker} from Google Finance…`,
        });
        emit(jobId, 'progress', job);

        const searchStr = buildSearchString(ticker, tickerResult?.exchange || '');
        data = await fetchAnnualFinancials(searchStr).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[firmographic] Google Finance failed for ${ticker} (${msg}) — falling back to Gemini search`);
          return null;
        });
        source = 'Google Finance';
      }

      // Verify the fetched company actually matches the request before trusting
      // its financials. claudeLookupTicker (the primary ticker source, tried
      // first above) carries no built-in verification — it's an LLM guess — so
      // without this check a hallucinated or wrong-company ticker would silently
      // surface someone else's real revenue/margins as if they were the
      // requested company's. Prefers domain-vs-domain comparison (authoritative,
      // effectively zero false-positive risk) over fuzzy name matching, which
      // cannot distinguish two different companies sharing a name/prefix — e.g.
      // "Croma" (the Tata-owned Indian electronics retailer) is a literal prefix
      // of "Croma Security Solutions Group plc" (an unrelated UK firm), so name
      // matching alone accepted it every time; comparing croma.com against the
      // fetched company's own disclosed website closes that off. If it doesn't
      // match, discard and fall through to the Gemini search fallback below,
      // which searches by name (and domain, when provided) directly.
      if (data?.companyInfo?.name && !companyIdentityConfirmed({
        requestedName: input.companyName,
        requestedDomain: input.companyDomain,
        fetchedName: data.companyInfo.name,
        fetchedWebsite: data.companyInfo.website,
      })) {
        console.warn(`[firmographic] Fetched company "${data.companyInfo.name}" (${data.companyInfo.website || 'no website'}) for ticker ${ticker} doesn't match requested "${input.companyName}" (${input.companyDomain || 'no domain'}) — discarding and falling back to Gemini search`);
        data = null;
      }

      const history = data?.revenueHistory ?? [];

      if (history.length > 0) {
        const latest   = history[history.length - 1];
        const previous = history.length > 1 ? history[history.length - 2] : undefined;

        await enrichAndComplete(jobId, input, {
          dataSource:      source,
          companyInfo:     data?.companyInfo,
          currency:        data?.currency,
          latestRevenue:   formatRevenueUSD(latest.revenue, data?.currency),
          latestRevenueRaw: latest.revenue,
          revenueYear:     latest.year,
          yoyGrowth:       latest.yoyGrowth,
          previousRevenue: previous ? formatRevenueUSD(previous.revenue, data?.currency) : undefined,
          previousYear:    previous?.year,
        });
        return;
      }
    }

    // Fallback: neither Yahoo Finance nor Google Finance had data (or this is a
    // private company) — search for the revenue figure using Gemini (Google Search grounding).
    job = update(jobId, {
      status: 'fetching',
      progress: 60,
      currentStep: `Searching for ${input.companyName}'s revenue via Google Search…`,
    });
    emit(jobId, 'progress', job);

    const geminiResult = await geminiRevenueLookup(input.companyName, input.companyDomain, isPublic);

    if (!geminiResult) {
      job = update(jobId, {
        status: 'error',
        error: `Could not find a verifiable revenue figure for ${input.companyName}.`,
      });
      emit(jobId, 'error', job);
      return;
    }

    await enrichAndComplete(jobId, input, {
      dataSource:      'Google Search (Gemini)',
      latestRevenue:   geminiResult.latestRevenue,
      revenueYear:     geminiResult.revenueYear,
      currency:        geminiResult.currency,
      yoyGrowth:       geminiResult.yoyGrowth,
      previousRevenue: geminiResult.previousRevenue,
      previousYear:    geminiResult.previousYear,
    });

  } catch (err) {
    const message = err instanceof Error ? err.message : 'Firmographic lookup failed';
    console.error(`[firmographic] job ${jobId} failed:`, message);
    const job = update(jobId, { status: 'error', error: message });
    emit(jobId, 'error', job);
  }
}
