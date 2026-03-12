export interface BenchmarkInput {
  userOrganization: string;   // SELLING_ORGANIZATION
  targetCompany: string;      // TARGET_ACCOUNT
  industryContext: string;    // INDUSTRY_CONTEXT
  focusAreas?: string;        // FOCUS_AREAS
  solutionPortfolio?: string; // SOLUTION_PORTFOLIO
  additionalContext?: string; // ADDITIONAL_CONTEXT
  selectedCompetitors: string[]; // max 5, includes manual + system picks
}

export interface Competitor {
  name: string;
  description: string;
  headquarters?: string;
  estimatedRevenue?: string;
  employees?: string;
  relevanceScore: number; // 1-10
}

export interface CompetitorDiscoveryResult {
  targetCompany: string;
  industry: string;
  competitors: Competitor[];
}

export interface BenchmarkDimension {
  dimension: string;
  targetCompany: { value: string; notes?: string };
  peers: Record<string, { value: string; notes?: string }>;
}

export type GapLevel = 'RED' | 'AMBER' | 'GREEN';

export interface GapAnalysisRow {
  capability: string;
  peersBestPractice: string;
  targetStatus: string;
  gapLevel: GapLevel;
  gapDetail: string;
  solutionFit: string;
  proofPoint: string;
}

export interface BenchmarkResult {
  jobId: string;
  status: 'pending' | 'researching' | 'synthesizing' | 'complete' | 'error';
  progress: number;          // 0-100
  currentStep?: string;
  benchmarkingTable?: BenchmarkDimension[];
  gapAnalysis?: GapAnalysisRow[];
  selectedPeers?: string[];
  sources?: string[];
  error?: string;
  createdAt: string;
  completedAt?: string;
}

export interface SSEEvent {
  type: 'progress' | 'result' | 'error';
  data: Partial<BenchmarkResult>;
}

