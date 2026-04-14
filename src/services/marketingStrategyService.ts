import { v4 as uuidv4 } from 'uuid';
import { MarketingStrategyInput, MarketingStrategyResult } from '../types';
import { researchMarketingStrategy } from './parallelAI';
import { synthesizeMarketingStrategy } from './claudeAI';

// ── In-memory job store ────────────────────────────────────────────────────────

const jobs = new Map<string, MarketingStrategyResult>();
const JOB_TTL_MS = 2 * 60 * 60 * 1000;

setInterval(() => {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs.entries()) {
    if (new Date(job.createdAt).getTime() < cutoff) jobs.delete(id);
  }
}, 30 * 60 * 1000).unref();

// ── SSE subscribers ────────────────────────────────────────────────────────────

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
  (subscribers.get(jobId) || []).forEach((cb) => {
    try { cb(event, data); } catch { /* ignore closed connections */ }
  });
}

function update(jobId: string, patch: Partial<MarketingStrategyResult>): MarketingStrategyResult {
  const current = jobs.get(jobId)!;
  const updated = { ...current, ...patch };
  jobs.set(jobId, updated);
  return updated;
}

// ── Public API ─────────────────────────────────────────────────────────────────

export function createMarketingStrategyJob(): string {
  const jobId = uuidv4();
  jobs.set(jobId, {
    jobId,
    status: 'pending',
    progress: 0,
    createdAt: new Date().toISOString(),
  });
  return jobId;
}

export function getMarketingStrategyJob(jobId: string): MarketingStrategyResult | undefined {
  return jobs.get(jobId);
}

// ── Main orchestrator ──────────────────────────────────────────────────────────

export async function runMarketingStrategy(
  jobId: string,
  input: MarketingStrategyInput
): Promise<void> {
  try {
    // Step 1: Research via Parallel.AI
    let job = update(jobId, {
      status: 'researching',
      progress: 10,
      currentStep: `Researching ${input.industryOrSegment} for ${input.framework} analysis…`,
      industryOrSegment: input.industryOrSegment,
      framework: input.framework,
    });
    emit(jobId, 'progress', job);

    const research = await researchMarketingStrategy(
      input.industryOrSegment,
      input.framework,
      input.productContext
    );

    // Step 2: Synthesize with Claude
    job = update(jobId, {
      status: 'synthesizing',
      progress: 55,
      currentStep: `Applying ${input.framework} framework — synthesising strategic analysis…`,
    });
    emit(jobId, 'progress', job);

    const result = await synthesizeMarketingStrategy(input, research);

    // Done
    job = update(jobId, {
      status: 'complete',
      progress: 100,
      currentStep: 'Complete',
      frameworkSummary: result.frameworkSummary,
      dimensions: result.dimensions,
      strategicRecommendations: result.strategicRecommendations,
      completedAt: new Date().toISOString(),
    });
    emit(jobId, 'result', job);

  } catch (err) {
    const message = err instanceof Error ? err.message : 'Analysis failed';
    console.error(`[marketingStrategy] job ${jobId} failed:`, message);
    const job = update(jobId, { status: 'error', error: message });
    emit(jobId, 'error', job);
  }
}
