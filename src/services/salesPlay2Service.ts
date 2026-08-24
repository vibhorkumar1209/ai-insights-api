import { v4 as uuidv4 } from 'uuid';
import { SalesPlay2Input, SalesPlay2Result } from '@ai-insights/types';
import { researchSalesPlayContext, researchVendorRelationship } from './parallelAI';
import { synthesizeSalesPlay2 } from './claudeAI';
import { filterLiveUrlsOnRows } from './urlValidator';

const jobs = new Map<string, SalesPlay2Result>();
const JOB_TTL_MS = 2 * 60 * 60 * 1000;

const cleanupTimer = setInterval(() => {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs.entries()) {
    if (new Date(job.createdAt).getTime() < cutoff) jobs.delete(id);
  }
}, 30 * 60 * 1000);
cleanupTimer.unref();

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
  (subscribers.get(jobId) || []).forEach((cb) => { try { cb(event, data); } catch { /* closed */ } });
}

function update(jobId: string, patch: Partial<SalesPlay2Result>): SalesPlay2Result {
  const current = jobs.get(jobId)!;
  const updated = { ...current, ...patch };
  jobs.set(jobId, updated);
  return updated;
}

export function createSalesPlay2Job(input: SalesPlay2Input): string {
  const jobId = uuidv4();
  jobs.set(jobId, {
    jobId,
    status: 'pending',
    progress: 0,
    createdAt: new Date().toISOString(),
    yourCompany: input.yourCompany,
    competitorName: input.competitorName,
    targetAccount: input.targetAccount,
    targetIndustry: input.targetIndustry,
  });
  return jobId;
}

export function getSalesPlay2Job(jobId: string): SalesPlay2Result | undefined {
  return jobs.get(jobId);
}

export async function runSalesPlay2(jobId: string, input: SalesPlay2Input): Promise<void> {
  try {
    // Step 1: Research
    let job = update(jobId, {
      status: 'researching',
      progress: 10,
      currentStep: `Researching ${input.targetAccount} and ${input.competitorName}…`,
    });
    emit(jobId, 'progress', job);

    let research = '';
    try {
      research = await researchSalesPlayContext(
        input.yourCompany,
        input.competitorName,
        input.targetAccount,
        input.targetIndustry,
        input.strategicPriorities
      );
    } catch (err) {
      console.warn('[salesPlay2] Research failed, proceeding with training knowledge:', err);
    }

    // Step 1b: Incumbency check — does each named competitor already have a presence at the target account?
    const competitorList = input.competitorName.split(',').map((c) => c.trim()).filter(Boolean);
    job = update(jobId, { progress: 35, currentStep: `Checking incumbent vendor status at ${input.targetAccount}…` });
    emit(jobId, 'progress', job);

    let incumbencyResearch = '';
    try {
      const entries = await Promise.all(
        competitorList.map(async (name) => {
          const text = await researchVendorRelationship(input.targetAccount, name, input.targetIndustry).catch(() => '');
          return `=== ${name} ===\n${text}`;
        })
      );
      incumbencyResearch = entries.join('\n\n');
    } catch (err) {
      console.warn('[salesPlay2] Incumbency research failed:', err);
    }

    job = update(jobId, { progress: 50, status: 'synthesizing', currentStep: 'Synthesising win themes, opportunities and competitive positioning…' });
    emit(jobId, 'progress', job);

    // Step 2: Synthesise
    const result = await synthesizeSalesPlay2(input, research, competitorList, incumbencyResearch, (accumulated) => {
      const synthProgress = Math.min(95, 50 + Math.floor((accumulated.length / 5000) * 45));
      const j = update(jobId, { progress: synthProgress });
      emit(jobId, 'progress', j);
    });

    job = update(jobId, { progress: 97, currentStep: 'Verifying source links…' });
    emit(jobId, 'progress', job);
    // '' fallback: if every URL Claude cited for a trigger turns out dead,
    // drop the source note entirely rather than showing generic placeholder
    // text after the trigger sentence.
    const winThemes = await filterLiveUrlsOnRows(result.winThemes, '');

    const completedAt = new Date().toISOString();
    job = update(jobId, {
      status: 'complete',
      progress: 100,
      currentStep: 'Complete',
      completedAt,
      winThemes,
      opportunities: result.opportunities,
      competitors: result.competitors,
    });
    emit(jobId, 'result', job);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Analysis failed';
    console.error(`[salesPlay2] job ${jobId} failed:`, message);
    const job = update(jobId, { status: 'error', error: message });
    emit(jobId, 'error', job);
  }
}
