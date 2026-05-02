import { v4 as uuidv4 } from 'uuid';
import { BusinessTimelinesResult } from '@ai-insights/types';
import { researchCompany } from './parallelAI';
import { synthesizeBusinessTimeline } from './claudeAI';

// In-memory job store
const jobs = new Map<string, BusinessTimelinesResult>();
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

function update(jobId: string, patch: Partial<BusinessTimelinesResult>): BusinessTimelinesResult {
  const current = jobs.get(jobId)!;
  const updated = { ...current, ...patch };
  jobs.set(jobId, updated);
  return updated;
}

export function createBusinessTimelinesJob(companyName: string, companyDomain?: string): string {
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

export function getBusinessTimelinesJob(jobId: string): BusinessTimelinesResult | undefined {
  return jobs.get(jobId);
}

export async function runBusinessTimelinesAnalysis(
  jobId: string,
  companyName: string,
  companyDomain?: string
): Promise<void> {
  try {
    // Step 1: Research
    let job = update(jobId, {
      status: 'researching',
      progress: 10,
      currentStep: `Researching ${companyName}'s strategic history…`,
    });
    emit(jobId, 'progress', job);

    let research = '';
    try {
      research = await researchCompany(companyName, companyDomain);
    } catch (err) {
      console.warn('[businessTimelines] Research failed:', err);
    }

    // Step 2: Synthesize timeline
    job = update(jobId, {
      status: 'synthesizing',
      progress: 50,
      currentStep: 'Reconstructing business timeline…',
    });
    emit(jobId, 'progress', job);

    const { timelineBlocks, strategicEvolution } = await synthesizeBusinessTimeline(
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
      timelineBlocks,
      strategicEvolution,
    });
    emit(jobId, 'result', job);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Analysis failed';
    console.error(`[businessTimelines] job ${jobId} failed:`, message);
    const job = update(jobId, { status: 'error', error: message });
    emit(jobId, 'error', job);
  }
}

export function getJobManager() {
  return {
    updateJob: update,
    emit,
    getJob: getBusinessTimelinesJob,
  };
}
