import { getRegisteredReports, archiveCompletedReport, isArchived, getArchivedReports, getArchivedReport } from './reportRegistry';
import { getJob as getBenchmarkJob } from './benchmarkService';
import { getBusinessDescriptionJob } from './businessDescriptionService';
import { getBizDescripJob } from './bizDescripService';
import { getBusinessSegmentsJob } from './businessSegmentsService';
import { getBusinessTimelinesJob } from './businessTimelinesService';
import { getChallengesGrowthJob } from './challengesGrowthService';
import { getCompetitionBenchmarkingJob } from './competitionBenchmarkingService';
import { getConsultingIntelligenceJob } from './consultingIntelligenceService';
import { getContentGenerationJob } from './contentGenerationService';
import { getFinancialJob } from './financialAnalysisService';
import { getFirmographicJob } from './firmographicService';
import { getGccSalesPlayJob } from './gccSalesPlayService';
import { getIndustryReportJob } from './industryReportService';
import { getIndustryTrendsJob } from './industryTrendsService';
import { getItJobJob } from './itJobService';
import { getJobDescriptionParserJob } from './jobDescriptionParserService';
import { getKeyBuyersJob } from './keyBuyersService';
import { getMarketingStrategyJob } from './marketingStrategyService';
import { getNicheIndustryJob } from './nicheIndustryService';
import { getObjectionHandlingJob } from './objectionHandlingService';
import { getOutsourcingReportJob } from './outsourcingReportService';
import { getPeersJob } from './peersService';
import { getSalesPlayJob } from './salesPlayService';
import { getSalesPlay2Job } from './salesPlay2Service';
import { getSpendJob } from './spendService';
import { getTechnologyHeatMapJob } from './technologyHeatMapService';
import { getThemeJob } from './themesService';
import { getVucaJob } from './vucaAnalysisService';

// One line per module: how to fetch its job by ID, and the public API path
// (for the frontend's "view raw report" link and for building the SSE
// stream URL if ever needed). Registered moduleType strings match the
// frontend's ModuleType union in lib/history.ts where one exists; a few
// modules (content-generation, objection-handling) aren't in that union —
// they're included here anyway and the frontend already filters unknown
// moduleTypes out safely (see ReportsLibraryPage's `!(e.moduleType in
// MODULE_META)` guard), so this list can be a superset without breaking
// anything.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const GETTERS: Record<string, (jobId: string) => any> = {
  'peer-benchmarking': getBenchmarkJob,
  'business-description': getBusinessDescriptionJob,
  'biz-descrip': getBizDescripJob,
  'business-segments': getBusinessSegmentsJob,
  'business-timelines': getBusinessTimelinesJob,
  'challenges-growth': getChallengesGrowthJob,
  'competition-benchmarking': getCompetitionBenchmarkingJob,
  'consulting-intelligence': getConsultingIntelligenceJob,
  // contentGeneration.ts registers jobs under whichever of these two the
  // request actually asked for, not the generic route name — see the
  // comment at its registerJobStart() call site.
  'industry-blog': getContentGenerationJob,
  'industry-thought-leadership': getContentGenerationJob,
  'financial-analysis': getFinancialJob,
  'firmographic': getFirmographicJob,
  'gcc-sales-play': getGccSalesPlayJob,
  'industry-report': getIndustryReportJob,
  'industry-trends': getIndustryTrendsJob,
  'it-jobs': getItJobJob,
  'job-description-parser': getJobDescriptionParserJob,
  'key-buyers': getKeyBuyersJob,
  'marketing-strategy': getMarketingStrategyJob,
  'niche-industries': getNicheIndustryJob,
  'objection-handling': getObjectionHandlingJob,
  'industry-outsourcing-report': getOutsourcingReportJob,
  'peers': getPeersJob,
  'sales-play': getSalesPlayJob,
  'sales-play-2': getSalesPlay2Job,
  'spend': getSpendJob,
  'technology-heat-map': getTechnologyHeatMapJob,
  'business-themes': getThemeJob, // themes.ts serves business/technology/sustainability off one route; see the moduleType note in reportRegistry registration call sites
  'vuca-analysis': getVucaJob,
};

