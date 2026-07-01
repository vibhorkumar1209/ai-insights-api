import { v4 as uuidv4 } from 'uuid';
import { RevenueInput, RevenueResult } from '@ai-insights/types';
import { detectTicker, fetchYahooQuoteSummaryFinancials } from './yahooFinance';
import { claudeLookupTicker } from './claudeAI';
import { researchPrivateCompany } from './parallelAI';
import { synthesizePrivateCompany } from './claudeAI';

// ── In-memory job store ────────────────────────────────────────────────────────

const jobs = new Map<string, RevenueResult>();

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

function update(jobId: string, patch: Partial<RevenueResult>): RevenueResult {
  const current = jobs.get(jobId)!;
  const updated = { ...current, ...patch };
  jobs.set(jobId, updated);
  return updated;
}

// ── Public API ─────────────────────────────────────────────────────────────────

export function createRevenueJob(input: RevenueInput): string {
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

export function getRevenueJob(jobId: string): RevenueResult | undefined {
  return jobs.get(jobId);
}

// ── Main runner ────────────────────────────────────────────────────────────────

export async function runRevenueJob(jobId: string, input: RevenueInput): Promise<void> {
  try {
    // Step 1: Ticker detection
    let job = update(jobId, {
      status: 'detecting',
      progress: 20,
      currentStep: `Looking up ${input.companyName} on Yahoo Finance…`,
    });
    emit(jobId, 'progress', job);

    let tickerResult = await detectTicker(input.companyName, input.companyDomain).catch(() => null);

    if (!tickerResult) {
      const claudeTicker = await claudeLookupTicker(input.companyName, input.companyDomain).catch(() => null);
      if (claudeTicker) tickerResult = claudeTicker;
    }

    const ticker   = tickerResult?.ticker;
    const exchange = tickerResult?.exchange;
    const isPublic = !!tickerResult;

    job = update(jobId, { ticker, exchange, isPublic, progress: 40 });
    emit(jobId, 'progress', job);

    if (isPublic && ticker) {
      // Step 2: Fetch revenue via Yahoo Finance (same source as Financial Analysis)
      job = update(jobId, {
        status: 'fetching',
        progress: 55,
        currentStep: `Fetching revenue for ${ticker} from Yahoo Finance…`,
      });
      emit(jobId, 'progress', job);

      const data = await fetchYahooQuoteSummaryFinancials(ticker);
      const history = data.revenueHistory;

      if (history.length > 0) {
        const latest   = history[history.length - 1];
        const previous = history.length > 1 ? history[history.length - 2] : undefined;

        job = update(jobId, {
          status:          'complete',
          progress:        100,
          currentStep:     'Complete',
          completedAt:     new Date().toISOString(),
          dataSource:      'Yahoo Finance',
          companyInfo:     data.companyInfo,
          currency:        data.currency,
          latestRevenue:   latest.revenueFormatted,
          latestRevenueRaw: latest.revenue,
          revenueYear:     latest.year,
          yoyGrowth:       latest.yoyGrowth,
          previousRevenue: previous?.revenueFormatted,
          previousYear:    previous?.year,
        });
        emit(jobId, 'result', job);
        return;
      }
    }

    // Fallback: private/AI-estimated revenue
    job = update(jobId, {
      isPublic: false,
      status: 'fetching',
      progress: 60,
      currentStep: `Estimating revenue for ${input.companyName} via AI research…`,
    });
    emit(jobId, 'progress', job);

    let research = '';
    try {
      research = await researchPrivateCompany(input.companyName, input.companyDomain);
    } catch { /* non-blocking */ }

    const privateData = await synthesizePrivateCompany(
      { companyName: input.companyName, companyDomain: input.companyDomain },
      research,
      () => {}
    );

    job = update(jobId, {
      status:        'complete',
      progress:      100,
      currentStep:   'Complete',
      completedAt:   new Date().toISOString(),
      dataSource:    'Parallel.AI',
      latestRevenue: privateData.estimatedRevenue,
    });
    emit(jobId, 'result', job);

  } catch (err) {
    const message = err instanceof Error ? err.message : 'Revenue lookup failed';
    console.error(`[revenue] job ${jobId} failed:`, message);
    const job = update(jobId, { status: 'error', error: message });
    emit(jobId, 'error', job);
  }
}
