export interface BenchmarkInput {
  userOrganization: string;   // SELLING_ORGANIZATION
  targetCompany: string;      // TARGET_ACCOUNT
  industryContext?: string;   // INDUSTRY_CONTEXT (optional — auto-detected if empty)
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
  dimension: string;
  peersBestPractice: string;
  gapLevel: GapLevel;
  solutionFit: string;
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

// ── Industry Trends ──────────────────────────────────────────────────────────

export interface IndustryTrendsInput {
  industrySegment: string;
  geography?: string;       // "Global" | region name | custom country
}

export interface IndustryTrendRow {
  trend: string;           // Name of the trend
  impact: string;          // Impact of the trend
  description: string;     // Bulleted description
  examples: string;        // Bulleted examples across global regions
}

export interface IndustryTrendsResult {
  jobId: string;
  status: 'pending' | 'researching' | 'synthesizing' | 'complete' | 'error';
  progress: number;
  currentStep?: string;
  industrySegment?: string;
  geography?: string;
  businessTrends?: IndustryTrendRow[];
  techTrends?: IndustryTrendRow[];
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
  yoyGrowth?: string;        // e.g. "+8.2%"
}

export interface KeyHighlightsStructured {
  overallPerformance: string;
  overallPerformanceTagline?: string;
  factorsDrivingGrowth: string;
  factorsDrivingGrowthTagline?: string;
  factorsInhibitingGrowth: string;
  factorsInhibitingGrowthTagline?: string;
  futureStrategy: string;
  futureStrategyTagline?: string;
  growthOutlook: string;
  growthOutlookTagline?: string;
}

export interface FinancialStatementRow {
  label: string;
  value: string;
  previousValue?: string;    // previous year value for comparison
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

// ── Key Prospective Buyers ───────────────────────────────────────────────────

export interface KeyBuyersInput {
  companyName: string;
  companyDomain?: string;
}

export interface KeyBuyerRow {
  theme: string;          // Business focus area derived from sources
  reference: string;      // Event / reason — brief phrase
  excerpt: string;        // Direct quote or brief excerpt from the source
  keyExecutive: string;   // "Name, Title, Department"
}

export interface KeyBuyersResult {
  jobId: string;
  status: 'pending' | 'researching' | 'synthesizing' | 'complete' | 'error';
  progress: number;
  currentStep?: string;
  rows?: KeyBuyerRow[];
  companyName?: string;
  error?: string;
  createdAt: string;
  completedAt?: string;
}

// ── Industry Report ─────────────────────────────────────────────────────────

export interface IndustryReportInput {
  query: string;                // Free-text, e.g. "EV battery market in North America"
  industry?: string;            // Primary industry/product
  subIndustry?: string;         // Sub-industry/sub-product
  focusAreas?: string[];        // ['market_segment','competition','regulation','trends']
  geography?: string;           // Optional override
  excludeRegion?: string;       // Region/country to exclude from research
  selectedSections?: string[];  // Section IDs user wants in the report
}

export interface IndustryReportScope {
  industry: string;
  geography: string;
  productScope: string;
  timeHorizon: string;          // e.g. "2024-2030"
  searchQueries: string[];      // 4 optimized Parallel.AI queries
  subIndustry?: string;
  focusAreas?: string[];
  excludeRegion?: string;
  selectedSections?: string[];
  selectedSegments?: MarketSegmentOption[];
  selectedPlayers?: KeyPlayerOption[];
  allPlayers?: KeyPlayerOption[];
}

export interface MarketSizingData {
  currentMarketSize: string;    // e.g. "$65.8B (2024)"
  projectedMarketSize: string;  // e.g. "$120B (2030)"
  cagr: string;                 // e.g. "18.5% (2024-2030)"
  currentVolume?: string;       // e.g. "12.5 million units (2024)" — if volume data available
  projectedVolume?: string;     // e.g. "22.3 million units (2030)"
  methodology: string;          // Top-down/bottom-up summary
  dataPoints: MarketDataPoint[];
}

export interface MarketDataPoint {
  metric: string;
  value: string;
  source: string;
}

export interface ReportSection {
  id: string;                   // e.g. "market_overview"
  title: string;
  bodyParagraphs: string[];     // BulletText-compatible (bullet delimited)
  keyTable?: ReportTable;
  tables?: ReportTable[];       // Multi-table support (e.g. regulatory: 4 tables)
  chartSpec?: ReportChartSpec;
  charts?: ReportChartSpec[];   // Multi-chart support (e.g. forecast: 3 charts)
  subsections?: ReportSubsection[];
  citations?: string[];
  swotData?: SWOTData;
  portersData?: PortersForcesData;
  teiData?: TEIData;
  macroTeiData?: MacroTEIData;
  bcgMatrixData?: BCGMatrixItem[];
  competitorProfiles?: CompetitorProfile[];
}

export interface ReportTable {
  title: string;
  headers: string[];
  rows: string[][];
}

export interface ChartDataPoint {
  label: string;
  value: number;
  category?: string;
  [key: string]: string | number | undefined;
}

export interface ChartSeriesConfig {
  key: string;
  name: string;
  type?: 'bar' | 'line';
  yAxisId?: 'left' | 'right';
  stack?: string;
  color?: string;
}

export interface ReportChartSpec {
  type: 'bar' | 'line' | 'pie' | 'stacked_bar' | 'combo' | 'area' | 'horizontal_bar' | 'scatter';
  title: string;
  xLabel?: string;
  yLabel?: string;
  yRightLabel?: string;
  data: ChartDataPoint[];
  series?: ChartSeriesConfig[];
}

export interface ReportSubsection {
  title: string;
  content: string;              // BulletText-compatible
  keyTable?: ReportTable;
  tables?: ReportTable[];
  chartSpec?: ReportChartSpec;
  charts?: ReportChartSpec[];
}

export interface ExecutiveSummaryTickerBox {
  label: string;
  value: string;
  secondaryValue?: string;      // volume when both volume+value available
  trend?: 'up' | 'down' | 'flat';
}

export interface ExecutiveSummary {
  headline: string;
  tickerBoxes?: ExecutiveSummaryTickerBox[];
  kpis: { label: string; value: string; trend?: 'up' | 'down' | 'flat' }[];
  paragraphs: string[];
  scenarios: { name: string; description: string; marketSize: string }[];
  marketSizeChartSpec?: ReportChartSpec;
  concentrationInsights?: string;
  keyPlayersInsights?: string;
  topTrends?: string[];
  recentMaJvInsights?: string;
}

export interface IndustryReportResult {
  jobId: string;
  status: 'pending' | 'scoping' | 'researching' | 'sizing' | 'drafting' | 'summarizing' | 'complete' | 'error';
  progress: number;
  currentStep?: string;
  query?: string;
  scope?: IndustryReportScope;
  marketSizing?: MarketSizingData;
  sections?: ReportSection[];
  executiveSummary?: ExecutiveSummary;
  wizardData?: ScopeWizardResult;
  error?: string;
  createdAt: string;
  completedAt?: string;
}

// ── Industry Report Wizard Types ─────────────────────────────────────────────

export interface MarketSegmentOption {
  id: string;
  label: string;
  type: string;               // 'organized','geo','product_type','application','distribution','channel','pricing','end_use','other'
  selected: boolean;
  subSegments?: string[];
}

export interface KeyPlayerOption {
  name: string;
  description: string;
  marketShare?: string;
  headquarters?: string;
  revenue?: string;
  selected: boolean;
}

export interface ScopeWizardResult {
  scope: IndustryReportScope;
  suggestedSegments: MarketSegmentOption[];
  suggestedPlayers: KeyPlayerOption[];
  tocPreview: string[];
}

// ── SWOT, Porter's, TEI ──────────────────────────────────────────────────────

export interface SWOTItem {
  title: string;
  description: string;
  impact: 'high' | 'medium' | 'low';
}

export interface SWOTData {
  strengths: SWOTItem[];
  weaknesses: SWOTItem[];
  opportunities: SWOTItem[];
  threats: SWOTItem[];
}

export interface ForceAnalysis {
  rating: 'high' | 'medium' | 'low';
  factors: string[];
  description: string;
}

export interface PortersForcesData {
  competitiveRivalry: ForceAnalysis;
  supplierPower: ForceAnalysis;
  buyerPower: ForceAnalysis;
  threatOfSubstitution: ForceAnalysis;
  threatOfNewEntry: ForceAnalysis;
}

export interface TEIItem {
  category: string;
  year1: string;
  year2: string;
  year3: string;
  description: string;
}

export interface TEIData {
  benefits: TEIItem[];
  costs: TEIItem[];
  risks: TEIItem[];
  netPresentValue: string;
  roi: string;
  paybackPeriod: string;
}

// ── Macroeconomic Impact (replaces TEI for industry reports) ─────────────────

export interface MacroTEIItem {
  trigger: string;
  impactLevel: 'high' | 'medium' | 'low';
  description: string;
  examples: string;
  marketSizeImpact: string;     // e.g. "+2.5%" or "-1.8%"
}

export interface MacroTEIData {
  items: MacroTEIItem[];
}

// ── BCG Matrix ───────────────────────────────────────────────────────────────

export interface BCGMatrixItem {
  name: string;
  marketSize: number;           // X-axis (relative market share or revenue)
  growth: number;               // Y-axis (growth rate %)
  quadrant: 'star' | 'cash_cow' | 'question_mark' | 'dog';
}

// ── Enhanced Competitor Profiles ─────────────────────────────────────────────

export interface CompetitorProfile {
  name: string;
  parentCompany?: string;
  hqLocation: string;
  keyProducts: string;
  overallRevenue?: string;
  categoryRevenue?: string;
  marketShare?: string;
  manufacturingLocation?: string;
  recentNews?: string;
  jvMaPartnerships?: string;
  otherInsights?: string;
}

// ── Financial Analysis ─────────────────────────────────────────────────────────

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
  keyHighlights?:  KeyHighlightsStructured;
  chartInsights?:  string[];
  geoSegmentInsights?: string[];

