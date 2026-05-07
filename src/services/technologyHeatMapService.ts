import { v4 as uuidv4 } from 'uuid';
import { HeatMapInput, TechnologyHeatMapResult } from '@ai-insights/types';
import { synthesizeHeatMap } from './claudeAI';

// In-memory job store (in production, use Redis or database)
const jobs = new Map<string, TechnologyHeatMapResult>();

// Subscription management for SSE
const subscribers = new Map<string, Set<(event: string, data: unknown) => void>>();

// ── Job Management ────────────────────────────────────────────────────────────

export function createTechnologyHeatMapJob(): string {
  const jobId = uuidv4();
  jobs.set(jobId, {
    jobId,
    status: 'pending',
    progress: 0,
    createdAt: new Date().toISOString(),
  });
  return jobId;
}

export function getTechnologyHeatMapJob(jobId: string): TechnologyHeatMapResult | undefined {
  return jobs.get(jobId);
}

export function subscribeToJob(
  jobId: string,
  callback: (event: string, data: unknown) => void
): void {
  if (!subscribers.has(jobId)) {
    subscribers.set(jobId, new Set());
  }
  subscribers.get(jobId)!.add(callback);
}

export function unsubscribeFromJob(
  jobId: string,
  callback: (event: string, data: unknown) => void
): void {
  const subs = subscribers.get(jobId);
  if (subs) {
    subs.delete(callback);
  }
}

function emit(jobId: string, event: string, data: unknown): void {
  const subs = subscribers.get(jobId);
  if (subs) {
    subs.forEach((cb) => {
      try {
        cb(event, data);
      } catch (err) {
        console.error('[technologyHeatMapService] Subscriber error:', err);
      }
    });
  }
}

function updateJob(jobId: string, updates: Partial<TechnologyHeatMapResult>): void {
  const job = jobs.get(jobId);
  if (job) {
    jobs.set(jobId, { ...job, ...updates });
  }
}

// ── Main Analysis Flow ────────────────────────────────────────────────────────

export async function runTechnologyHeatMap(jobId: string, input: HeatMapInput): Promise<void> {
  const job = jobs.get(jobId);
  if (!job) return;

  try {
    // Combine selected and manual entries
    const allCompetitors = [...new Set([...input.selectedCompetitors, ...input.manualCompetitors])];
    const allTechs = [...new Set([...input.selectedTechs, ...input.manualTechs])];
    const allSegments = [...new Set([...input.industrySegments, ...input.manualSegments])];

    // Step 1: Update job status to researching
    updateJob(jobId, {
      status: 'researching',
      progress: 5,
      currentStep: 'Researching technology adoption across competitors and industry segments...',
    });
    emit(jobId, 'progress', jobs.get(jobId));

    // Step 2: Parallel research - get adoption data for competitors
    const competitorResearch = await researchCompetitorAdoption(input.industry, allCompetitors, allTechs);
    updateJob(jobId, { progress: 35 });
    emit(jobId, 'progress', jobs.get(jobId));

    // Step 3: Parallel research - get adoption data for industry segments
    const industrySegmentResearch = await researchIndustrySegmentAdoption(
      input.industry,
      allSegments,
      allTechs
    );
    updateJob(jobId, { progress: 50 });
    emit(jobId, 'progress', jobs.get(jobId));

    // Step 4: Synthesis phase
    updateJob(jobId, {
      status: 'synthesizing',
      currentStep: 'Synthesizing heat map data and generating insights...',
      progress: 60,
    });
    emit(jobId, 'progress', jobs.get(jobId));

    const synthesisResult = await synthesizeHeatMap(input, competitorResearch, industrySegmentResearch);
    updateJob(jobId, { progress: 90 });

    // Step 5: Final update with complete results
    updateJob(jobId, {
      status: 'complete',
      progress: 100,
      industry: input.industry,
      competitionHeatMap: synthesisResult.competitionHeatMap,
      industryHeatMap: synthesisResult.industryHeatMap,
      insights: synthesisResult.insights,
      completedAt: new Date().toISOString(),
    });

    emit(jobId, 'result', jobs.get(jobId));
  } catch (error) {
    console.error('[technologyHeatMapService] Error:', error);
    updateJob(jobId, {
      status: 'error',
      error: error instanceof Error ? error.message : 'Unknown error',
      completedAt: new Date().toISOString(),
    });
    emit(jobId, 'error', jobs.get(jobId));
  }
}

// ── Research Functions ────────────────────────────────────────────────────────

async function researchCompetitorAdoption(
  industry: string,
  competitors: string[],
  technologies: string[]
): Promise<Record<string, string>> {
  const research: Record<string, string> = {};

  // Placeholder: In production, integrate with Parallel.AI or other research APIs
  // For now, return structured research data that synthesis can work with
  for (const competitor of competitors) {
    research[competitor] = `Technology adoption research for ${competitor} in ${industry} industry:
    - Primary focus areas: ${technologies.slice(0, 3).join(', ')}
    - Recent initiatives and vendor partnerships
    - Implementation maturity levels across technology stack
    - Strategic direction and future investments`;
  }

  return research;
}

async function researchIndustrySegmentAdoption(
  industry: string,
  segments: string[],
  technologies: string[]
): Promise<Record<string, string>> {
  const research: Record<string, string> = {};

  // Placeholder: In production, integrate with Parallel.AI or other research APIs
  for (const segment of segments) {
    research[segment] = `Technology adoption trends for ${segment} segment in ${industry} industry:
    - Current market adoption levels: ${technologies.slice(0, 3).join(', ')}
    - Key adopters and implementation examples
    - Growth trajectories and emerging patterns
    - Barriers to adoption and success factors`;
  }

  return research;
}

// ── Cleanup ───────────────────────────────────────────────────────────────────

// Clean up old jobs every hour (keep only last 100 jobs)
setInterval(() => {
  if (jobs.size > 100) {
    const sortedJobs = Array.from(jobs.entries()).sort(
      (a, b) => new Date(b[1].createdAt).getTime() - new Date(a[1].createdAt).getTime()
    );
    sortedJobs.slice(100).forEach(([id]) => {
      jobs.delete(id);
      subscribers.delete(id);
    });
  }
}, 60 * 60 * 1000); // 1 hour
