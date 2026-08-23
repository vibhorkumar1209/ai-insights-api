import { getRegisteredReports } from './reportRegistry';
import { getJob as getBenchmarkJob } from './benchmarkService';
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
  'business-segments': getBusinessSegmentsJob,
  'business-timelines': getBusinessTimelinesJob,
  'challenges-growth': getChallengesGrowthJob,
  'competition-benchmarking': getCompetitionBenchmarkingJob,
  'consulting-intelligence': getConsultingIntelligenceJob,
  'content-generation': getContentGenerationJob,
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

// Cross-references the registry (jobs started) against each module's own
// job store (current status) — a job that's still running, errored, or has
// since fallen out of its module's TTL-based store (2h, same as every job
// store in this app) is simply omitted rather than shown as a broken row.
export function getRecentCompletedReports(limit = 100): RecentReportSummary[] {
  const registered = getRegisteredReports();
  const results: RecentReportSummary[] = [];

  for (let i = registered.length - 1; i >= 0 && results.length < limit; i--) {
    const r = registered[i];
    const getter = GETTERS[r.moduleType];
    if (!getter) continue;
    const job = getter(r.jobId);
    if (!job || job.status !== 'complete') continue;
    results.push({
      jobId: r.jobId,
      moduleType: r.moduleType,
      label: r.label,
      status: job.status,
      createdAt: job.createdAt || r.createdAt,
      completedAt: job.completedAt,
    });
  }

  return results;
}