  // ── Private company ─────────────────────────────────────────────
  estimatedRevenue?:     string;
  profitabilityMargin?:  string;
  estimatedYoyGrowth?:   string;
  fundingInfo?:          string;
  lastValuation?:        string;
  privateInsights?:      string[];
  privateKeyHighlights?: KeyHighlightsStructured;

  error?: string;
  createdAt: string;
  completedAt?: string;
}

// ══════════════════════════════════════════════════════════════════════════════
// HIGH GROWTH NICHE INDUSTRIES
// ══════════════════════════════════════════════════════════════════════════════

export type NicheOutputMode = 'white_space' | 'bestseller' | 'both';
export type NicheSegmentationDepth = 'standard' | 'deep';

export interface NicheIndustryInput {
  industryVertical: string;
  subSegmentOrTheme?: string;
  geography: string;
  minimumCAGR: string;             // '5' | '8' | '12' | '18'
  outputMode: NicheOutputMode;
  additionalContext?: string;
  numberOfTopics: number;           // 8 | 12 | 16
  segmentationDepth: NicheSegmentationDepth;
}

export interface NicheTopicRow {
  topic_title: string;
  type: 'white_space' | 'bestseller';
  estimated_cagr: string;
  base_market_size: string;
  white_space_score: number;        // 1–10
  competition_level: 'none' | 'low' | 'moderate' | 'high';
  primary_growth_driver: string;
  segmentation_axes: string[];
  verdict: 'strong buy' | 'pursue' | 'monitor';
  rationale: string;
}

export interface NicheIndustryResult {
  jobId: string;
  status: 'pending' | 'researching' | 'synthesizing' | 'complete' | 'error';
  progress: number;
  currentStep?: string;
  topics?: NicheTopicRow[];
  error?: string;
  createdAt: string;
  completedAt?: string;
}

// ══════════════════════════════════════════════════════════════════════════════
// MARKETING STRATEGY FRAMEWORK
// ══════════════════════════════════════════════════════════════════════════════

export type StrategyFramework =
  | 'BCG Matrix'
  | 'SWOT'
  | 'Porters Five Forces'
  | 'Ansoff Matrix'
  | '4P/7P Marketing Mix'
  | 'AIDA'
  | 'PESTEL'
  | 'North Star'
  | 'Flywheel Model'
  | 'Blue Ocean'
  | '7S Framework'
  | 'GE-McKinsey Matrix'
  | 'Eisenhower Matrix';

export interface MarketingStrategyInput {
  industryOrSegment: string;
  framework: StrategyFramework;
  productContext?: string;
  additionalContext?: string;
}

export interface StrategyDimensionRow {
  dimension: string;
  element: string;
  analysis: string;
  strategicImplication: string;
  priority: 'High' | 'Medium' | 'Low';
}

export interface MarketingStrategyResult {
  jobId: string;
  status: 'pending' | 'researching' | 'synthesizing' | 'complete' | 'error';
  progress: number;
  currentStep?: string;
  industryOrSegment?: string;
  framework?: StrategyFramework;
  frameworkSummary?: string;
  dimensions?: StrategyDimensionRow[];
  strategicRecommendations?: string[];
  error?: string;
  createdAt: string;
  completedAt?: string;
}

