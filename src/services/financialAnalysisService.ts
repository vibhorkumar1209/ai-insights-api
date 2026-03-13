import { v4 as uuidv4 } from 'uuid';
import { FinancialAnalysisResult, FinancialAnalysisInput } from '../types';
import { detectTicker, fetchFinancials } from './yahooFinance';
import { researchFinancialSegments, researchPrivateCompany } from './parallelAI';
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

// ── Main orchestrator ─────────────────────────────────────────────────────────

export async function runFinancialAnalysis(
  jobId: string,
  input: FinancialAnalysisInput
): Promise<void> {
  try {
    // ── Step 1: Detect public / private ──────────────────────────────────────
    let job = update(jobId, { status: 'detecting', progress: 5, currentStep: 'Detecting company type…' });
    emit(jobId, 'progress', job);

    let isPublic = input.isPublic;
    let ticker: string | undefined;
    let exchange: string | undefined;

    if (isPublic === undefined) {
      const detected = await detectTicker(input.companyName, input.companyDomain);
      if (detected) {
        isPublic = true;
        ticker = detected.ticker;
        exchange = detected.exchange;
      } else {
        isPublic = false;
      }
    } else if (isPublic) {
      // User said it's public but we still need the ticker
      const detected = await detectTicker(input.companyName, input.companyDomain);
      if (detected) { ticker = detected.ticker; exchange = detected.exchange; }
    }

    job = update(jobId, { isPublic, ticker, exchange });
    emit(jobId, 'progress', job);

    // ── PUBLIC PATH ────────────────────────────────────────────────────────────
    if (isPublic && ticker) {
      // Step 2: Fetch Yahoo Finance data
      job = update(jobId, { status: 'fetching', progress: 20, currentStep: `Fetching financial data for ${ticker}…` });
      emit(jobId, 'progress', job);

      let yahooData: Partial<FinancialAnalysisResult> = {};
      try {
        const fetched = await fetchFinancials(ticker);
        yahooData = fetched;
        job = update(jobId, { ...fetched, progress: 35 });
        emit(jobId, 'progress', job);
      } catch (err) {
        console.error(`[financialAnalysis] Yahoo Finance fetch failed for ${ticker}:`, err);
        // Continue with empty Yahoo data — Claude will use training knowledge
      }

      // Step 3: Research segments + geo via Parallel.AI
      job = update(jobId, { status: 'researching', progress: 35, currentStep: 'Researching segment and geographic revenue breakdown…' });
      emit(jobId, 'progress', job);

      let segmentResearch = '';
      try {
        segmentResearch = await researchFinancialSegments(input.companyName, ticker);
      } catch (err) {
        console.error('[financialAnalysis] Segment research failed:', err);
      }

      job = update(jobId, { progress: 65 });
      emit(jobId, 'progress', job);

      // Step 4: Claude synthesis — insights + segment/geo parsing
      job = update(jobId, { status: 'synthesizing', progress: 65, currentStep: 'Generating financial insights…' });
      emit(jobId, 'progress', job);

      const insights = await synthesizeFinancialInsights(input, yahooData, segmentResearch);

      const completedAt = new Date().toISOString();
      job = update(jobId, {
        status: 'complete',
        progress: 100,
        currentStep: 'Complete',
        completedAt,
        revenueInsight: insights.revenueInsight,
        marginInsight:  insights.marginInsight,
        segmentInsight: insights.segmentInsight,
        geoInsight:     insights.geoInsight,
        plInsight:      insights.plInsight,
        bsInsight:      insights.bsInsight,
        cfInsight:      insights.cfInsight,
        keyHighlights:  insights.keyHighlights,
        segmentRevenue: insights.segmentRevenue?.length ? insights.segmentRevenue : undefined,
        geoRevenue:     insights.geoRevenue?.length ? insights.geoRevenue : undefined,
      });
      emit(jobId, 'result', job);

    } else if (isPublic && !ticker) {
      // Public company but no ticker found — fall back to private path with a note
      await runPrivatePath(jobId, input, true);

    } else {
      // ── PRIVATE PATH ────────────────────────────────────────────────────────
      await runPrivatePath(jobId, input, false);
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
  tickerNotFound: boolean
): Promise<void> {
  let job = update(jobId, {
    isPublic: false,
    status: 'researching',
    progress: 10,
    currentStep: tickerNotFound
      ? 'No public ticker found — researching as private company…'
      : 'Researching private company financial profile…',
  });
  emit(jobId, 'progress', job);

  const research = await researchPrivateCompany(input.companyName, input.companyDomain);

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
