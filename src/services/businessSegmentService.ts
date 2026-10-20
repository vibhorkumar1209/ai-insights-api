import { v4 as uuidv4 } from 'uuid';
import { BusinessSegmentInput, BusinessSegmentResult, Battlecard, BattlecardInput } from '@ai-insights/types';
import { researchSegmentDossier, structureSegmentDossier, generateBattlecard } from './businessSegmentAI';

// Job store for the Business Segment module. Same async job + SSE shape as the
// other modules. A battlecard (phase 2) lives on its parent job, so it is
// archived and shown in Report History together with the dossier it belongs to.

const jobs = new Map<string, BusinessSegmentResult>();

const JOB_TTL_MS = 2 * 60 * 60 * 1000;
const cleanupTimer = setInterval(() => {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs.entries()) {
    if (new Date(job.createdAt).getTime() < cutoff) jobs.delete(id);
  }
}, 30 * 60 * 1000);
cleanupTimer.unref();

export function getBusinessSegmentJob(jobId: string): BusinessSegmentResult | undefined {
  return jobs.get(jobId);
}

export function createBusinessSegmentJob(): string {
  const jobId = uuidv4();
  jobs.set(jobId, { jobId, status: 'pending', progress: 0, createdAt: new Date().toISOString() });
  return jobId;
}

function updateJob(jobId: string, update: Partial<BusinessSegmentResult>) {
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

// ── Phase 1: dossier ─────────────────────────────────────────────────────────

export async function runBusinessSegment(jobId: string, input: BusinessSegmentInput): Promise<void> {
  try {
    const base = {
      companyName: input.companyName,
      companyDomain: input.companyDomain,
      linkedinUrl: input.linkedinUrl,
    };
    updateJob(jobId, { ...base, status: 'researching', progress: 10, currentStep: `Researching ${input.companyName}'s segments and leadership...` });
    emit(jobId, 'progress', { ...jobs.get(jobId) });

    const { notes, urls } = await researchSegmentDossier(input, (step, progress) => {
      updateJob(jobId, { currentStep: step, progress });
      emit(jobId, 'progress', { ...jobs.get(jobId) });
    });
    if (!notes || notes.trim().length < 80) {
      throw new Error('Research returned nothing usable for this company. Check the name and domain and try again.');
    }

    updateJob(jobId, { status: 'synthesizing', progress: 60, currentStep: 'Building the segment dossier...' });
    emit(jobId, 'progress', { ...jobs.get(jobId) });

    const segments = await structureSegmentDossier(input, notes, urls);
    // A dossier with no segments is a failure, not a result: reporting it as
    // complete would show the user an empty page and save it to history.
    if (segments.length === 0) {
      throw new Error('No business segments could be identified for this company.');
    }

    updateJob(jobId, {
      status: 'complete',
      progress: 100,
      currentStep: 'Complete',
      segments,
      completedAt: new Date().toISOString(),
    });
    emit(jobId, 'result', { ...jobs.get(jobId) });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Segment dossier failed';
    console.error(`[businessSegment] job ${jobId} failed:`, errorMsg);
    updateJob(jobId, { status: 'error', error: errorMsg, progress: 0 });
    emit(jobId, 'error', { error: errorMsg });
  }
}

// ── Phase 2: battlecard ──────────────────────────────────────────────────────

export function startBattlecard(jobId: string, inputs: BattlecardInput): { ok: true; battlecard: Battlecard } | { ok: false; error: string; status: number } {
  const job = jobs.get(jobId);
  if (!job) return { ok: false, error: 'Job not found', status: 404 };
  if (job.status !== 'complete' || !job.segments) return { ok: false, error: 'The segment dossier is not complete yet', status: 409 };
  const segment = job.segments.find((s) => s.name.toLowerCase() === inputs.segmentName.toLowerCase());
  if (!segment) return { ok: false, error: `Unknown segment "${inputs.segmentName}"`, status: 400 };

  const battlecard: Battlecard = {
    battlecardId: uuidv4(),
    status: 'researching',
    inputs,
    createdAt: new Date().toISOString(),
  };
  updateJob(jobId, { battlecards: [...(job.battlecards || []), battlecard] });

  const company: BusinessSegmentInput = {
    companyName: job.companyName || '',
    companyDomain: job.companyDomain || '',
    linkedinUrl: job.linkedinUrl,
  };
  void (async () => {
    try {
      const draft = await generateBattlecard(company, segment, inputs);
      if (!draft.coreWinTheme && draft.comparison.length === 0) throw new Error('The battlecard came back empty');
      patchBattlecard(jobId, battlecard.battlecardId, { ...draft, status: 'complete', completedAt: new Date().toISOString() });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Battlecard failed';
      console.error(`[businessSegment] battlecard ${battlecard.battlecardId} failed:`, msg);
      patchBattlecard(jobId, battlecard.battlecardId, { status: 'error', error: msg });
    }
  })();
  return { ok: true, battlecard };
}

function patchBattlecard(jobId: string, battlecardId: string, patch: Partial<Battlecard>) {
  const job = jobs.get(jobId);
  if (!job) return;
  updateJob(jobId, {
    battlecards: (job.battlecards || []).map((b) => (b.battlecardId === battlecardId ? { ...b, ...patch } : b)),
  });
}

export function getBattlecard(jobId: string, battlecardId: string): Battlecard | undefined {
  return jobs.get(jobId)?.battlecards?.find((b) => b.battlecardId === battlecardId);
}
