import { v4 as uuidv4 } from 'uuid';
import { BusinessSegmentsResult } from '@ai-insights/types';
import { researchCompany } from './parallelAI';
import { synthesizeBusinessSegments } from './claudeAI';

// In-memory job store
const jobs = new Map<string, BusinessSegmentsResult>();
const JOB_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

// Cleanup stale jobs every 30 minutes
setInterval(() => {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs.entries()) {
    if (new Date(job.createdAt).getTime() < cutoff) jobs.delete(id);
  }
}, 30 * 60 * 1000);

// SSE subscriber registry
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

function update(jobId: string, patch: Partial<BusinessSegmentsResult>): BusinessSegmentsResult {
  const current = jobs.get(jobId)!;
  const updated = { ...current, ...patch };
  jobs.set(jobId, updated);
  return updated;
}

export function createBusinessSegmentsJob(companyName: string, companyDomain?: string): string {
  const jobId = uuidv4();
  jobs.set(jobId, {
    jobId,
    status: 'pending',
    progress: 0,
    companyName,
    createdAt: new Date().toISOString(),
  });
  return jobId;
}

export function getBusinessSegmentsJob(jobId: string): BusinessSegmentsResult | undefined {
  return jobs.get(jobId);
}

export async function runBusinessSegmentsAnalysis(
  jobId: string,
  companyName: string,
  companyDomain?: string
): Promise<void> {
  try {
    // Step 1: Research
    let job = update(jobId, {
      status: 'researching',
      progress: 10,
      currentStep: `Researching ${companyName}'s business structure…`,
    });
    emit(jobId, 'progress', job);

    let research = '';
    try {
      research = await researchCompany(companyName, companyDomain);
    } catch (err) {
      console.warn('[businessSegments] Research failed:', err);
    }

    // Step 2: Synthesize segments & timeline
    job = update(jobId, {
      status: 'synthesizing',
      progress: 50,
      currentStep: 'Synthesising business segments…',
    });
    emit(jobId, 'progress', job);

    const { segments, strategicEvolution } = await synthesizeBusinessSegments(
      companyName,
      companyDomain,
      research
    );

    const completedAt = new Date().toISOString();
    job = update(jobId, {
      status: 'complete',
      progress: 100,
      currentStep: 'Complete',
      completedAt,
      segments,
      strategicEvolution,
    });
    emit(jobId, 'result', job);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Analysis failed';
    console.error(`[businessSegments] job ${jobId} failed:`, message);
    const job = update(jobId, { status: 'error', error: message });
    emit(jobId, 'error', job);
  }
}

export function getJobManager() {
  return {
    updateJob: update,
    emit,
    getJob: getBusinessSegmentsJob,
  };
}
