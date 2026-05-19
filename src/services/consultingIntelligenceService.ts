import { v4 as uuidv4 } from 'uuid';
import { ConsultingIntelligenceJob } from '@ai-insights/types';
import { discoverConsultingTLFirms, researchConsultingFirmsBatch } from './parallelAI.js';
import { extractTopFirmsFromDiscovery, synthesiseConsultingIntelligence } from './claudeAI.js';

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

  // Default firms used as fallback if discovery returns nothing
  const FALLBACK_FIRMS = ['McKinsey & Company', 'Boston Consulting Group', 'Deloitte', 'Gartner', 'Accenture', 'PwC', 'Forrester', 'IDC', 'Bain & Company', 'EY'];

  try {
    // ── Step 1: Broad discovery query ──────────────────────────────────────────
    let current = update(jobId, {
      status: 'researching',
      progress: 5,
      currentStep: 'Scanning thought leadership landscape…',
    });
    emit(jobId, 'progress', current);

    const discoveryHeartbeat = startHeartbeat(6, 18, 'Scanning thought leadership landscape…');
    let discoveryText = '';
    try {
      discoveryText = await discoverConsultingTLFirms(topic, geography);
    } finally {
      clearInterval(discoveryHeartbeat);
    }

    current = update(jobId, { progress: 20, currentStep: 'Identifying top firms with published content…' });
    emit(jobId, 'progress', current);

    // ── Step 2: Extract top firms from discovery (Claude Haiku — fast) ─────────
    const extractHeartbeat = startHeartbeat(21, 24, 'Identifying top firms…');
    let discoveredFirms: string[] = [];
    try {
      discoveredFirms = await extractTopFirmsFromDiscovery(discoveryText, topic);
    } finally {
      clearInterval(extractHeartbeat);
    }

    // Fallback to well-known firms if discovery/extraction returned nothing
    if (discoveredFirms.length === 0) {
      discoveredFirms = FALLBACK_FIRMS;
    }

    current = update(jobId, {
      progress: 25,
      discoveredFirms,
      currentStep: `Found ${discoveredFirms.length} firms — researching in batches…`,
    });
    emit(jobId, 'progress', current);

    // ── Step 3: Batched research — 3 parallel calls covering all firms ─────────
    // Split firms into up to 3 groups (e.g. 10 firms → 4+3+3)
    const batchSize = Math.ceil(discoveredFirms.length / 3);
    const batches: string[][] = [];
    for (let i = 0; i < discoveredFirms.length; i += batchSize) {
      batches.push(discoveredFirms.slice(i, i + batchSize));
    }

    current = update(jobId, { progress: 30, currentStep: `Running ${batches.length} research batches in parallel…` });
    emit(jobId, 'progress', current);

    // Heartbeat: emit a progress ping every 25s so the frontend stuck-timer (45s) never fires
    let heartbeatProgress = 31;
    const heartbeat = setInterval(() => {
      heartbeatProgress = Math.min(heartbeatProgress + 2, 64);
      current = update(jobId, { progress: heartbeatProgress, currentStep: 'Researching thought leadership content…' });
      emit(jobId, 'progress', current);
    }, 25_000);

    let batchResults: Array<{ batch: string[]; rawText: string }>;
    try {
      batchResults = await Promise.all(
        batches.map((batch, idx) =>
          researchConsultingFirmsBatch(batch, topic, geography).then((rawText) => {
            const newProgress = Math.min(35 + 15 * (idx + 1), 65);
            current = update(jobId, { progress: newProgress, currentStep: `Batch ${idx + 1}/${batches.length} complete (${batch.join(', ')})` });
            emit(jobId, 'progress', current);
            return { batch, rawText };
          })
        )
      );
    } finally {
      clearInterval(heartbeat);
    }

    // Flatten batch results into per-firm entries for Claude synthesis
    const firmResearch = discoveredFirms.map((firm) => {
      const batchResult = batchResults.find((b) => b.batch.includes(firm));
      return { firm, rawText: batchResult?.rawText || '' };
    });

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
      results = await synthesiseConsultingIntelligence(topic, geography, discoveredFirms, firmResearch);
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
