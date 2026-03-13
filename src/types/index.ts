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

// ── Themes Analysis ───────────────────────────────────────────────────────────

export type ThemeType = 'business' | 'technology' | 'sustainability';

export interface ThemeInput {
  companyName: string;
  themeType: ThemeType;
  userOrganization?: string;
  solutionPortfolio?: string;
}

export interface ThemeRow {
  theme: string;
  description: string;
  examples: string;        // pipe-separated use cases
  strategicImpact: string;
}

export interface ThemeResult {
  jobId: string;
  status: 'pending' | 'researching' | 'synthesizing' | 'complete' | 'error';
  progress: number;
  currentStep?: string;
  rows?: ThemeRow[];
  themeType?: ThemeType;
  companyName?: string;
  error?: string;
  createdAt: string;
  completedAt?: string;
}

// ── Challenges & Growth Analysis ──────────────────────────────────────────────

export interface ChallengesGrowthInput {
  companyName: string;
  userOrganization?: string;
  solutionPortfolio?: string;
}

export interface ChallengesGrowthRow {
  dimension: string;      // e.g. "Macroeconomics", "Supply Chain", "Regulatory"
  challenge: string;      // Major challenge for this dimension
  growthProspect: string; // Key growth opportunity for this dimension
}

export interface ChallengesGrowthResult {
  jobId: string;
  status: 'pending' | 'researching' | 'synthesizing' | 'complete' | 'error';
  progress: number;
  currentStep?: string;
  rows?: ChallengesGrowthRow[];
  companyName?: string;
  error?: string;
  createdAt: string;
  completedAt?: string;
}

// ── Financial Analysis ─────────────────────────────────────────────────────────

export interface CompanyInfo {
  name?: string;
  exchange?: string;
  previousClose?: string;
  dayRange?: string;
  yearRange?: string;
  marketCap?: string;
  avgVolume?: string;
  peRatio?: string;
  dividendYield?: string;
  ceo?: string;
  founded?: string;
  headquarters?: string;
  website?: string;
  employees?: string;
  about?: string;
}

export interface QuarterlyDataPoint {
  period: string;            // e.g. "DEC 2025"
  revenue?: number;          // raw number
  revenueFormatted?: string; // e.g. "£4.99B"
  operatingExpense?: number;
  netIncome?: number;
  netProfitMargin?: number;  // percentage, e.g. 28.07
  earningsPerShare?: string; // "0.02" or "—"
  effectiveTaxRate?: string; // "27.63%"
}

export interface RevenueDataPoint {
  year: string;
  revenue: number;           // raw number
  revenueFormatted: string;  // e.g. "£24.2B"
  yoyGrowth?: number;        // percentage, e.g. 8.5 = 8.5%
}

export interface MarginDataPoint {
  year: string;
  netMargin: number;         // percentage, e.g. 22.5 = 22.5%
  operatingMargin: number;   // percentage
}

export interface FinancialSegmentRow {
  segment: string;
  revenue: string;           // formatted e.g. "$12.4B"
  percentage: number;        // 0-100
  yoyGrowth?: string;
}

export interface GeoRow {
  region: string;
  revenue: string;           // formatted
  percentage: number;        // 0-100
}

export interface FinancialStatementRow {
  label: string;
  value: string;
  yoy?: string;              // e.g. "+12.3%"
  isSection?: boolean;       // section header (no value)
  isBold?: boolean;          // subtotal / key line
}

export interface FinancialAnalysisInput {
  companyName: string;
  companyDomain?: string;
  isPublic?: boolean;        // override auto-detection
}

// ── Sales Play & Opportunity ────────────────────────────────────────────────────

export interface SalesPlayInput {
  yourCompany: string;
  competitorName: string;
  targetAccount: string;
  targetIndustry: string;
  strategicPriorities?: string[];  // optional — AI auto-discovers if empty
  solutionAreas?: string;          // optional — AI auto-discovers if empty
  competitorWeaknesses?: string;
}

export interface SalesPlayPriorityRow {
  priority: string;
  companySolution: string;
  proofPoints: string;
  whyNotCompetitor: string;
}

export interface SalesPlayIndustrySolution {
  name: string;
  problemSolved: string;
  description: string;
}

export interface SalesPlayPartner {
  name: string;
  capability: string;
}

export interface SalesPlayCaseStudy {
  client: string;
  challenge: string;
  solution: string;
  outcome: string;
  testimonial?: string;
}

export interface SalesPlayPriorityMapping {
  priority: string;
  solution: string;
  expectedOutcome: string;
  timeToValue: string;
}

export interface SalesPlayObjectionRebuttal {
  objection: string;
  rebuttal: string;
}

export interface SalesPlayResult {
  jobId: string;
  status: 'pending' | 'researching' | 'synthesizing' | 'complete' | 'error';
  progress: number;
  currentStep?: string;
  // Input echo
  yourCompany?: string;
  competitorName?: string;
  targetAccount?: string;
  targetIndustry?: string;
  // Section 1: Strategic priority alignment
  priorityTable?: SalesPlayPriorityRow[];
  // Section 2: Industry solutions, tech, partners, case studies
  industrySolutions?: SalesPlayIndustrySolution[];
  techSummary?: string;
  technologyPartners?: SalesPlayPartner[];
  siPartners?: SalesPlayPartner[];
  caseStudies?: SalesPlayCaseStudy[];
  // Section 3: Mapping, positioning, objections, CTA
  priorityMapping?: SalesPlayPriorityMapping[];
  competitiveStatement?: string;
  objectionRebuttals?: SalesPlayObjectionRebuttal[];
  callToAction?: string;
  error?: string;
  createdAt: string;
  completedAt?: string;
}

export interface FinancialAnalysisResult {
  jobId: string;
  status: 'pending' | 'detecting' | 'fetching' | 'researching' | 'synthesizing' | 'complete' | 'error';
  progress: number;
  currentStep?: string;
  companyName?: string;
  ticker?: string;
  exchange?: string;
  isPublic?: boolean;

  // ── Public company ──────────────────────────────────────────────
  companyInfo?:      CompanyInfo;
  currency?:         string;             // e.g. "GBP", "USD"
  revenueHistory?:   RevenueDataPoint[];
  marginHistory?:    MarginDataPoint[];
  quarterlyHistory?: QuarterlyDataPoint[];
  segmentRevenue?:   FinancialSegmentRow[];
  geoRevenue?:       GeoRow[];
  plStatement?:      FinancialStatementRow[];
  balanceSheet?:     FinancialStatementRow[];
  cashFlow?:         FinancialStatementRow[];

  // ── Insights ────────────────────────────────────────────────────
  revenueInsight?: string;
  marginInsight?:  string;
  segmentInsight?: string;
  geoInsight?:     string;
  plInsight?:      string;
  bsInsight?:      string;
  cfInsight?:      string;
  keyHighlights?:  string[];

  // ── Private company ─────────────────────────────────────────────
  estimatedRevenue?:     string;
  profitabilityMargin?:  string;
  estimatedYoyGrowth?:   string;
  fundingInfo?:          string;
  lastValuation?:        string;
  privateInsights?:      string[];

  error?: string;
  createdAt: string;
  completedAt?: string;
}

