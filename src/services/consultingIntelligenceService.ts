import { v4 as uuidv4 } from 'uuid';
import { ConsultingIntelligenceJob } from '@ai-insights/types';
import { discoverConsultingTLFirms, researchConsultingFirmTL } from './parallelAI.js';
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

  try {
    // ── Step 1: Broad discovery query ──────────────────────────────────────────
    let current = update(jobId, {
      status: 'researching',
      progress: 5,
      currentStep: 'Scanning thought leadership landscape…',
    });
    emit(jobId, 'progress', current);

    const discoveryText = await discoverConsultingTLFirms(topic, geography);

    current = update(jobId, { progress: 20, currentStep: 'Identifying top firms with published content…' });
    emit(jobId, 'progress', current);

    // ── Step 2: Extract top 10 firms from discovery ────────────────────────────
    const discoveredFirms = await extractTopFirmsFromDiscovery(discoveryText, topic);

    if (discoveredFirms.length === 0) {
      throw new Error('No firms with verifiable thought leadership found for this topic. Try broadening the topic or geography.');
    }

    current = update(jobId, {
      progress: 25,
      discoveredFirms,
      currentStep: `Found ${discoveredFirms.length} firms — conducting deep research…`,
    });
    emit(jobId, 'progress', current);

    // ── Step 3: Deep per-firm research in parallel ─────────────────────────────
    const progressPerFirm = Math.floor(50 / discoveredFirms.length);

    const firmResearchPromises = discoveredFirms.map(async (firm, idx) => {
      const rawText = await researchConsultingFirmTL(firm, topic, geography);
      const newProgress = Math.min(25 + progressPerFirm * (idx + 1), 75);
      current = update(jobId, {
        progress: newProgress,
        currentStep: `Researching: ${firm}`,
      });
      emit(jobId, 'progress', current);
      return { firm, rawText };
    });

    const firmResearch = await Promise.all(firmResearchPromises);

    // ── Step 4: Claude synthesis ───────────────────────────────────────────────
    current = update(jobId, {
      status: 'synthesising',
      progress: 78,
      currentStep: `Synthesising insights from ${discoveredFirms.length} firms…`,
    });
    emit(jobId, 'progress', current);

    const results = await synthesiseConsultingIntelligence(topic, geography, discoveredFirms, firmResearch);

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