export interface RecentReportSummary {
  jobId: string;
  moduleType: string;
  label: string;
  status: string;
  createdAt: string;
  completedAt?: string;
}

// Captures a completed report into the archive before its module's 2h TTL
// evicts it. Runs on a timer rather than being called from each module's
// completion path, because that would mean touching all 26 routes and every
// future one would have to remember to do it.
//
// 60s is comfortably inside the 2h window even if several sweeps are missed,
// and the work is trivial: already-archived jobs are skipped by an O(1) check,
// so a steady state sweep does nothing.
const ARCHIVE_SWEEP_MS = 60 * 1000;

export function sweepCompletedReportsIntoArchive(): void {
  for (const r of getRegisteredReports()) {
    if (isArchived(r.jobId)) continue;
    const getter = GETTERS[r.moduleType];
    if (!getter) continue;
    let job;
    try {
      job = getter(r.jobId);
    } catch {
      continue; // a module getter throwing must not stop the sweep
    }
    if (!job || job.status !== 'complete') continue;
    archiveCompletedReport(r, job, job.completedAt || new Date().toISOString());
  }
}

const sweepTimer = setInterval(() => {
  try {
    sweepCompletedReportsIntoArchive();
  } catch (err) {
    console.warn('[reportsAggregator] archive sweep failed:', err instanceof Error ? err.message : err);
  }
}, ARCHIVE_SWEEP_MS);
sweepTimer.unref();

// Serves the archived payload for a job whose module store has since evicted
// it, so "View" on an older Report History row still opens the real report
// instead of a 404.
export function getArchivedReportPayload(jobId: string): unknown | undefined {
  return getArchivedReport(jobId)?.payload;
}

// Cross-references the registry (jobs started) against each module's own job
// store, falling back to the archive for anything that store has since
// evicted. Previously a report simply vanished from Report History once its
// module's 2h TTL elapsed; the archive is what makes it durable.
export function getRecentCompletedReports(limit = 100): RecentReportSummary[] {
  const registered = getRegisteredReports();
  const results: RecentReportSummary[] = [];
  const seen = new Set<string>();

  // Sweep first so a report that completed since the last tick is included in
  // this response rather than only in the next one.
  sweepCompletedReportsIntoArchive();

  for (let i = registered.length - 1; i >= 0 && results.length < limit; i--) {
    const r = registered[i];
    const getter = GETTERS[r.moduleType];
    if (!getter) continue;
    const job = getter(r.jobId);

    if (job && job.status === 'complete') {
      seen.add(r.jobId);
      results.push({
        jobId: r.jobId,
        moduleType: r.moduleType,
        label: r.label,
        status: 'complete',
        createdAt: job.createdAt || r.createdAt,
        completedAt: job.completedAt,
      });
      continue;
    }

    // Live job gone (TTL) — fall back to what was archived while it existed.
    const archived = getArchivedReport(r.jobId);
    if (archived) {
      seen.add(r.jobId);
      results.push({
        jobId: archived.jobId,
        moduleType: archived.moduleType,
        label: archived.label,
        status: 'complete',
        createdAt: archived.createdAt,
        completedAt: archived.completedAt,
      });
    }
  }

  // Archived reports whose registry entry has itself aged out (the registry is
  // capped at 500) would otherwise be silently unreachable.
  if (results.length < limit) {
    const orphans = getArchivedReports()
      .filter((a) => !seen.has(a.jobId))
      .sort((a, b) => new Date(b.completedAt).getTime() - new Date(a.completedAt).getTime());
    for (const a of orphans) {
      if (results.length >= limit) break;
      results.push({
        jobId: a.jobId,
        moduleType: a.moduleType,
        label: a.label,
        status: 'complete',
        createdAt: a.createdAt,
        completedAt: a.completedAt,
      });
    }
  }

  return results;
}
