import { v4 as uuidv4 } from 'uuid';
import { TargetIndustryInput, TargetIndustryResult } from '../types';
import { researchTargetIndustries, researchIndustrySubSegments } from './parallelAI';
import { synthesizeTargetIndustries, synthesizeSubSegments } from './claudeAI';

// ── In-memory job store ────────────────────────────────────────────────────────

const jobs = new Map<string, TargetIndustryResult>();
const JOB_TTL_MS = 2 * 60 * 60 * 1000;

setInterval(() => {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs.entries()) {
    if (new Date(job.createdAt).getTime() < cutoff) jobs.delete(id);
  }
}, 30 * 60 * 1000);

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
  (subscribers.get(jobId) || []).forEach((cb) => cb(event, data));
}

function update(jobId: string, patch: Partial<TargetIndustryResult>): TargetIndustryResult {
  const current = jobs.get(jobId)!;
  const updated = { ...current, ...patch };
  jobs.set(jobId, updated);
  return updated;
}

// ── Public API ─────────────────────────────────────────────────────────────────

export function createTargetIndustryJob(): string {
  const jobId = uuidv4();
  jobs.set(jobId, {
    jobId,
    status: 'pending',
    progress: 0,
    createdAt: new Date().toISOString(),
  });
  return jobId;
}

export function getTargetIndustryJob(jobId: string): TargetIndustryResult | undefined {
  return jobs.get(jobId);
}

// ── Main orchestrator ──────────────────────────────────────────────────────────

export async function runTargetIndustryAnalysis(
  jobId: string,
  input: TargetIndustryInput
): Promise<void> {
  try {
    // Step 1: Research target industries
    let job = update(jobId, {
      status: 'researching',
      progress: 10,
      currentStep: 'Researching target industries via Parallel.AI…',
      productDescription: input.productDescription,
    });
    emit(jobId, 'progress', job);

    const industryResearch = await researchTargetIndustries(
      input.productDescription,
      input.websiteUrl,
      input.additionalContext
    );

    // Step 2: Synthesize industries
    job = update(jobId, {
      status: 'synthesizing',
      progress: 35,
      currentStep: 'Classifying industries into growth-volume quadrants…',
    });
    emit(jobId, 'progress', job);

    const industries = await synthesizeTargetIndustries(input, industryResearch);

    // Emit partial with industries
    job = update(jobId, {
      industries,
      progress: 50,
      currentStep: 'Industry classification complete. Researching sub-segments…',
    });
    emit(jobId, 'progress', job);

    // Step 3: Research sub-segments for all discovered industries
    job = update(jobId, {
      status: 'drilling',
      progress: 55,
      currentStep: 'Researching industry sub-segments via Parallel.AI…',
    });
    emit(jobId, 'progress', job);

    const industryNames = industries.map((i) => i.industry);
    const subSegmentResearch = await researchIndustrySubSegments(
      industryNames,
      input.productDescription
    );

    // Step 4: Synthesize sub-segments
    job = update(jobId, {
      status: 'synthesizing',
      progress: 80,
      currentStep: 'Classifying sub-segments into growth-volume quadrants…',
    });
    emit(jobId, 'progress', job);

    const subSegments = await synthesizeSubSegments(
      industryNames,
      input.productDescription,
      subSegmentResearch
    );

    // Done
    job = update(jobId, {
      status: 'complete',
      progress: 100,
      currentStep: 'Complete',
      industries,
      subSegments,
      completedAt: new Date().toISOString(),
    });
    emit(jobId, 'result', job);

  } catch (err) {
    const message = err instanceof Error ? err.message : 'Analysis failed';
    console.error(`[targetIndustry] job ${jobId} failed:`, message);
    const job = update(jobId, { status: 'error', error: message });
    emit(jobId, 'error', job);
  }
}
