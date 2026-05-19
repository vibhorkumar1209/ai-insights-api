import { v4 as uuidv4 } from 'uuid';
import { ConsultingIntelligenceJob } from '@ai-insights/types';
import { researchConsultingFirmTL } from './parallelAI.js';
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
  selectedFirms: string[];
}): string {
  const jobId = uuidv4();
  jobs.set(jobId, {
    jobId,
    status: 'pending',
    progress: 0,
    topic: params.topic,
    geography: params.geography,
    selectedFirms: params.selectedFirms,
    createdAt: new Date().toISOString(),
  });
  return jobId;
}

export function getConsultingIntelligenceJob(jobId: string): ConsultingIntelligenceJob | undefined {
  return jobs.get(jobId);
}

// ── Main orchestrator ──────────────────────────────────────────────────────────

export async function runConsultingIntelligenceAnalysis(
  jobId: string
): Promise<void> {
  const job = jobs.get(jobId);
  if (!job) throw new Error(`Job ${jobId} not found`);

  const { topic, geography, selectedFirms } = job;

  try {
    // Step 1: Research each firm via Parallel.AI (parallel)
    let current = update(jobId, {
      status: 'researching',
      progress: 5,
      currentStep: `Researching ${selectedFirms.length} consulting firms via Parallel.AI…`,
    });
    emit(jobId, 'progress', current);

    const progressPerFirm = Math.floor(75 / selectedFirms.length);

    const firmResearchPromises = selectedFirms.map(async (firm, idx) => {
      const rawText = await researchConsultingFirmTL(firm, topic, geography);
      const newProgress = Math.min(5 + progressPerFirm * (idx + 1), 80);
      current = update(jobId, {
        progress: newProgress,
        currentStep: `Researched: ${firm}`,
      });
      emit(jobId, 'progress', current);
      return { firm, rawText };
    });

    const firmResearch = await Promise.all(firmResearchPromises);

    // Step 2: Synthesise via Claude
    current = update(jobId, {
      status: 'synthesising',
      progress: 82,
      currentStep: 'Synthesising insights across all firms…',
    });
    emit(jobId, 'progress', current);

    const results = await synthesiseConsultingIntelligence(topic, geography, selectedFirms, firmResearch);

    // Done
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
