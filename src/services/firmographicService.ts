import { v4 as uuidv4 } from 'uuid';
import { FirmographicInput, FirmographicResult } from '@ai-insights/types';
import { detectTicker, fetchAnnualFinancials, fetchYahooQuoteSummaryFinancials, buildSearchString } from './yahooFinance';
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
    // Step 1: Ticker detection — skip yahoo-finance2 (rate-limited), go straight to Claude
    let job = update(jobId, {
      status: 'detecting',
      progress: 20,
      currentStep: `Looking up ${input.companyName}…`,
    });
    emit(jobId, 'progress', job);

    // Claude lookup doesn't hit Yahoo's crumb endpoint
    let tickerResult = await claudeLookupTicker(input.companyName, input.companyDomain).catch(() => null);

    // Only try detectTicker (yahoo-finance2) as last resort if Claude couldn't find it
    if (!tickerResult) {
      tickerResult = await detectTicker(input.companyName, input.companyDomain).catch(() => null);
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

      const history = data?.revenueHistory ?? [];

      if (history.length > 0) {
        const latest   = history[history.length - 1];
        const previous = history.length > 1 ? history[history.length - 2] : undefined;

        await enrichAndComplete(jobId, input, {
          dataSource:      source,
          companyInfo:     data?.companyInfo,
          currency:        data?.currency,
          latestRevenue:   latest.revenueFormatted,
          latestRevenueRaw: latest.revenue,
          revenueYear:     latest.year,
          yoyGrowth:       latest.yoyGrowth,
          previousRevenue: previous?.revenueFormatted,
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
