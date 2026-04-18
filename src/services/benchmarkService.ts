import { v4 as uuidv4 } from 'uuid';
import { BenchmarkInput, BenchmarkResult } from '@ai-insights/types';
import { discoverCompetitors, researchAllCompanies } from './parallelAI';
import { synthesizeBenchmarkingTable, synthesizeGapAnalysis } from './claudeAI';

// In-memory job store (replace with Redis for production multi-instance)
const jobs = new Map<string, BenchmarkResult>();

// Clean up jobs older than 2 hours
const JOB_TTL_MS = 2 * 60 * 60 * 1000;
const cleanupTimer = setInterval(() => {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs.entries()) {
    if (new Date(job.createdAt).getTime() < cutoff) {
      jobs.delete(id);
    }
  }
}, 30 * 60 * 1000);
cleanupTimer.unref(); // Don't block process/test exit

export function getJob(jobId: string): BenchmarkResult | undefined {
  return jobs.get(jobId);
}

export function createJob(): string {
  const jobId = uuidv4();
  jobs.set(jobId, {
    jobId,
    status: 'pending',
    progress: 0,
    createdAt: new Date().toISOString(),
  });
  return jobId;
}

function updateJob(jobId: string, update: Partial<BenchmarkResult>) {
  const current = jobs.get(jobId);
  if (current) {
    jobs.set(jobId, { ...current, ...update });
  }
}

// ── SSE subscriber registry ──────────────────────────────────────────────────

type SSECallback = (event: string, data: unknown) => void;
const subscribers = new Map<string, SSECallback[]>();

export function subscribeToJob(jobId: string, cb: SSECallback) {
  const existing = subscribers.get(jobId) || [];
  subscribers.set(jobId, [...existing, cb]);
}

export function unsubscribeFromJob(jobId: string, cb: SSECallback) {
  const existing = subscribers.get(jobId) || [];
  subscribers.set(
    jobId,
    existing.filter((fn) => fn !== cb)
  );
}

function emit(jobId: string, event: string, data: unknown) {
  (subscribers.get(jobId) || []).forEach((cb) => {
    try { cb(event, data); } catch { /* ignore closed connections */ }
  });
}

// ── Main benchmark runner ────────────────────────────────────────────────────

export async function runBenchmark(jobId: string, input: BenchmarkInput): Promise<void> {
  const step = (msg: string, progress: number) => {
    updateJob(jobId, { currentStep: msg, progress, status: 'researching' });
    emit(jobId, 'progress', { currentStep: msg, progress });
  };

  try {
    step('Researching companies in parallel...', 10);

    // If no competitors selected yet (shouldn't happen), discover them
    let selectedPeers = input.selectedCompetitors.slice(0, 5);
    if (selectedPeers.length === 0) {
      const discovered = await discoverCompetitors(input.targetCompany, input.industryContext);
      selectedPeers = discovered.slice(0, 3).map((c) => c.name);
    }

    updateJob(jobId, { selectedPeers });
    emit(jobId, 'progress', { selectedPeers, progress: 15 });

    // Research all companies in parallel (target + peers)
    const allCompanies = [input.targetCompany, ...selectedPeers];
    const totalCompanies = allCompanies.length;
    let researched = 0;

    step(`Gathering intelligence on ${totalCompanies} companies...`, 20);

    // Research companies sequentially to avoid peak-RAM spike
    const companyResearch: Record<string, string> = {};

    for (const company of allCompanies) {
      const research = await researchSingle(company, input);
      companyResearch[company] = research;
      researched++;
      const progress = 20 + Math.floor((researched / totalCompanies) * 40);
      step(`Researched ${researched}/${totalCompanies} companies...`, progress);
    }

    step('Synthesizing benchmarking table...', 65);
    updateJob(jobId, { status: 'synthesizing' });
    const benchmarkingTable = await synthesizeBenchmarkingTable(
      { ...input, selectedCompetitors: selectedPeers },
      companyResearch
    );
    updateJob(jobId, { benchmarkingTable });
    emit(jobId, 'progress', { benchmarkingTable, progress: 80 });

    step('Building gap analysis...', 80);
    const gapAnalysis = await synthesizeGapAnalysis(
      { ...input, selectedCompetitors: selectedPeers },
      companyResearch,
      benchmarkingTable
    );
    // Free research data from memory after synthesis
    for (const key of Object.keys(companyResearch)) delete companyResearch[key];

    const completed: Partial<BenchmarkResult> = {
      status: 'complete',
      progress: 100,
      currentStep: 'Complete',
      gapAnalysis,
      completedAt: new Date().toISOString(),
    };

    updateJob(jobId, completed);
    emit(jobId, 'result', { ...jobs.get(jobId) });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Unknown error';
    updateJob(jobId, { status: 'error', error: errorMsg, progress: 0 });
    emit(jobId, 'error', { error: errorMsg });
  }
}

// Research a single company (target or peer)
async function researchSingle(company: string, input: BenchmarkInput): Promise<string> {
  const { researchCompany } = await import('./parallelAI');
  try {
    return await researchCompany(company, input.targetCompany, input.industryContext);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Research failed';
    return `Research unavailable for ${company}: ${msg}`;
  }
}

// ── Job manager for error handling utilities ──────────────────────────────────

export function getJobManager() {
  return {
    updateJob,
    emit,
    getJob,
  };
}
