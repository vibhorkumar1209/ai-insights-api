import { v4 as uuidv4 } from 'uuid';
import { ConsultingIntelligenceJob } from '@ai-insights/types';
import { researchConsultingTLTopicBatches } from './parallelAI.js';
import { synthesiseConsultingIntelligence } from './claudeAI.js';

// ── In-memory job store ────────────────────────────────────────────────────────

const jobs = new Map<string, ConsultingIntelligenceJob>();
const JOB_TTL_MS = 2 * 60 * 60 * 1000;

setInterval(() => {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs.entries()) {
    if (job.createdAt && new Date(job.createdAt).getTime() < cutoff) jobs.delete(id);
  }
}, 30 * 60 * 1000).unref();

// ── SSE subscribers ────────────────────────────────────────────────────────────

type SSECallback = (event: string, data: unknown) => void;
const subscribers = new Map<string, SSECallback[]>();

export function subscribeToConsultingJob(jobId: string, cb: SSECallback): void {
  const list = subscribers.get(jobId) || [];
  list.push(cb);
  subscribers.set(jobId, list);
}

export function unsubscribeFromConsultingJob(jobId: string, cb: SSECallback): void {
  const list = (subscribers.get(jobId) || []).filter((c) => c !== cb);
  if (list.length > 0) subscribers.set(jobId, list);
  else subscribers.delete(jobId);
}

function emit(jobId: string, event: string, data: unknown): void {
  (subscribers.get(jobId) || []).forEach((cb) => {
    try { cb(event, data); } catch { /* ignore closed connections */ }
  });
}

function update(jobId: string, patch: Partial<ConsultingIntelligenceJob>): ConsultingIntelligenceJob {
  const current = jobs.get(jobId)!;
  const updated = { ...current, ...patch };
  jobs.set(jobId, updated);
  return updated;
}

// ── Public API ─────────────────────────────────────────────────────────────────

export function createConsultingIntelligenceJob(params: {
  topic: string;
  geography: string;
}): string {
  const jobId = uuidv4();
  jobs.set(jobId, {
    jobId,
    status: 'pending',
    progress: 0,
    topic: params.topic,
    geography: params.geography,
    createdAt: new Date().toISOString(),
  });
  return jobId;
}

export function getConsultingIntelligenceJob(jobId: string): ConsultingIntelligenceJob | undefined {
  return jobs.get(jobId);
}

// ── Main orchestrator ──────────────────────────────────────────────────────────

export async function runConsultingIntelligenceAnalysis(jobId: string): Promise<void> {
  const job = jobs.get(jobId);
  if (!job) throw new Error(`Job ${jobId} not found`);

  const { topic, geography } = job;

  // Heartbeat helper — emits a progress tick every 25s so the frontend
  // stuck-timer (45s) never fires during long Parallel.AI or Claude calls.
  function startHeartbeat(baseProgress: number, maxProgress: number, label: string): ReturnType<typeof setInterval> {
    let p = baseProgress;
    return setInterval(() => {
      p = Math.min(p + 1, maxProgress);
      const hb = update(jobId, { progress: p, currentStep: label });
      emit(jobId, 'progress', hb);
    }, 25_000);
  }

  // Standard set of top consulting/analyst firms — Claude attributes content to these
  const STANDARD_FIRMS = ['McKinsey & Company', 'Boston Consulting Group', 'Deloitte', 'Gartner', 'Accenture', 'PwC', 'Forrester', 'IDC', 'Bain & Company', 'EY'];

  try {
    // ── Step 1: Kick off with standard firms immediately ──────────────────────
    const discoveredFirms = STANDARD_FIRMS;

    let current = update(jobId, {
      status: 'researching',
      progress: 10,
      discoveredFirms,
      currentStep: 'Running 4 parallel research queries across consulting & analyst sources…',
    });
    emit(jobId, 'progress', current);

    current = update(jobId, {
      progress: 15,
      discoveredFirms,
      currentStep: `Researching: strategy consulting, Big Four, tech analysts, market intelligence…`,
    });
    emit(jobId, 'progress', current);

    // ── Step 3: 4 topic-focused research queries (all parallel) ───────────────
    // Topic-centric queries yield far richer results than firm-centric ones.
    current = update(jobId, { progress: 28, currentStep: 'Researching across strategy, advisory, tech analyst, and market intelligence sources…' });
    emit(jobId, 'progress', current);

    const researchHeartbeat = startHeartbeat(29, 64, 'Researching thought leadership content…');
    let researchBatches: Array<{ label: string; rawText: string }>;
    try {
      researchBatches = await researchConsultingTLTopicBatches(topic, geography);
      const done = researchBatches.filter((b) => !b.rawText.includes('failed')).length;
      current = update(jobId, { progress: 65, currentStep: `Research complete — ${done}/4 batches successful` });
      emit(jobId, 'progress', current);
    } finally {
      clearInterval(researchHeartbeat);
    }

    // ── Step 4: Claude synthesis ───────────────────────────────────────────────
    current = update(jobId, {
      status: 'synthesising',
      progress: 78,
      currentStep: `Synthesising insights from ${discoveredFirms.length} firms…`,
    });
    emit(jobId, 'progress', current);

    // Heartbeat during synthesis (Claude Sonnet can take 60-90s on large context)
    let synthProgress = 79;
    const synthHeartbeat = setInterval(() => {
      synthProgress = Math.min(synthProgress + 3, 96);
      current = update(jobId, { progress: synthProgress, currentStep: 'Synthesising analyst-grade report…' });
      emit(jobId, 'progress', current);
    }, 25_000);

    let results: Partial<ConsultingIntelligenceJob>;
    try {
      results = await synthesiseConsultingIntelligence(topic, geography, discoveredFirms, researchBatches);
    } finally {
      clearInterval(synthHeartbeat);
    }

    // ── Done ───────────────────────────────────────────────────────────────────
    current = update(jobId, {
      status: 'complete',
      progress: 100,
      currentStep: 'Complete',
      ...results,
      completedAt: new Date().toISOString(),
    });
    emit(jobId, 'result', current);

  } catch (err) {
    const message = err instanceof Error ? err.message : 'Analysis failed';
    console.error(`[consultingIntelligence] job ${jobId} failed:`, message);
    const failed = update(jobId, { status: 'error', error: message });
    emit(jobId, 'error', failed);
  }
}
