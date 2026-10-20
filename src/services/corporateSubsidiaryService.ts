import { v4 as uuidv4 } from 'uuid';
import { CorporateSubsidiaryInput, CorporateSubsidiaryResult } from '@ai-insights/types';
import { researchCorporateEntities, structureCorporateEntities } from './businessSegmentAI';

// Job store for the Corporate Subsidiary module (the corporate family tree).
// Same async job + SSE shape as the other modules. Picking an entity for a
// deeper look starts a Business Segment job, so nothing else lives here.

const jobs = new Map<string, CorporateSubsidiaryResult>();

const JOB_TTL_MS = 2 * 60 * 60 * 1000;
const cleanupTimer = setInterval(() => {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs.entries()) {
    if (new Date(job.createdAt).getTime() < cutoff) jobs.delete(id);
  }
}, 30 * 60 * 1000);
cleanupTimer.unref();

export function getCorporateSubsidiaryJob(jobId: string): CorporateSubsidiaryResult | undefined {
  return jobs.get(jobId);
}

export function createCorporateSubsidiaryJob(): string {
  const jobId = uuidv4();
  jobs.set(jobId, { jobId, status: 'pending', progress: 0, createdAt: new Date().toISOString() });
  return jobId;
}

function updateJob(jobId: string, update: Partial<CorporateSubsidiaryResult>) {
  const current = jobs.get(jobId);
  if (current) jobs.set(jobId, { ...current, ...update });
}

type SSECallback = (event: string, data: unknown) => void;
const subscribers = new Map<string, SSECallback[]>();

export function subscribeToJob(jobId: string, cb: SSECallback) {
  subscribers.set(jobId, [...(subscribers.get(jobId) || []), cb]);
}

export function unsubscribeFromJob(jobId: string, cb: SSECallback) {
  subscribers.set(jobId, (subscribers.get(jobId) || []).filter((fn) => fn !== cb));
}

function emit(jobId: string, event: string, data: unknown) {
  (subscribers.get(jobId) || []).forEach((cb) => {
    try { cb(event, data); } catch { /* ignore closed connections */ }
  });
}

export async function runCorporateSubsidiary(jobId: string, input: CorporateSubsidiaryInput): Promise<void> {
  try {
    updateJob(jobId, {
      companyName: input.companyName,
      companyDomain: input.companyDomain,
      linkedinUrl: input.linkedinUrl,
      status: 'researching',
      progress: 10,
      currentStep: `Researching ${input.companyName}'s corporate family tree...`,
    });
    emit(jobId, 'progress', { ...jobs.get(jobId) });

    const { notes, urls } = await researchCorporateEntities(input);
    if (!notes || notes.trim().length < 80) {
      throw new Error('Research returned nothing usable for this company. Check the name and domain and try again.');
    }

    updateJob(jobId, { status: 'synthesizing', progress: 65, currentStep: 'Building the entity table...' });
    emit(jobId, 'progress', { ...jobs.get(jobId) });

    const entities = await structureCorporateEntities(input, notes, urls);
    if (entities.length === 0) throw new Error('No legal entities could be identified for this company.');

    updateJob(jobId, { status: 'complete', progress: 100, currentStep: 'Complete', entities, completedAt: new Date().toISOString() });
    emit(jobId, 'result', { ...jobs.get(jobId) });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Corporate family tree failed';
    console.error(`[corporateSubsidiary] job ${jobId} failed:`, errorMsg);
    updateJob(jobId, { status: 'error', error: errorMsg, progress: 0 });
    emit(jobId, 'error', { error: errorMsg });
  }
}
