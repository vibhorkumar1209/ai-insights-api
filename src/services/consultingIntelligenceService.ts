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
    try { cb(event, data); } catch { /* ignore */ }
  });
}
function update(jobId: string, patch: Partial<ConsultingIntelligenceJob>): ConsultingIntelligenceJob {
  const current = jobs.get(jobId)!;
  const updated = { ...current, ...patch };
  jobs.set(jobId, updated);
  return updated;
}

// ── Public API ─────────────────────────────────────────────────────────────────

export function createConsultingIntelligenceJob(params: { topic: string; geography: string }): string {
  const jobId = uuidv4();
  jobs.set(jobId, {
    jobId, status: 'pending', progress: 0,
    topic: params.topic, geography: params.geography,
    createdAt: new Date().toISOString(),
  });
  return jobId;
}
export function getConsultingIntelligenceJob(jobId: string): ConsultingIntelligenceJob | undefined {
  return jobs.get(jobId);
}

// ── Heartbeat ─────────────────────────────────────────────────────────────────

function startHeartbeat(jobId: string, baseProgress: number, maxProgress: number, label: string) {
  let p = baseProgress;
  return setInterval(() => {
    p = Math.min(p + 1, maxProgress);
    const hb = update(jobId, { progress: p, currentStep: label });
    emit(jobId, 'progress', hb);
  }, 15_000);
}

// ── Main orchestrator ──────────────────────────────────────────────────────────

export async function runConsultingIntelligenceAnalysis(jobId: string): Promise<void> {
  const job = jobs.get(jobId);
  if (!job) throw new Error(`Job ${jobId} not found`);
  const { topic, geography } = job;

  const STANDARD_FIRMS = [
    'McKinsey & Company', 'Boston Consulting Group', 'Deloitte', 'Gartner',
    'Accenture', 'PwC', 'Forrester', 'IDC', 'Bain & Company', 'EY',
  ];

  try {
    // ── Step 1: Research — run queries SEQUENTIALLY to avoid CPU thrash ────────
    let current = update(jobId, {
      status: 'researching', progress: 10,
      discoveredFirms: STANDARD_FIRMS,
      currentStep: 'Researching consulting & analyst thought leadership…',
    });
    emit(jobId, 'progress', current);

    const researchHB = startHeartbeat(jobId, 11, 64, 'Researching thought leadership…');
    let researchBatches: Array<{ label: string; rawText: string }> = [];
    try {
      const batchDefs = [
        { label: 'reports', query: `"${topic}" ${geography} research report analysis 2024 2025 site:mckinsey.com OR site:bcg.com OR site:bain.com OR site:deloitte.com OR site:pwc.com OR site:ey.com OR site:accenture.com OR site:kpmg.com` },
        { label: 'analysts', query: `"${topic}" ${geography} forecast outlook trends 2024 2025 site:gartner.com OR site:forrester.com OR site:idc.com OR site:everestgrp.com OR site:hbr.org OR site:weforum.org` },
        { label: 'insights', query: `"${topic}" ${geography} strategy insights statistics market size 2024 2025 consulting firm report` },
        { label: 'trends', query: `"${topic}" ${geography} trends challenges opportunities recommendations industry 2025` },
      ];

      current = update(jobId, { progress: 14, currentStep: 'Running 4 research queries in parallel…' });
      emit(jobId, 'progress', current);

      const { runResearchQuery } = await import('./parallelAI.js');
      const settled = await Promise.allSettled(batchDefs.map(({ query }) => runResearchQuery(query)));
      researchBatches = settled.map((r, i) => ({
        label: batchDefs[i].label,
        rawText: r.status === 'fulfilled' ? r.value.slice(0, 12000) : `No data retrieved for ${batchDefs[i].label} batch.`,
      }));

      current = update(jobId, { progress: 60, currentStep: 'All 4 research batches complete' });
      emit(jobId, 'progress', current);
    } finally {
      clearInterval(researchHB);
    }

    current = update(jobId, { progress: 65, currentStep: 'All research complete — synthesising…' });
    emit(jobId, 'progress', current);

    // ── Step 2: Synthesis ──────────────────────────────────────────────────────
    current = update(jobId, { status: 'synthesising', progress: 70, currentStep: 'Building analyst-grade synthesis…' });
    emit(jobId, 'progress', current);

    const synthHB = startHeartbeat(jobId, 71, 95, 'Synthesising insights…');
    let results: Partial<ConsultingIntelligenceJob> = {};
    try {
      results = await synthesiseConsultingIntelligence(topic, geography, STANDARD_FIRMS, researchBatches);
    } catch (synthErr) {
      console.error(`[consultingIntelligence] synthesis error for ${jobId}:`, synthErr);
      // Graceful fallback — return basic result so client isn't left hanging
      results = {
        executiveSummary: {
          topInsights: [`Research on "${topic}" in ${geography} completed across ${researchBatches.filter(b => !b.rawText.includes('No data')).length} source categories.`],
          emergingTrends: [],
          consensusViewpoints: [],
          contrarianOpinions: [],
          strategicImplications: [],
          futureOutlook: 'Synthesis could not be completed. Please retry with a more specific topic.',
        },
        strategicRecommendations: ['Please retry — synthesis step encountered an error.'],
        researchMethodology: `Researched ${researchBatches.length} batches. Synthesis failed: ${synthErr instanceof Error ? synthErr.message : 'unknown error'}`,
      };
    } finally {
      clearInterval(synthHB);
    }

    // ── Done ───────────────────────────────────────────────────────────────────
    current = update(jobId, {
      status: 'complete', progress: 100, currentStep: 'Complete',
      ...results,
      completedAt: new Date().toISOString(),
    });
    emit(jobId, 'result', current);

  } catch (err) {
    const message = err instanceof Error ? err.message : 'Analysis failed';
    console.error(`[consultingIntelligence] job ${jobId} failed:`, message);
    emit(jobId, 'error', update(jobId, { status: 'error', error: message }));
  }
}
