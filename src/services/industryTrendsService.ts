import { v4 as uuidv4 } from 'uuid';
import { IndustryTrendsInput, IndustryTrendsResult } from '../types';
import { researchIndustryTrends } from './parallelAI';
import { synthesizeIndustryTrends } from './claudeAI';

// ── In-memory job store ───────────────────────────────────────────────────────

const jobs = new Map<string, IndustryTrendsResult>();

const JOB_TTL_MS = 2 * 60 * 60 * 1000;
const cleanupTimer = setInterval(() => {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs.entries()) {
    if (new Date(job.createdAt).getTime() < cutoff) jobs.delete(id);
  }
}, 30 * 60 * 1000);
cleanupTimer.unref();

export function getIndustryTrendsJob(jobId: string): IndustryTrendsResult | undefined {
  return jobs.get(jobId);
}

export function createIndustryTrendsJob(): string {
  const jobId = uuidv4();
  jobs.set(jobId, { jobId, status: 'pending', progress: 0, createdAt: new Date().toISOString() });
  return jobId;
}

function updateJob(jobId: string, update: Partial<IndustryTrendsResult>) {
  const current = jobs.get(jobId);
  if (current) jobs.set(jobId, { ...current, ...update });
}

// ── SSE subscriber registry ───────────────────────────────────────────────────

type SSECallback = (event: string, data: unknown) => void;
const subscribers = new Map<string, SSECallback[]>();

export function subscribeToJob(jobId: string, cb: SSECallback) {
  subscribers.set(jobId, [...(subscribers.get(jobId) || []), cb]);
}

export function unsubscribeFromJob(jobId: string, cb: SSECallback) {
  subscribers.set(jobId, (subscribers.get(jobId) || []).filter((fn) => fn !== cb));
}

function emit(jobId: string, event: string, data: unknown) {
  (subscribers.get(jobId) || []).forEach((cb) => cb(event, data));
}

// ── Main runner ───────────────────────────────────────────────────────────────

export async function runIndustryTrends(
  jobId: string,
  input: IndustryTrendsInput
): Promise<void> {
  try {
    const geography = input.geography || 'Global';
    const geoLabel = geography !== 'Global' ? ` in ${geography}` : '';

    updateJob(jobId, { industrySegment: input.industrySegment, geography });

    updateJob(jobId, {
      status: 'researching',
      progress: 10,
      currentStep: `Researching business & technology trends in ${input.industrySegment}${geoLabel}…`,
    });
    emit(jobId, 'progress', { progress: 10, currentStep: `Researching business & technology trends in ${input.industrySegment}${geoLabel}…` });

    const research = await researchIndustryTrends(input.industrySegment, geography);

    updateJob(jobId, {
      status: 'synthesizing',
      progress: 65,
      currentStep: 'Synthesising industry trends with AI…',
    });
    emit(jobId, 'progress', { progress: 65, currentStep: 'Synthesising industry trends with AI…' });

    const { businessTrends, techTrends } = await synthesizeIndustryTrends(input, research);

    const completed: Partial<IndustryTrendsResult> = {
      status: 'complete',
      progress: 100,
      currentStep: 'Complete',
      businessTrends,
      techTrends,
      completedAt: new Date().toISOString(),
    };

    updateJob(jobId, completed);
    emit(jobId, 'result', { ...jobs.get(jobId) });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Unknown error';
    console.error(`[industryTrends] job ${jobId} failed:`, errorMsg);
    updateJob(jobId, { status: 'error', error: errorMsg, progress: 0 });
    emit(jobId, 'error', { error: errorMsg });
  }
}
