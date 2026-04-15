import Anthropic from '@anthropic-ai/sdk';
import {
  BenchmarkInput, BenchmarkDimension, GapAnalysisRow,
  ThemeInput, ThemeRow,
  ChallengesGrowthInput, ChallengesGrowthRow,
  FinancialAnalysisInput, FinancialAnalysisResult,
  RevenueDataPoint, MarginDataPoint, FinancialStatementRow,
  FinancialSegmentRow, GeoRow, KeyHighlightsStructured,
  SalesPlayInput,
  SalesPlayPriorityRow, SalesPlayIndustrySolution, SalesPlayPartner,
  SalesPlayCaseStudy, SalesPlayPriorityMapping, SalesPlayObjectionRebuttal,
  KeyBuyersInput, KeyBuyerRow,
  IndustryTrendsInput, IndustryTrendRow,
  IndustryReportInput, IndustryReportScope, MarketSizingData,
  ReportSection, ExecutiveSummary, ExecutiveSummaryTickerBox,
  ScopeWizardResult, MarketSegmentOption, KeyPlayerOption,
  MacroTEIData, BCGMatrixItem, CompetitorProfile,
} from '../types';

// Returns true when a research string contains no real data
function isEmptyResearch(text: string): boolean {
  return !text || text.startsWith('Research unavailable') || text.trim().length < 50;
}

const rawClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Retry wrapper — handles transient Anthropic overload / rate-limit errors ──
// 529 overloaded_error, 529, 503, 500, and 429 are all retryable. We retry up
// to 5 times with exponential backoff + jitter (≈1s, 2s, 4s, 8s, 16s). The
// underlying SDK already retries network errors; this layer adds resilience to
// Anthropic-side capacity events that previously failed jobs outright.
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 529]);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isRetryable(err: any): boolean {
  if (!err) return false;
  const status = err.status ?? err.statusCode;
  if (typeof status === 'number' && RETRYABLE_STATUSES.has(status)) return true;
  const msg = String(err.message || err).toLowerCase();
  return msg.includes('overloaded') || msg.includes('rate limit') || msg.includes('timeout');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const originalCreate = rawClient.messages.create.bind(rawClient.messages);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
rawClient.messages.create = (async (...args: any[]) => {
  const maxAttempts = 5;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return await (originalCreate as any)(...args);
    } catch (err) {
      lastErr = err;
      if (attempt === maxAttempts || !isRetryable(err)) throw err;
      const base = 1000 * Math.pow(2, attempt - 1); // 1s, 2s, 4s, 8s
      const jitter = Math.floor(Math.random() * 500);
      const delay = base + jitter;
      // eslint-disable-next-line no-console
      console.warn(
        `[claudeAI] attempt ${attempt}/${maxAttempts} failed (${(err as { status?: number })?.status ?? '?'}), retrying in ${delay}ms`
      );
      await sleep(delay);
    }
  }
  throw lastErr;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
}) as any;

const client = rawClient;

// Token budget optimization
const MAX_OUTPUT_TOKENS = 4096;  // keep original for reliability, optimizations come via other means

// Model selection
const SYNTHESIS_MODEL = 'claude-sonnet-4-6';
// Note: Haiku model (claude-3-5-haiku-20241022) not available in current API access
// Keeping Sonnet for all tasks, but optimized with lower token budgets and temperatures

// ── Truncate research to stay within token budget ───────────────────────────

function truncateResearch(research: Record<string, string>, maxChars = 30000): Record<string, string> {
  const perCompany = Math.floor(maxChars / Math.max(Object.keys(research).length, 1));
  return Object.fromEntries(
    Object.entries(research).map(([company, text]) => [
      company,
      text.length > perCompany ? text.slice(0, perCompany) + '\n[truncated]' : text,
    ])
  );
}

// ── Robust JSON array parser — recovers complete objects from truncated output ─

function safeParseJsonArray(raw: string): unknown[] | null {
  // 1. Try a clean full parse first
  const match = raw.match(/\[[\s\S]*\]/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // fall through to recovery
    }
  }

  // 2. Extract every complete top-level {...} object from the raw string
  //    Works even when the closing ] is missing or the last object is truncated
  const objects: unknown[] = [];
  let depth = 0;
  let start = -1;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        try {
          objects.push(JSON.parse(raw.slice(start, i + 1)));
        } catch {
          // skip malformed object
        }
        start = -1;
      }
    }
  }

  return objects.length > 0 ? objects : null;
}

// ── Shared recency directive (injected into all system prompts) ─────────────
const RECENCY_DIRECTIVE = 'RECENCY RULE: Prioritize information from the last 3 years, with highest weight given to the most recent data. If conflicting data exists across time periods, always use the latest available information. Clearly note when data is older than 3 years.';

// ── Fast Competitor Discovery (Claude — no Parallel.AI) ─────────────────────

import { Competitor } from '../types';

export async function discoverCompetitorsFast(
  targetCompany: string,
  industryContext?: string
): Promise<Competitor[]> {
  const industryLine = industryContext
    ? `in the ${industryContext} industry`
    : '(determine the primary industry/sector first)';

  const message = await client.messages.create({
    model: SYNTHESIS_MODEL,
    max_tokens: 4096,
    messages: [{
      role: 'user',
      content: `Identify the top 8-10 direct competitors of "${targetCompany}" ${industryLine}.

For each competitor return a JSON object with these fields:
- name: Company name (exact legal or commonly known name)
- description: One-sentence business description
- headquarters: "City, Country"
- estimatedRevenue: Estimated annual revenue e.g. "$X billion"
- employees: Approximate employee count e.g. "~X,000"
- relevanceScore: 1-10 rating of how directly they compete with ${targetCompany}

Return ONLY a JSON array. No markdown fences, no explanation.
[{"name":"...","description":"...","headquarters":"...","estimatedRevenue":"...","employees":"...","relevanceScore":8}]

Only include direct competitors — companies competing for the same customers, contracts, or market segments as ${targetCompany}. Prioritize companies with publicly available technology/digital strategy information. IMPORTANT: Only include companies that are currently active and operating. Do NOT include companies that have shut down, filed for bankruptcy, been liquidated, or permanently exited the market.`,
    }],
    system: `You are a senior B2B sales intelligence analyst. Return ONLY valid JSON arrays. No commentary. ${RECENCY_DIRECTIVE}`,
  });

  const content = message.content[0];
  if (content.type !== 'text') throw new Error('Unexpected Claude response type');

  const jsonMatch = content.text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) throw new Error('Claude did not return valid JSON for competitors');

  const parsed = JSON.parse(jsonMatch[0]);
  if (!Array.isArray(parsed)) throw new Error('Expected JSON array for competitors');

  return parsed
    .filter((c: Competitor) => c.name && c.description)
    .slice(0, 10)
    .map((c: Competitor) => ({
      name: c.name,
      description: c.description,
      headquarters: c.headquarters,
      estimatedRevenue: c.estimatedRevenue,
      employees: c.employees,
      relevanceScore: typeof c.relevanceScore === 'number' ? c.relevanceScore : 7,
    }));
}

// ── Business Description ────────────────────────────────────────────────────

export async function generateBusinessDescription(
  companyName: string,
  domain?: string
): Promise<string> {
  const domainHint = domain ? ` (website: ${domain})` : '';

  const message = await client.messages.create({
    model: SYNTHESIS_MODEL,
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: `Write a concise business description of "${companyName}"${domainHint} in 100-250 words.

Include:
- What the company does (core products/services)
- Industry/sector it operates in
- Target customers/markets
- Key differentiators or market position
- Approximate scale (if publicly known: revenue range, employee count, geography)

Write in third person, professional tone. Return ONLY the description text — no headers, no bullet points, no markdown.`,
    }],
    system: `You are a business intelligence analyst. Write factual, concise company descriptions based on publicly available information. If you are unsure about specific details, focus on what is verifiable. ${RECENCY_DIRECTIVE}`,
  });

  const content = message.content[0];
  if (content.type !== 'text') throw new Error('Unexpected Claude response type');
  return content.text.trim();
}

// ── Benchmarking Table Synthesis ─────────────────────────────────────────────

export async function synthesizeBenchmarkingTable(
  input: BenchmarkInput,
  companyResearch: Record<string, string>
): Promise<BenchmarkDimension[]> {
  const safeResearch = truncateResearch(companyResearch);
  const peerNames = input.selectedCompetitors.join(', ');

  const missingResearch = Object.entries(safeResearch)
    .filter(([, text]) => isEmptyResearch(text))
    .map(([company]) => company);

  const systemPrompt = `You are a senior B2B sales intelligence analyst. You produce precise, evidence-based competitive analysis.
- Where provided research data exists, cite it specifically (systems, vendors, percentages).
- Where research data is missing or sparse for a company, draw on your training knowledge — label it "(est.)" or "(based on public sources)".
- Never leave a cell empty — always provide a meaningful best-known answer.
- FORMATTING: Each value field MUST be formatted as bullet points separated by " • ". Wrap the most important keyword or phrase in each bullet with **double asterisks** for emphasis. Example: "**SAP S/4HANA** deployed across 12 regions • **AI-powered** demand forecasting in pilot • Cloud migration **60% complete**"
- Output ONLY valid JSON. No markdown fences, no explanation outside the JSON.
- ${RECENCY_DIRECTIVE}`;

  const userPrompt = `Synthesize the following research into a peer benchmarking table comparing "${input.targetCompany}" against: ${peerNames}.

Selling org: "${input.userOrganization}"${input.industryContext ? ` | Industry: ${input.industryContext}` : ' | Industry: (determine from target company and competitors)'}${input.focusAreas ? ` | Focus: ${input.focusAreas}` : ''}
${missingResearch.length > 0 ? `NOTE: No live research for ${missingResearch.join(', ')} — use training knowledge.` : ''}

RESEARCH DATA:
${Object.entries(safeResearch)
    .map(([co, r]) => `### ${co}\n${isEmptyResearch(r) ? `[Use training knowledge for ${co}]` : r}`)
    .join('\n---\n')}

Return a JSON array with EXACTLY this shape (one object per dimension):
[{"dimension":"...","targetCompany":{"value":"...","notes":"..."},"peers":{"${input.selectedCompetitors[0] ?? 'Peer1'}":{"value":"...","notes":"..."}}}]

DYNAMIC DIMENSIONS:
- Analyse the research data and identify EXACTLY 5 strategic dimensions that best differentiate and compare these companies.
- Pick dimensions that are most relevant to ${input.targetCompany}'s industry, competitive landscape, and where the research data reveals meaningful differences.
- Examples of good dimensions: "AI / ML & Automation", "ERP & Core IT Stack", "Digital Commerce Strategy", "Cloud & Infrastructure", "Supply Chain Technology", "Cybersecurity Posture", "Data & Analytics Platform", "Sustainability & ESG Tech" — but choose what fits the data best.
${input.focusAreas ? `- IMPORTANT: Ensure at least one dimension directly addresses the focus area: "${input.focusAreas}".` : ''}
- Each dimension name should be concise (3-6 words).
- Return EXACTLY 5 dimension objects in the array.`;

  const message = await client.messages.create({
    model: SYNTHESIS_MODEL,
    max_tokens: MAX_OUTPUT_TOKENS,
    messages: [{ role: 'user', content: userPrompt }],
    system: systemPrompt,
  });

  const content = message.content[0];
  if (content.type !== 'text') throw new Error('Unexpected Claude response type');

  return parseBenchmarkingTable(content.text);
}

function parseBenchmarkingTable(raw: string): BenchmarkDimension[] {
  const items = safeParseJsonArray(raw);
  if (!items || items.length === 0) {
    throw new Error('Claude did not return valid JSON for benchmarking table');
  }
  return (items as BenchmarkDimension[]).filter((row) => row.dimension && row.targetCompany && row.peers);
}

// ── Gap Analysis Synthesis ───────────────────────────────────────────────────

export async function synthesizeGapAnalysis(
  input: BenchmarkInput,
  companyResearch: Record<string, string>,
  benchmarkingTable: BenchmarkDimension[]
): Promise<GapAnalysisRow[]> {
  // Keep per-company research short — the table is the primary source
  const safeResearch = truncateResearch(companyResearch, 15000);
  const peerNames = input.selectedCompetitors.join(', ');

  const missingResearch = Object.entries(safeResearch)
    .filter(([, text]) => isEmptyResearch(text))
    .map(([company]) => company);

  const dimensions = benchmarkingTable.map(d => d.dimension);

  const systemPrompt = `You are a senior B2B sales intelligence analyst producing gap analyses for enterprise sales.
Rules:
- Draw primarily from the benchmarking table already compiled; use research data as supplementary context.
- Map SPECIFIC products from the selling org's portfolio to each gap (not generic capability names).
- Never leave any field empty.
- FORMATTING: All text fields (peersBestPractice, solutionFit) MUST be formatted as bullet points separated by " • ". Wrap the most important keyword or phrase in each bullet with **double asterisks** for emphasis. Example: "**Real-time analytics** across supply chain • **Automated procurement** reducing cycle time by 40%"
- Output ONLY valid JSON. No markdown fences, no text outside the JSON array.
- ${RECENCY_DIRECTIVE}`;

  const userPrompt = `Create a gap analysis for "${input.targetCompany}" vs peers: ${peerNames}.

Selling org: "${input.userOrganization}"${input.solutionPortfolio ? ` | Portfolio: ${input.solutionPortfolio}` : ''}
${input.industryContext ? `Industry: ${input.industryContext}` : 'Industry: (determine from target company and benchmarking table)'}
${missingResearch.length > 0 ? `NOTE: No live research for ${missingResearch.join(', ')} — rely on benchmarking table + training knowledge.` : ''}

BENCHMARKING TABLE (compact):
${JSON.stringify(benchmarkingTable)}

SUPPLEMENTARY RESEARCH (summary per company, max 4000 chars each):
${Object.entries(safeResearch)
    .map(([co, r]) => `### ${co}\n${isEmptyResearch(r) ? `[Use training knowledge]` : r.slice(0, 4000)}`)
    .join('\n---\n')}

Return a JSON array with EXACTLY this shape (one object per dimension):
[{"dimension":"...","peersBestPractice":"...","gapLevel":"RED","solutionFit":"..."}]

Fields:
- dimension: The benchmarking dimension name (use EXACTLY the same dimension names from Table 1)
- peersBestPractice: What the leading peers are doing in this dimension — cite specific vendors, systems, percentages
- gapLevel: "RED" (critical gap), "AMBER" (partial gap), or "GREEN" (strength/parity) — assess ${input.targetCompany}'s position vs peers
- solutionFit: How ${input.userOrganization}'s specific solutions/products address this gap — be concrete, name specific offerings

DIMENSIONS TO COVER (one array element each, derived from Table 1):
${dimensions.map((d, i) => `${i + 1}. ${d}`).join('\n')}

Return EXACTLY ${dimensions.length} objects, one per dimension above.`;

  const message = await client.messages.create({
    model: SYNTHESIS_MODEL,
    max_tokens: MAX_OUTPUT_TOKENS,
    messages: [{ role: 'user', content: userPrompt }],
    system: systemPrompt,
  });

  const content = message.content[0];
  if (content.type !== 'text') throw new Error('Unexpected Claude response type');

  return parseGapAnalysis(content.text);
}

function parseGapAnalysis(raw: string): GapAnalysisRow[] {
  const items = safeParseJsonArray(raw);
  if (!items || items.length === 0) {
    throw new Error('Claude did not return valid JSON for gap analysis');
  }
  return (items as GapAnalysisRow[]).filter((row) => row.dimension && row.gapLevel);
}

// ── Themes Synthesis ──────────────────────────────────────────────────────────

const THEME_CONFIG: Record<string, { label: string; hint: string }> = {
  business: {
    label: 'Business Themes',
    hint: 'Identify 6-8 strategic themes covering areas such as: Revenue Growth Strategy, M&A & Partnerships, Operational Excellence, Customer Experience Transformation, Workforce & Talent, Market Expansion, Risk & Compliance, Capital Allocation.',
  },
  technology: {
    label: 'Technology Themes',
    hint: 'Identify 6-8 technology themes covering areas such as: Digital Transformation, Cloud Strategy, AI / ML Adoption, Data & Analytics, Cybersecurity, ERP & Core Systems Modernisation, Automation & RPA, Developer & Platform Strategy.',
  },
  sustainability: {
    label: 'Sustainability Themes',
    hint: 'Identify 6-8 sustainability themes covering areas such as: Net Zero & Carbon Reduction, Renewable Energy Transition, Supply Chain Sustainability, ESG Reporting & Disclosure, Circular Economy & Waste Reduction, Social Impact & DEI, Water & Resource Management, Governance & Ethics.',
  },
};

export async function synthesizeThemes(
  input: ThemeInput,
  research: string
): Promise<ThemeRow[]> {
  const config = THEME_CONFIG[input.themeType];
  const hasResearch = !isEmptyResearch(research);

  const systemPrompt = `You are a senior B2B sales intelligence analyst producing executive-grade theme analyses.
- Draw on the provided research first; supplement with your training knowledge where research is sparse — label estimates "(est.)".
- Each theme must be concrete and evidence-based, not generic.
- Never produce empty fields — always provide a meaningful answer.
- Output ONLY valid JSON. No markdown fences, no text outside the JSON array.
- ${RECENCY_DIRECTIVE}`;

  const userPrompt = `Analyse the following research on "${input.companyName}" and identify their top ${config.label}.

${config.hint}

${hasResearch ? `RESEARCH:\n${research.slice(0, 20000)}` : `[No live research available — use your training knowledge about ${input.companyName}. Label estimates as "(est.)".]`}

${input.userOrganization ? `Selling organisation: "${input.userOrganization}"${input.solutionPortfolio ? ` | Portfolio: ${input.solutionPortfolio}` : ''}` : ''}

Return a JSON array with EXACTLY this shape (one object per theme, 6-8 themes total):
[
  {
    "theme": "Short punchy theme name (3-5 words)",
    "description": "3-4 bullet points (each starting with '• ' and separated by newlines): what this theme means for ${input.companyName} — be specific, cite programmes, executives, or data where available.",
    "examples": "Concrete example 1 | Concrete example 2 | Concrete example 3",
    "strategicImpact": "2-3 bullet points (each starting with '• ' and separated by newlines): the strategic significance and what it signals about ${input.companyName}'s direction."
  }
]`;

  const message = await client.messages.create({
    model: SYNTHESIS_MODEL,
    max_tokens: MAX_OUTPUT_TOKENS,
    messages: [{ role: 'user', content: userPrompt }],
    system: systemPrompt,
  });

  const content = message.content[0];
  if (content.type !== 'text') throw new Error('Unexpected Claude response type');

  return parseThemes(content.text);
}

function parseThemes(raw: string): ThemeRow[] {
  const items = safeParseJsonArray(raw);
  if (!items || items.length === 0) {
    throw new Error('Claude did not return valid JSON for themes');
  }
  return (items as ThemeRow[]).filter((row) => row.theme && row.description);
}

// ── Challenges & Growth Synthesis ─────────────────────────────────────────────

export async function synthesizeChallengesGrowth(
  input: ChallengesGrowthInput,
  research: string
): Promise<ChallengesGrowthRow[]> {
  const hasResearch = !isEmptyResearch(research);

  const systemPrompt = `You are a senior B2B sales intelligence analyst producing executive-grade competitive analysis.
Rules:
- Use the provided research first; supplement with training knowledge where research is sparse — label estimates "(est.)".
- Be specific: cite programmes, metrics, named initiatives, competitor names, and market data.
- Every cell must have substantive content — no vague generalities, no empty fields.
- Output ONLY valid JSON. No markdown fences, no text outside the JSON array.
- ${RECENCY_DIRECTIVE}`;

  const userPrompt = `Analyse the following research on "${input.companyName}" and produce a Challenges & Growth analysis.

Cover EXACTLY these 8 dimensions (one array element each, in this order):
1. Macroeconomics
2. Supply Chain & Operations
3. Demand & Customer
4. Regulatory & Compliance
5. Pricing & Margin
6. Competition
7. Technology & Innovation
8. Talent & Workforce

${hasResearch
  ? `RESEARCH:\n${research.slice(0, 20000)}`
  : `[No live research available — use training knowledge about ${input.companyName}. Label estimates as "(est.)".]`}

${input.userOrganization
  ? `Selling organisation: "${input.userOrganization}"${input.solutionPortfolio ? ` | Portfolio: ${input.solutionPortfolio}` : ''}`
  : ''}

Return a JSON array with EXACTLY this shape (8 objects):
[
  {
    "dimension": "Macroeconomics",
    "challenge": "2-4 bullet points (each starting with '• ' separated by newlines): the most material challenge in this dimension — be specific, name rates, geographies, data points.",
    "growthProspect": "2-4 bullet points (each starting with '• ' separated by newlines): the most compelling growth opportunity — cite specific markets, demographics, or policy drivers."
  }
]

For EACH dimension:
- "challenge": 2-4 bullet points (each line starts with "• "): the most material, specific challenges — cite data, name the threat, quantify where possible.
- "growthProspect": 2-4 bullet points (each line starts with "• "): the most compelling growth opportunities — forward-looking, specific, actionable insights.`;

  const message = await client.messages.create({
    model: SYNTHESIS_MODEL,
    max_tokens: MAX_OUTPUT_TOKENS,
    messages: [{ role: 'user', content: userPrompt }],
    system: systemPrompt,
  });

  const content = message.content[0];
  if (content.type !== 'text') throw new Error('Unexpected Claude response type');

  return parseChallengesGrowth(content.text);
}

function parseChallengesGrowth(raw: string): ChallengesGrowthRow[] {
  const items = safeParseJsonArray(raw);
  if (!items || items.length === 0) {
    throw new Error('Claude did not return valid JSON for challenges & growth');
  }
  return (items as ChallengesGrowthRow[]).filter((row) => row.dimension && row.challenge && row.growthProspect);
}

// ── Financial Analysis — Public Company Insights + Segment/Geo ────────────────

interface FinancialInsightsPayload {
  revenueInsight: string;
  marginInsight: string;
  segmentInsight?: string;
  geoInsight?: string;
  plInsight: string;
  bsInsight: string;
  cfInsight: string;
  keyHighlights: KeyHighlightsStructured;
  chartInsights: string[];
  geoSegmentInsights: string[];
  segmentRevenue?: FinancialSegmentRow[];
  geoRevenue?: GeoRow[];
  // Fallback arrays extracted from Parallel.AI research when Yahoo Finance is empty
  revenueHistoryExtracted?: RevenueDataPoint[];
  marginHistoryExtracted?: MarginDataPoint[];
  plStatementExtracted?: FinancialStatementRow[];
  balanceSheetExtracted?: FinancialStatementRow[];
  cashFlowExtracted?: FinancialStatementRow[];
}

export async function synthesizeFinancialInsights(
  input: FinancialAnalysisInput,
  yahooData: Partial<FinancialAnalysisResult>,
  parallelResearch: string
): Promise<FinancialInsightsPayload> {
  const hasParallelResearch = !isEmptyResearch(parallelResearch);

  // Determine which arrays Yahoo Finance returned (empty = needs extraction from research)
  const needRevenueExtract = (yahooData.revenueHistory?.length ?? 0) === 0;
  const needMarginExtract  = (yahooData.marginHistory?.length  ?? 0) === 0;
  const needPLExtract      = (yahooData.plStatement?.length    ?? 0) === 0;
  const needBSExtract      = (yahooData.balanceSheet?.length   ?? 0) === 0;
  const needCFExtract      = (yahooData.cashFlow?.length       ?? 0) === 0;

  const systemPrompt = `You are a senior equity analyst producing institutional-grade financial commentary.
Rules:
- Be specific: cite figures, percentages, year-on-year changes, named programmes.
- Insights must be 3-5 sentences each — analytical and forward-looking, not descriptive.
- Key highlights must be brief bullets suitable for an executive summary.
- For segment/geo data: extract from research if provided; otherwise use your training knowledge to populate these arrays for well-known companies — never leave both empty if you know the answer.
- When extracting financial statement rows, include 8-15 key line items per statement.
- Output ONLY valid JSON. No markdown fences, no text outside the JSON.
- ${RECENCY_DIRECTIVE}`;

  // Compact the Yahoo data for context
  const revenueStr = (yahooData.revenueHistory || [])
    .map((r: RevenueDataPoint) => `${r.year}: ${r.revenueFormatted}${r.yoyGrowth != null ? ` (${r.yoyGrowth >= 0 ? '+' : ''}${r.yoyGrowth}% YoY)` : ''}`)
    .join(', ');
  const marginStr = (yahooData.marginHistory || [])
    .map((m: MarginDataPoint) => `${m.year}: Net ${m.netMargin}% / Op ${m.operatingMargin}%`)
    .join(', ');
  const plStr = (yahooData.plStatement || [])
    .filter((r: FinancialStatementRow) => r.isBold || r.isSection)
    .map((r: FinancialStatementRow) => `${r.label}: ${r.value}${r.yoy ? ` (${r.yoy} YoY)` : ''}`)
    .join(' | ');
  const bsStr = (yahooData.balanceSheet || [])
    .filter((r: FinancialStatementRow) => r.isBold || r.isSection)
    .map((r: FinancialStatementRow) => `${r.label}: ${r.value}`)
    .join(' | ');
  const cfStr = (yahooData.cashFlow || [])
    .filter((r: FinancialStatementRow) => r.isBold || r.isSection)
    .map((r: FinancialStatementRow) => `${r.label}: ${r.value}`)
    .join(' | ');

  const reportingCurrency = yahooData.currency || 'USD';
  const userPrompt = `Analyse the financial data for "${input.companyName}" (ticker: ${yahooData.ticker || 'N/A'}) and produce structured insights.
Reporting currency: ${reportingCurrency}. Use the correct currency symbol for ${reportingCurrency} in all formatted monetary values (e.g. revenueFormatted, segment/geo revenue strings, P&L/BS/CF value fields). Do NOT default to "$" if the currency is not USD.

## Google Finance Data (structured, pre-verified numbers)
Revenue History: ${revenueStr || 'NOT AVAILABLE'}
Margin History: ${marginStr || 'NOT AVAILABLE'}
P&L Highlights: ${plStr || 'NOT AVAILABLE'}
Balance Sheet Highlights: ${bsStr || 'NOT AVAILABLE'}
Cash Flow Highlights: ${cfStr || 'NOT AVAILABLE'}

## Extraction Status
${needRevenueExtract ? '⚠ Revenue History MISSING from Finance API — EXTRACT from research or training knowledge' : '✓ Revenue History available above — set revenueHistoryExtracted: []'}
${needMarginExtract  ? '⚠ Margin History MISSING from Finance API — EXTRACT from research or training knowledge' : '✓ Margin History available above — set marginHistoryExtracted: []'}
${needPLExtract      ? '⚠ P&L Statement MISSING from Finance API — EXTRACT from research or training knowledge' : '✓ P&L Statement available above — set plStatementExtracted: []'}
${needBSExtract      ? '⚠ Balance Sheet MISSING from Finance API — EXTRACT from research or training knowledge' : '✓ Balance Sheet available above — set balanceSheetExtracted: []'}
${needCFExtract      ? '⚠ Cash Flow MISSING from Finance API — EXTRACT from research or training knowledge' : '✓ Cash Flow available above — set cashFlowExtracted: []'}

## Additional Research (annual reports, investor presentations, financial news)
${hasParallelResearch ? parallelResearch.slice(0, 20000) : '[Not available — use the Google Finance data above and your training knowledge]'}

Return a single JSON object with EXACTLY this structure:
{
  "revenueInsight": "3-5 sentences analysing the revenue trend, growth rate trajectory, and what it signals about competitive positioning and market share.",
  "marginInsight": "3-5 sentences on margin evolution — what is driving expansion or compression, how it compares to sector peers, and the path forward.",
  "plInsight": "3-5 sentences on the P&L — the most significant items, cost structure efficiency, and any one-time items or structural shifts.",
  "bsInsight": "3-5 sentences on balance sheet health — liquidity, leverage, capital allocation, and balance sheet flexibility.",
  "cfInsight": "3-5 sentences on cash generation quality — operating cash conversion, capex intensity, free cash flow, and capital returns.",
  "keyHighlights": {
    "overallPerformance": "3-5 bullet points (each starting with '• '): overall financial health, revenue scale, profitability status, and market position.",
    "overallPerformanceTagline": "3-6 word phrase summarising the main point, e.g. 'Strong revenue, margin pressure'",
    "factorsDrivingGrowth": "3-5 bullet points (each starting with '• '): specific factors, products, segments, or markets driving revenue and profit growth.",
    "factorsDrivingGrowthTagline": "3-6 word phrase, e.g. 'Cloud & AI segment surge'",
    "factorsInhibitingGrowth": "3-5 bullet points (each starting with '• '): headwinds, risks, competitive pressures, or structural challenges limiting growth.",
    "factorsInhibitingGrowthTagline": "3-6 word phrase, e.g. 'Rising input costs, FX headwinds'",
    "futureStrategy": "3-5 bullet points (each starting with '• '): management's stated strategic priorities, capital allocation plans, M&A activity, or transformation initiatives.",
    "futureStrategyTagline": "3-6 word phrase, e.g. 'Pivot to platform model'",
    "growthOutlook": "3-5 bullet points (each starting with '• '): forward-looking growth prospects, analyst consensus, guidance, and catalysts or risks on the horizon.",
    "growthOutlookTagline": "3-6 word phrase, e.g. 'Moderate growth ahead'"
  },
  "chartInsights": [
    "Bullet 1: key observation about revenue trajectory over the last 5 years",
    "Bullet 2: significant margin trend or inflection point",
    "Bullet 3: quarterly momentum — is performance accelerating or decelerating?",
    "Bullet 4: any notable one-off events affecting recent revenue or margins"
  ],
  "segmentRevenue": [
    { "segment": "Segment Name", "revenue": "$X.XB", "percentage": 42.5, "yoyGrowth": "+8.2%" }
  ],
  "geoRevenue": [
    { "region": "Americas", "revenue": "$X.XB", "percentage": 55.0, "yoyGrowth": "+8.2%" }
  ],
  "segmentInsight": "3-5 sentences on segment mix — which segments are growing, which are declining, and what the mix shift means strategically. Set to null if no segment data available.",
  "geoInsight": "3-5 sentences on geographic mix — regional growth rates, concentration risk, and international expansion signals. Set to null if no geo data available.",
  "geoSegmentInsights": [
    "Bullet 1: which geography or segment is the largest revenue contributor",
    "Bullet 2: fastest-growing region or segment and why",
    "Bullet 3: any region or segment showing decline or underperformance",
    "Bullet 4: diversification or concentration risk assessment"
  ],
  "revenueHistoryExtracted": [
    { "year": "2023", "revenue": 383285000000, "revenueFormatted": "$383.3B", "yoyGrowth": -2.8 }
  ],
  "marginHistoryExtracted": [
    { "year": "2023", "netMargin": 25.3, "operatingMargin": 29.8 }
  ],
  "plStatementExtracted": [
    { "label": "Revenue", "value": "$383.3B", "previousValue": "$394.3B", "yoy": "-2.8%", "isBold": true },
    { "label": "Cost of Revenue", "value": "$214.1B", "previousValue": "$223.5B", "yoy": "-4.2%", "isBold": false },
    { "label": "Gross Profit", "value": "$169.1B", "previousValue": "$170.8B", "yoy": "-1.0%", "isBold": true }
  ],
  "balanceSheetExtracted": [
    { "label": "Total Assets", "value": "$352.6B", "previousValue": "$338.5B", "yoy": "+4.2%", "isBold": true },
    { "label": "Total Liabilities", "value": "$290.4B", "previousValue": "$287.9B", "yoy": "+0.9%", "isBold": true }
  ],
  "cashFlowExtracted": [
    { "label": "Operating Cash Flow", "value": "$114.0B", "previousValue": "$122.2B", "yoy": "-6.7%", "isBold": true },
    { "label": "Capital Expenditure", "value": "-$11.0B", "previousValue": "-$10.7B", "isBold": false }
  ]
}

Extraction rules:
- revenueHistoryExtracted / marginHistoryExtracted: 3-5 years newest-first. revenue must be raw integer in ${yahooData.currency || 'USD'} (e.g. 383285000000). Percentages as numbers not strings. All monetary values should use ${yahooData.currency || 'USD'} currency.
- plStatementExtracted / balanceSheetExtracted / cashFlowExtracted: 8-15 key rows. MUST include BOTH current year ("value") AND previous year ("previousValue") for every data row. Include "yoy" percentage change where calculable. isSection=true for category headers (value=""). isBold=true for subtotals/totals. The "value" field is the most recent fiscal year; "previousValue" is the year before that.
- Per the Extraction Status above, set an extracted array to [] when the Finance API data is already available.
- For segmentRevenue and geoRevenue: populate from research if available, otherwise populate from your training knowledge for this company. Return [] only if you genuinely don't know the segment/geo breakdown.
- For insights: draw on BOTH the Finance API data above and your training knowledge — be specific, cite figures.`;

  const message = await client.messages.create({
    model: SYNTHESIS_MODEL,
    max_tokens: MAX_OUTPUT_TOKENS,
    messages: [{ role: 'user', content: userPrompt }],
    system: systemPrompt,
  });

  const content = message.content[0];
  if (content.type !== 'text') throw new Error('Unexpected Claude response type');

  return parseFinancialInsights(content.text);
}

function parseFinancialInsights(raw: string): FinancialInsightsPayload {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Claude did not return valid JSON for financial insights');
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parsed = JSON.parse(match[0]) as any;

    // Handle keyHighlights — may be structured object or legacy array
    let keyHighlights: KeyHighlightsStructured;
    if (parsed.keyHighlights && typeof parsed.keyHighlights === 'object' && !Array.isArray(parsed.keyHighlights)) {
      keyHighlights = {
        overallPerformance: parsed.keyHighlights.overallPerformance || '',
        overallPerformanceTagline: parsed.keyHighlights.overallPerformanceTagline || undefined,
        factorsDrivingGrowth: parsed.keyHighlights.factorsDrivingGrowth || '',
        factorsDrivingGrowthTagline: parsed.keyHighlights.factorsDrivingGrowthTagline || undefined,
        factorsInhibitingGrowth: parsed.keyHighlights.factorsInhibitingGrowth || '',
        factorsInhibitingGrowthTagline: parsed.keyHighlights.factorsInhibitingGrowthTagline || undefined,
        futureStrategy: parsed.keyHighlights.futureStrategy || '',
        futureStrategyTagline: parsed.keyHighlights.futureStrategyTagline || undefined,
        growthOutlook: parsed.keyHighlights.growthOutlook || '',
        growthOutlookTagline: parsed.keyHighlights.growthOutlookTagline || undefined,
      };
    } else {
      // Legacy fallback: convert array to structured
      const arr = Array.isArray(parsed.keyHighlights) ? parsed.keyHighlights : [];
      keyHighlights = {
        overallPerformance: arr[0] || '',
        factorsDrivingGrowth: arr[1] || '',
        factorsInhibitingGrowth: arr[2] || '',
        futureStrategy: arr[3] || '',
        growthOutlook: arr[4] || '',
      };
    }

    return {
      revenueInsight: parsed.revenueInsight || '',
      marginInsight: parsed.marginInsight || '',
      segmentInsight: parsed.segmentInsight || undefined,
      geoInsight: parsed.geoInsight || undefined,
      plInsight: parsed.plInsight || '',
      bsInsight: parsed.bsInsight || '',
      cfInsight: parsed.cfInsight || '',
      keyHighlights,
      chartInsights: Array.isArray(parsed.chartInsights) ? parsed.chartInsights : [],
      geoSegmentInsights: Array.isArray(parsed.geoSegmentInsights) ? parsed.geoSegmentInsights : [],
      segmentRevenue: Array.isArray(parsed.segmentRevenue) ? parsed.segmentRevenue : [],
      geoRevenue: Array.isArray(parsed.geoRevenue) ? parsed.geoRevenue : [],
      // Fallback arrays extracted from research
      revenueHistoryExtracted: Array.isArray(parsed.revenueHistoryExtracted) && parsed.revenueHistoryExtracted.length > 0
        ? parsed.revenueHistoryExtracted : undefined,
      marginHistoryExtracted: Array.isArray(parsed.marginHistoryExtracted) && parsed.marginHistoryExtracted.length > 0
        ? parsed.marginHistoryExtracted : undefined,
      plStatementExtracted: Array.isArray(parsed.plStatementExtracted) && parsed.plStatementExtracted.length > 0
        ? parsed.plStatementExtracted : undefined,
      balanceSheetExtracted: Array.isArray(parsed.balanceSheetExtracted) && parsed.balanceSheetExtracted.length > 0
        ? parsed.balanceSheetExtracted : undefined,
      cashFlowExtracted: Array.isArray(parsed.cashFlowExtracted) && parsed.cashFlowExtracted.length > 0
        ? parsed.cashFlowExtracted : undefined,
    };
  } catch {
    throw new Error('Failed to parse Claude financial insights JSON');
  }
}

// ── Financial Analysis — Private Company ──────────────────────────────────────

interface PrivateCompanyPayload {
  estimatedRevenue: string;
  profitabilityMargin: string;
  estimatedYoyGrowth: string;
  fundingInfo?: string;
  lastValuation?: string;
  privateInsights: string[];
  privateKeyHighlights?: KeyHighlightsStructured;
}

export async function synthesizePrivateCompany(
  input: FinancialAnalysisInput,
  research: string
): Promise<PrivateCompanyPayload> {
  const hasResearch = !isEmptyResearch(research);

  const systemPrompt = `You are a senior investment analyst producing concise private company financial profiles.
Rules:
- Use provided research first; supplement with training knowledge where research is sparse — label estimates "(est.)".
- Be specific with ranges: "$800M–$1.2B" not "high revenue".
- Insights should be actionable intelligence, not generic descriptions.
- Output ONLY valid JSON. No markdown fences.
- ${RECENCY_DIRECTIVE}`;

  const userPrompt = `Produce a financial profile for private company "${input.companyName}".

${hasResearch ? `RESEARCH:\n${research.slice(0, 50000)}` : `[No live research — use training knowledge. Label all estimates as "(est.)"]`}

Return a JSON object with EXACTLY this structure:
{
  "estimatedRevenue": "DATA ONLY — just the number or range. e.g. '$2.4B' or '$800M–$1.2B'. NO sources, NO parenthetical qualifiers, NO narrative — just the figure.",
  "profitabilityMargin": "DATA ONLY — just the margin metric. e.g. 'EBITDA ~20-25%' or 'Net margin 12%'. NO sources, NO qualifiers — just the number.",
  "estimatedYoyGrowth": "DATA ONLY — just the growth figure. e.g. '+25-35% YoY' or '+18%'. NO sources, NO qualifiers — just the number.",
  "fundingInfo": "e.g. 'Series D | $450M total raised | Last round: $150M in 2023 (Tiger Global, Andreessen Horowitz)'",
  "lastValuation": "e.g. '$4.5B (Series D, 2023)' or 'Not publicly disclosed'",
  "privateInsights": [
    "3-5 sentence insight about the company's financial trajectory and competitive positioning",
    "Key risk factor visible from the financial and funding profile",
    "Most significant growth driver or market opportunity",
    "Notable recent development (acquisition, partnership, product launch, leadership change)"
  ],
  "privateKeyHighlights": {
    "overallPerformance": "3-5 bullet points (each starting with '• '): overall financial health, revenue scale, profitability status, and competitive positioning of this private company.",
    "overallPerformanceTagline": "3-6 word phrase summarising the main point, e.g. 'Rapid growth, pre-profit stage'",
    "factorsDrivingGrowth": "3-5 bullet points (each starting with '• '): specific factors, products, markets, or strategic moves driving this company's growth.",
    "factorsDrivingGrowthTagline": "3-6 word phrase, e.g. 'Enterprise adoption accelerating'",
    "factorsInhibitingGrowth": "3-5 bullet points (each starting with '• '): risks, competitive threats, market headwinds, or challenges limiting this company's growth.",
    "factorsInhibitingGrowthTagline": "3-6 word phrase, e.g. 'Intense competitive pressure'",
    "futureStrategy": "3-5 bullet points (each starting with '• '): the company's known strategic direction, upcoming product launches, expansion plans, or transformation initiatives.",
    "futureStrategyTagline": "3-6 word phrase, e.g. 'Global expansion push'",
    "growthOutlook": "3-5 bullet points (each starting with '• '): forward-looking assessment of the company's growth trajectory, market opportunity, and potential catalysts or risks.",
    "growthOutlookTagline": "3-6 word phrase, e.g. 'Strong upside potential'"
  }
}`;

  const message = await client.messages.create({
    model: SYNTHESIS_MODEL,
    max_tokens: MAX_OUTPUT_TOKENS,
    messages: [{ role: 'user', content: userPrompt }],
    system: systemPrompt,
  });

  const content = message.content[0];
  if (content.type !== 'text') throw new Error('Unexpected Claude response type');

  return parsePrivateCompany(content.text);
}

function parsePrivateCompany(raw: string): PrivateCompanyPayload {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Claude did not return valid JSON for private company');
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parsed = JSON.parse(match[0]) as any;

    let privateKeyHighlights: KeyHighlightsStructured | undefined;
    if (parsed.privateKeyHighlights && typeof parsed.privateKeyHighlights === 'object') {
      privateKeyHighlights = {
        overallPerformance: parsed.privateKeyHighlights.overallPerformance || '',
        overallPerformanceTagline: parsed.privateKeyHighlights.overallPerformanceTagline || undefined,
        factorsDrivingGrowth: parsed.privateKeyHighlights.factorsDrivingGrowth || '',
        factorsDrivingGrowthTagline: parsed.privateKeyHighlights.factorsDrivingGrowthTagline || undefined,
        factorsInhibitingGrowth: parsed.privateKeyHighlights.factorsInhibitingGrowth || '',
        factorsInhibitingGrowthTagline: parsed.privateKeyHighlights.factorsInhibitingGrowthTagline || undefined,
        futureStrategy: parsed.privateKeyHighlights.futureStrategy || '',
        futureStrategyTagline: parsed.privateKeyHighlights.futureStrategyTagline || undefined,
        growthOutlook: parsed.privateKeyHighlights.growthOutlook || '',
        growthOutlookTagline: parsed.privateKeyHighlights.growthOutlookTagline || undefined,
      };
    }

    return {
      estimatedRevenue: parsed.estimatedRevenue || 'Not publicly disclosed',
      profitabilityMargin: parsed.profitabilityMargin || 'Not publicly disclosed',
      estimatedYoyGrowth: parsed.estimatedYoyGrowth || 'Not publicly disclosed',
      fundingInfo: parsed.fundingInfo,
      lastValuation: parsed.lastValuation,
      privateInsights: Array.isArray(parsed.privateInsights) ? parsed.privateInsights : [],
      privateKeyHighlights,
    };
  } catch {
    throw new Error('Failed to parse private company JSON');
  }
}

// ── Sales Play Synthesis ───────────────────────────────────────────────────────

interface SalesPlayPayload {
  priorityTable: SalesPlayPriorityRow[];
  industrySolutions: SalesPlayIndustrySolution[];
  techSummary: string;
  technologyPartners: SalesPlayPartner[];
  siPartners: SalesPlayPartner[];
  caseStudies: SalesPlayCaseStudy[];
  priorityMapping: SalesPlayPriorityMapping[];
  competitiveStatement: string;
  objectionRebuttals: SalesPlayObjectionRebuttal[];
  callToAction: string;
}

export async function synthesizeSalesPlay(
  input: SalesPlayInput,
  research: string
): Promise<SalesPlayPayload> {
  const hasResearch    = !isEmptyResearch(research);
  const hasPriorities  = input.strategicPriorities && input.strategicPriorities.length > 0;
  const hasSolutions   = input.solutionAreas && input.solutionAreas.trim().length > 0;

  const priorityBlock = hasPriorities
    ? `TARGET'S STRATEGIC PRIORITIES (user-supplied — use these exactly):\n${input.strategicPriorities!.map((p, i) => `${i + 1}. ${p}`).join('\n')}`
    : `TARGET'S STRATEGIC PRIORITIES: NOT PROVIDED BY USER.
If the research below contains a "DISCOVERED STRATEGIC PRIORITIES" section, extract those priorities and use them as your priority list (4–5 items).
If no discovered priorities are in the research, derive 4–5 realistic strategic priorities for ${input.targetAccount} based on their industry, size, and any context in the research.
Use whatever priorities you identify consistently across priorityTable and priorityMapping.`;

  const solutionBlock = hasSolutions
    ? `YOUR SOLUTION AREAS (user-supplied): ${input.solutionAreas}`
    : `YOUR SOLUTION AREAS: NOT PROVIDED BY USER.
If the research below contains a "DISCOVERED SOLUTION AREAS" section, extract those as the solution portfolio.
Otherwise, identify ${input.yourCompany}'s most relevant solutions for ${input.targetIndustry} from your training knowledge.`;

  const priorityCountNote = hasPriorities
    ? `- priorityTable: EXACTLY ${input.strategicPriorities!.length} rows (one per priority above)\n- priorityMapping: EXACTLY ${input.strategicPriorities!.length} rows (matching priorityTable priorities)`
    : `- priorityTable: 4–5 rows (one per discovered/derived priority)\n- priorityMapping: same number of rows as priorityTable`;

  const systemPrompt = `You are a senior B2B sales strategist and competitive intelligence analyst.
Rules:
- Write in a confident, consultative tone — not salesy.
- Use data and evidence wherever possible; avoid vague, generic claims.
- Back every competitive differentiator with proof (case study outcome, analyst finding, review data).
- Use [Client A, Fortune 500 ${input.targetIndustry} Company] as placeholder when real client names are unavailable.
- Base competitor weaknesses ONLY on publicly known analyst reports, G2/Gartner reviews, or documented product gaps — never fabricate.
- When strategic priorities or solution areas were not user-supplied, derive them from research and use them consistently throughout.
- Output ONLY valid JSON. No markdown fences, no text outside the JSON.
- ${RECENCY_DIRECTIVE}`;

  const userPrompt = `Generate a comprehensive Sales Play document for the following engagement:

SELLING COMPANY: "${input.yourCompany}"
COMPETITOR TO DISPLACE: "${input.competitorName}"
TARGET ACCOUNT: "${input.targetAccount}" (Industry: ${input.targetIndustry})

${priorityBlock}

${solutionBlock}
${input.competitorWeaknesses ? `\nKNOWN COMPETITOR WEAKNESSES (user-supplied): ${input.competitorWeaknesses}` : ''}

${hasResearch ? `COMPETITIVE INTELLIGENCE RESEARCH:\n${research.slice(0, 55000)}` : '[No live research — use training knowledge. Label estimates as "(est.)"]'}

Return a single JSON object with EXACTLY this structure:
{
  "priorityTable": [
    {
      "priority": "Priority name (from user-supplied list, or discovered/derived — be consistent)",
      "companySolution": "2-3 bullet points (each starting with '• ' separated by newlines): how ${input.yourCompany}'s solution directly addresses this priority with specifics",
      "proofPoints": "2-3 bullet points (each starting with '• ' separated by newlines): cite metrics, case study outcomes, or industry recognitions",
      "whyNotCompetitor": "2-3 bullet points (each starting with '• ' separated by newlines): evidence-backed reasons ${input.competitorName} falls short on this specific priority"
    }
  ],
  "industrySolutions": [
    {
      "name": "Solution name",
      "problemSolved": "Specific problem this solves for ${input.targetIndustry} companies",
      "description": "1-2 sentence description of the solution and its key differentiator"
    }
  ],
  "techSummary": "3-5 bullet points (each starting with '• ' separated by newlines): ${input.yourCompany}'s technology stack, proprietary AI/ML capabilities, cloud architecture, and what fundamentally differentiates it from ${input.competitorName}",
  "technologyPartners": [
    { "name": "Technology partner name", "capability": "What this partnership enables for ${input.targetIndustry} clients specifically" }
  ],
  "siPartners": [
    { "name": "SI or advisory partner name", "capability": "Their relevance to ${input.targetAccount}'s industry and transformation goals" }
  ],
  "caseStudies": [
    {
      "client": "Real client name, or [Client A, Fortune 500 ${input.targetIndustry} Company] if unavailable",
      "challenge": "Specific business challenge they faced",
      "solution": "Which ${input.yourCompany} solution was deployed and how",
      "outcome": "Measurable result e.g. '30% reduction in inventory costs, 18-month payback period'",
      "testimonial": "Direct executive quote if publicly available, or null"
    }
  ],
  "priorityMapping": [
    {
      "priority": "Priority name (same list as priorityTable — must match exactly)",
      "solution": "Specific ${input.yourCompany} solution or product name",
      "expectedOutcome": "Concrete business outcome — quantify where possible",
      "timeToValue": "Realistic estimate e.g. '3-6 months', '6-9 months', '12-18 months'"
    }
  ],
  "competitiveStatement": "3-4 sentence paragraph a sales rep can use verbally: why ${input.yourCompany} — and not ${input.competitorName} — is the right partner for ${input.targetAccount} right now. Be specific to their stated priorities and current market context.",
  "objectionRebuttals": [
    {
      "objection": "A realistic, specific objection ${input.targetAccount} might raise (e.g. 'We already use ${input.competitorName}'s ecosystem')",
      "rebuttal": "A sharp, evidence-backed response addressing the concern directly — include a proof point or reference"
    }
  ],
  "callToAction": "Specific recommended next step in the sales cycle (name the format, attendees, and desired outcome e.g. 'Schedule a 90-minute executive briefing with ${input.targetAccount}'s CIO and Head of Digital to present a tailored proof-of-concept roadmap')"
}

Required counts:
${priorityCountNote}
- industrySolutions: 3-5 solutions specific to ${input.targetIndustry}
- technologyPartners: 2-4 partners
- siPartners: 2-3 partners
- caseStudies: EXACTLY 3 case studies
- objectionRebuttals: EXACTLY 3 objections`;

  const message = await client.messages.create({
    model: SYNTHESIS_MODEL,
    max_tokens: MAX_OUTPUT_TOKENS,
    messages: [{ role: 'user', content: userPrompt }],
    system: systemPrompt,
  });

  const content = message.content[0];
  if (content.type !== 'text') throw new Error('Unexpected Claude response type');

  return parseSalesPlay(content.text);
}

function parseSalesPlay(raw: string): SalesPlayPayload {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Claude did not return valid JSON for sales play');
  try {
    const p = JSON.parse(match[0]) as SalesPlayPayload;
    return {
      priorityTable:         Array.isArray(p.priorityTable)         ? p.priorityTable         : [],
      industrySolutions:     Array.isArray(p.industrySolutions)     ? p.industrySolutions     : [],
      techSummary:           p.techSummary           || '',
      technologyPartners:    Array.isArray(p.technologyPartners)    ? p.technologyPartners    : [],
      siPartners:            Array.isArray(p.siPartners)            ? p.siPartners            : [],
      caseStudies:           Array.isArray(p.caseStudies)           ? p.caseStudies           : [],
      priorityMapping:       Array.isArray(p.priorityMapping)       ? p.priorityMapping       : [],
      competitiveStatement:  p.competitiveStatement  || '',
      objectionRebuttals:    Array.isArray(p.objectionRebuttals)    ? p.objectionRebuttals    : [],
      callToAction:          p.callToAction          || '',
    };
  } catch {
    throw new Error('Failed to parse sales play JSON');
  }
}

// ── Key Prospective Buyers — Synthesis ───────────────────────────────────────

export async function synthesizeKeyBuyers(
  input: KeyBuyersInput,
  research: string
): Promise<KeyBuyerRow[]> {
  const hasResearch = !isEmptyResearch(research);

  const systemPrompt = `You are a senior B2B sales intelligence analyst who specialises in executive-level stakeholder mapping.
Rules:
- Use the provided research first; supplement with training knowledge where research is sparse — label estimates "(est.)".
- Focus on C-suite and SVP/VP level executives — the decision-makers.
- Every row must have substantive, specific content — no vague generalities, no empty fields.
- Prefer direct quotes in the excerpt field when available — use quotation marks.
- Output ONLY valid JSON. No markdown fences, no text outside the JSON array.
- ${RECENCY_DIRECTIVE}`;

  const userPrompt = `Analyse the following research on "${input.companyName}" and produce a Key Prospective Buyers table.

The table should map senior executives to their publicly stated business focus areas, making it easy for a sales team to tailor their pitch.

${hasResearch
  ? `RESEARCH:\n${research.slice(0, 20000)}`
  : `[No live research available — use training knowledge about ${input.companyName}'s key executives and their known strategic priorities. Label estimates as "(est.)".]`}

Return a JSON array with 10-15 rows, EXACTLY this shape:
[
  {
    "keyExecutive": "Full Name, Exact Title, Department (e.g. 'John Smith, Chief Technology Officer, Technology')",
    "theme": "The business focus area the executive is championing (e.g. 'AI-Driven Supply Chain Optimisation', 'Cloud-First Digital Transformation', 'Sustainability & Net Zero')",
    "reference": "The EVENT where the executive made this statement — e.g. 'Annual General Meeting 2024', 'Investor Day Keynote, Nov 2024', 'World Economic Forum Panel, Jan 2025', 'Q3 FY2025 Earnings Call', 'Industry Summit Keynote'. This is NOT the source URL — it is the occasion, event, or forum where the quote originated.",
    "excerpt": "2-3 bullet points (each starting with '• ' separated by newlines): key statements or quotes from the executive about this theme — cite specific data points, programme names, or initiatives mentioned."
  }
]

IMPORTANT:
- Cover DIVERSE themes: technology strategy, operations, growth, sustainability, talent, M&A, innovation, customer experience, cost optimisation, digital transformation, AI/ML, cybersecurity, etc.
- Include executives from DIFFERENT functions (CEO, CFO, CTO, CIO, CDO, CMO, COO, SVP/VP levels).
- If multiple executives speak to the same theme, include both — this shows organisational alignment.
- Prioritise recent sources (2024-2025).
- Each row should represent a unique, actionable insight for sales pitching.
- The "reference" field must describe the EVENT or OCCASION — not the publication or website. Examples: "Annual Shareholders Meeting 2024", "NASSCOM Technology Leadership Forum", "Q2 FY2025 Earnings Call", "Banking Technology Summit, Feb 2025". NOT: "LinkedIn post", "Company website", "Press release".
- The "keyExecutive" field MUST follow the format: "Full Name, Title, Department".`;

  const message = await client.messages.create({
    model: SYNTHESIS_MODEL,
    max_tokens: MAX_OUTPUT_TOKENS,
    messages: [{ role: 'user', content: userPrompt }],
    system: systemPrompt,
  });

  const content = message.content[0];
  if (content.type !== 'text') throw new Error('Unexpected Claude response type');

  return parseKeyBuyers(content.text);
}

function parseKeyBuyers(raw: string): KeyBuyerRow[] {
  const items = safeParseJsonArray(raw);
  if (!items || items.length === 0) {
    throw new Error('Claude did not return valid JSON for key prospective buyers');
  }
  return (items as KeyBuyerRow[]).filter(
    (row) => row.theme && row.reference && row.excerpt && row.keyExecutive
  );
}

// ── Industry Trends — Synthesis ──────────────────────────────────────────────

interface IndustryTrendsSynthesisResult {
  businessTrends: IndustryTrendRow[];
  techTrends: IndustryTrendRow[];
}

export async function synthesizeIndustryTrends(
  input: IndustryTrendsInput,
  research: string
): Promise<IndustryTrendsSynthesisResult> {
  const hasResearch = !isEmptyResearch(research);
  const geography = input.geography || 'Global';
  const isGlobal = geography === 'Global';

  const examplesRule = isGlobal
    ? '- Examples MUST span multiple global regions (Americas, EMEA, APAC) where possible.'
    : `- Examples MUST be specifically from the ${geography} region/market. Do NOT include examples from other regions unless directly relevant to ${geography}.`;

  const systemPrompt = `You are a senior industry analyst producing executive-grade trend reports for B2B sales and strategy teams.
Rules:
- Use the provided research first; supplement with training knowledge where research is sparse — label estimates "(est.)".
- Be specific: cite data points, analyst firms, named companies, market figures, and regional examples.
- Every cell must have substantive content — no vague generalities, no empty fields.
- Description and Examples fields MUST use bullet points. Each bullet starts with "• ".
${examplesRule}
- Output ONLY valid JSON. No markdown fences, no text outside the JSON object.
- ${RECENCY_DIRECTIVE}`;

  const exampleTemplateBiz = isGlobal
    ? `"examples": "• Americas: Specific example with company/country name\\n• EMEA: Specific example with company/country name\\n• APAC: Specific example with company/country name"`
    : `"examples": "• ${geography}: Specific example with company/country name\\n• ${geography}: Another example with company/country name\\n• ${geography}: Additional example with company/country name"`;

  const exampleTemplateTech = isGlobal
    ? `"examples": "• Americas: Example\\n• EMEA: Example\\n• APAC: Example"`
    : `"examples": "• ${geography}: Example\\n• ${geography}: Another example\\n• ${geography}: Additional example"`;

  const exampleInstruction = isGlobal
    ? '- "examples" must be bullet points with regional labels (e.g. "• Americas:", "• EMEA:", "• APAC:"), 2-4 bullets per trend'
    : `- "examples" must be bullet points with examples specifically from ${geography}, 2-4 bullets per trend. Each bullet should reference specific companies, initiatives, or developments in ${geography}`;

  const geoContext = isGlobal
    ? ''
    : `\n\nGEOGRAPHIC SCOPE: Focus exclusively on the ${geography} market. All trends, impacts, descriptions, and examples must be specifically relevant to ${geography}. Discuss how industry dynamics play out in this specific region.`;

  const userPrompt = `Analyse the following research on the "${input.industrySegment}" industry and produce an Industry Trends report in TWO blocks.${geoContext}

${hasResearch
  ? `RESEARCH:\n${research.slice(0, 20000)}`
  : `[No live research available — use training knowledge about ${input.industrySegment} industry trends${isGlobal ? '' : ` in ${geography}`}. Label estimates as "(est.)".]`}

Return a JSON object with EXACTLY this shape:
{
  "businessTrends": [
    {
      "trend": "Trend name (e.g. 'Nearshoring & Supply Chain Restructuring')",
      "impact": "One sentence summarising the impact on the ${input.industrySegment} industry${isGlobal ? '' : ` in ${geography}`}",
      "description": "• Bullet point 1 with specific data or insight\\n• Bullet point 2 with further detail\\n• Bullet point 3 with additional context",
      ${exampleTemplateBiz}
    }
  ],
  "techTrends": [
    {
      "trend": "Trend name",
      "impact": "One sentence impact summary",
      "description": "• Bullet 1\\n• Bullet 2\\n• Bullet 3",
      ${exampleTemplateTech}
    }
  ]
}

BUSINESS TRENDS — include 7-10 trends covering these dimensions:
1. Macroeconomy (interest rates, inflation, GDP, FX, trade policies, geopolitics)
2. Demand (growth trajectory, new segments, geographic expansion)
3. Supply (supply chain, manufacturing, nearshoring, logistics)
4. Customer (behaviour shifts, experience expectations, personalisation)
5. Competition (M&A, new entrants, platform plays, ecosystem strategies)
6. Regulatory (ESG mandates, data privacy, AI governance, sector-specific rules)
7. Pricing (model shifts, margin dynamics, value-based pricing)
8. Any other material business trends (workforce, sustainability, new business models)

TECHNOLOGY TRENDS — include 6-8 trends covering:
1. Emerging Technology: Generative AI, AI/ML at scale, edge computing, digital twins, quantum readiness, autonomous systems — whichever are most relevant
2. Traditional Technology: Cloud migration, ERP modernisation, cybersecurity, data platforms, IoT/IIoT, RPA/automation, legacy decommissioning — whichever are most relevant

IMPORTANT:
- "description" must be bullet points (each line starts with "• "), 3-5 bullets per trend
${exampleInstruction}
- Each example must name specific companies, countries, or initiatives
- "impact" is a single sentence — concise and specific to ${input.industrySegment}${isGlobal ? '' : ` in ${geography}`}`;

  const message = await client.messages.create({
    model: SYNTHESIS_MODEL,
    max_tokens: MAX_OUTPUT_TOKENS,
    messages: [{ role: 'user', content: userPrompt }],
    system: systemPrompt,
  });

  const content = message.content[0];
  if (content.type !== 'text') throw new Error('Unexpected Claude response type');

  return parseIndustryTrends(content.text);
}

function parseIndustryTrends(raw: string): IndustryTrendsSynthesisResult {
  // Extract JSON object from response
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Claude did not return valid JSON for industry trends');

  try {
    const parsed = JSON.parse(match[0]);
    const businessTrends = Array.isArray(parsed.businessTrends)
      ? (parsed.businessTrends as IndustryTrendRow[]).filter((r) => r.trend && r.impact)
      : [];
    const techTrends = Array.isArray(parsed.techTrends)
      ? (parsed.techTrends as IndustryTrendRow[]).filter((r) => r.trend && r.impact)
      : [];

    if (businessTrends.length === 0 && techTrends.length === 0) {
      throw new Error('No trends parsed');
    }

    return { businessTrends, techTrends };
  } catch (e) {
    // Fallback: try extracting individual arrays
    const bizMatch = raw.match(/"businessTrends"\s*:\s*(\[[\s\S]*?\])/);
    const techMatch = raw.match(/"techTrends"\s*:\s*(\[[\s\S]*?\])/);

    const businessTrends = bizMatch ? safeParseJsonArray(bizMatch[1]) as IndustryTrendRow[] ?? [] : [];
    const techTrends = techMatch ? safeParseJsonArray(techMatch[1]) as IndustryTrendRow[] ?? [] : [];

    if (businessTrends.length === 0 && techTrends.length === 0) {
      throw new Error('Claude did not return valid JSON for industry trends');
    }

    return {
      businessTrends: businessTrends.filter((r: IndustryTrendRow) => r.trend && r.impact),
      techTrends: techTrends.filter((r: IndustryTrendRow) => r.trend && r.impact),
    };
  }
}


// ════════════════════════════════════════════════════════════════════════════
//  INDUSTRY REPORT SYNTHESIS
// ════════════════════════════════════════════════════════════════════════════

/**
 * Step 1 — Extract structured scope from a free-text query.
 * Also generates 4 optimised search queries for Parallel.AI.
 */
/**
 * Wizard Step — Extract scope + suggest market segments + suggest key players.
 * Returns everything needed for the wizard flow.
 */
export async function extractScopeWithWizard(
  input: IndustryReportInput
): Promise<ScopeWizardResult> {
  const geographyHint = input.geography ? `\nGeography: "${input.geography}".` : '';
  const excludeHint = input.excludeRegion ? `\nExclude from research: "${input.excludeRegion}".` : '';
  const subIndustryHint = input.subIndustry ? `\nSub-industry focus: "${input.subIndustry}".` : '';
  const focusHint = input.focusAreas?.length ? `\nFocus areas: ${input.focusAreas.join(', ')}.` : '';

  // Build the TOC section titles based on user-selected sections
  const sectionTitleMap: Record<string, string> = {
    market_overview: 'Market Overview',
    market_size_by_segment: 'Market Size by Segment',
    market_dynamics: 'Market Dynamics',
    competition_analysis: 'Competition Analysis',
    regulatory_overview: 'Regulatory Overview',
    forecast: 'Market Forecast',
    swot: 'SWOT Analysis',
    porters_five_forces: "Porter's Five Forces Analysis",
    tei_analysis: 'Total Economic Impact Analysis',
  };
  const userSelectedSections = input.selectedSections?.length
    ? input.selectedSections
    : Object.keys(sectionTitleMap);
  const tocTitles = ['Executive Summary', ...userSelectedSections.map((id) => sectionTitleMap[id]).filter(Boolean)];
  const sectionsHint = `\nUser has selected the following report sections (ONLY include these in tocPreview): ${tocTitles.join(', ')}.`;

  const userPrompt = `
Analyse this market research request and provide structured scope, market segmentation suggestions, and key player suggestions.
${geographyHint}${excludeHint}${subIndustryHint}${focusHint}${sectionsHint}

INDUSTRY/PRODUCT: "${input.industry || input.query}"

Return ONLY valid JSON with this exact shape:
{
  "scope": {
    "industry": "Full industry/market name",
    "geography": "Geography",
    "productScope": "1-2 sentence description of what products/services are in scope",
    "timeHorizon": "YYYY-YYYY",
    "searchQueries": [
      "query 1 — market size, TAM, revenue, forecast",
      "query 2 — trends, dynamics, drivers, challenges",
      "query 3 — competitive landscape, players, market share",
      "query 4 — technology, regulatory environment"
    ]
  },
  "suggestedSegments": [
    { "id": "seg_1", "label": "Organized vs Unorganized", "type": "organized", "selected": true, "subSegments": ["Organized Market", "Unorganized Market"] },
    { "id": "seg_2", "label": "By Region", "type": "geo", "selected": true, "subSegments": ["North America", "Europe", "Asia-Pacific", "..."] },
    { "id": "seg_3", "label": "By Product Type", "type": "product_type", "selected": true, "subSegments": ["Type A", "Type B", "..."] },
    { "id": "seg_4", "label": "By Application", "type": "application", "selected": true, "subSegments": ["App 1", "App 2", "..."] },
    { "id": "seg_5", "label": "By Distribution Channel", "type": "distribution", "selected": true, "subSegments": ["Channel 1", "Channel 2", "..."] },
    { "id": "seg_6", "label": "By Channel", "type": "channel", "selected": false, "subSegments": ["Online", "Offline", "..."] },
    { "id": "seg_7", "label": "By Pricing Segment", "type": "pricing", "selected": false, "subSegments": ["Premium", "Mid-range", "Economy"] },
    { "id": "seg_8", "label": "By End-Use Industry", "type": "end_use", "selected": true, "subSegments": ["Industry 1", "Industry 2", "..."] }
  ],
  "suggestedPlayers": [
    { "name": "Company A", "description": "Brief 1-line description", "marketShare": "XX%", "headquarters": "City, Country", "revenue": "$X.XB", "selected": true },
    ...15-20 competitors total, top 10 pre-selected for profiling
  ],
  "tocPreview": ${JSON.stringify(tocTitles)}
}

RULES:
- Suggest 6-8 market segments. Each must have 3-4 sub-segments (no more).
- Suggest 15-20 competitors total. Pre-select top 10 for detailed profiling. Keep descriptions to 1 short sentence.
- ONLY include ACTIVE, OPERATING companies as competitors.
- searchQueries: 10-15 words each, optimised for web search with current year data
- Be specific to the industry — do not use generic placeholder names
`.trim();

  const message = await client.messages.create({
    model: SYNTHESIS_MODEL,
    max_tokens: 2048,
    temperature: 0.1,
    system: `You are a senior market research analyst with deep knowledge of market segmentation and competitive intelligence. Output ONLY valid JSON. ${RECENCY_DIRECTIVE}`,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const content = message.content[0];
  if (content.type !== 'text') throw new Error('Unexpected Claude response type');

  const raw = content.text;
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON found in wizard scope response');

  const parsed = JSON.parse(jsonMatch[0]) as ScopeWizardResult;

  if (!parsed.scope?.industry || !parsed.suggestedSegments?.length || !parsed.suggestedPlayers?.length) {
    throw new Error('Incomplete wizard scope extraction');
  }

  // Carry forward input fields to scope
  if (input.subIndustry) parsed.scope.subIndustry = input.subIndustry;
  if (input.focusAreas) parsed.scope.focusAreas = input.focusAreas;
  if (input.excludeRegion) parsed.scope.excludeRegion = input.excludeRegion;
  if (input.selectedSections?.length) parsed.scope.selectedSections = input.selectedSections;

  // Override tocPreview to match exactly what user selected
  parsed.tocPreview = tocTitles;

  return parsed;
}

/**
 * Step 3 — Market Sizing: TAM, SAM, SOM, CAGR from research data.
 */
export async function synthesizeMarketSizing(
  scope: IndustryReportScope,
  allResearch: string
): Promise<MarketSizingData> {
  const safeResearch = allResearch.length > 25000 ? allResearch.slice(0, 25000) : allResearch;

  const userPrompt = `
You are producing a market sizing analysis for the ${scope.industry} market in ${scope.geography} (${scope.timeHorizon}).

RESEARCH DATA:
${safeResearch}

Using BOTH top-down and bottom-up approaches, produce market size estimates.

TOP-DOWN: Start from the broadest relevant market → narrow by geography and product scope → arrive at TAM.
BOTTOM-UP: Estimate from known player revenues, unit volumes, or customer counts → extrapolate total market.

Return ONLY valid JSON with this exact shape:
{
  "currentMarketSize": "$XX.XB (2024)" or range if uncertain,
  "projectedMarketSize": "$XX.XB (2030)" or range,
  "cagr": "X.X% (2024-2030)",
  "currentVolume": "XX.X million units (2024) — include ONLY if volume/unit data is available with medium-high confidence from the research. For physical products, vehicles, devices, etc. this is usually available. Omit this field entirely if not available.",
  "projectedVolume": "XX.X million units (2030) — same rule as currentVolume",
  "methodology": "2-3 sentence summary of how estimates were derived using both methods",
  "dataPoints": [
    { "metric": "descriptive metric name", "value": "$XX.XB or XX%", "source": "Source Name, Year" },
    ... (5-8 data points supporting the estimates)
  ]
}

RULES:
- Use research data first; supplement with training knowledge — label estimates "(est.)"
- If data conflicts, explain in methodology and use the more authoritative source
- Include at least 5 data points from the research
- Be specific: cite exact figures, not vague ranges
- VOLUME DATA: For industries where units/volume makes sense (vehicles, devices, tonnes, liters, units sold, etc.), you MUST include currentVolume and projectedVolume. Use the most appropriate unit (million units, thousand tonnes, etc.). Only omit if the industry is purely a service/intangible market where volume doesn't apply.
`.trim();

  const message = await client.messages.create({
    model: SYNTHESIS_MODEL,
    max_tokens: 4096,
    temperature: 0,
    system: `You are a quantitative market sizing analyst. Produce data-grounded market estimates. Output ONLY valid JSON. ${RECENCY_DIRECTIVE}`,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const content = message.content[0];
  if (content.type !== 'text') throw new Error('Unexpected Claude response type');

  const raw = content.text;
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON found in market sizing response');

  const parsed = JSON.parse(jsonMatch[0]) as MarketSizingData;
  if (!parsed.currentMarketSize || !parsed.cagr) {
    throw new Error('Incomplete market sizing data');
  }

  return parsed;
}

/**
 * Step 4 — Executive Summary: headline, KPIs, paragraphs, scenarios.
 */
export async function synthesizeExecutiveSummary(
  scope: IndustryReportScope,
  marketSizing: MarketSizingData,
  sections: ReportSection[]
): Promise<ExecutiveSummary> {
  // Build a condensed summary of each section for the executive summary
  const sectionSummaries = sections.map((s) => {
    const firstPara = s.bodyParagraphs?.[0]?.slice(0, 300) || '';
    const tableInfo = s.keyTable ? ` | Table: ${s.keyTable.title} (${s.keyTable.rows?.length || 0} rows)` : '';
    return `- ${s.title}: ${firstPara}${tableInfo}`;
  }).join('\n');

  const userPrompt = `
Produce an executive summary for a market intelligence report on the ${scope.industry} market in ${scope.geography} (${scope.timeHorizon}).

MARKET SIZING:
- Current (Value): ${marketSizing.currentMarketSize}
- Projected (Value): ${marketSizing.projectedMarketSize}
- CAGR: ${marketSizing.cagr}
- Current (Volume): ${marketSizing.currentVolume || 'Not available'}
- Projected (Volume): ${marketSizing.projectedVolume || 'Not available'}
- Methodology: ${marketSizing.methodology}

SECTION SUMMARIES:
${sectionSummaries}
${scope.selectedPlayers?.length ? `\nSELECTED KEY PLAYERS (profiled):\n${scope.selectedPlayers.map((p) => `- ${p.name} — ${p.marketShare || 'N/A'} share`).join('\n')}` : ''}
${(() => { const selNames = new Set((scope.selectedPlayers || []).map((p) => p.name)); const others = (scope.allPlayers || []).filter((p) => !selNames.has(p.name)); return others.length ? `\nOTHER KNOWN PLAYERS (not profiled but MUST be mentioned):\n${others.map((p) => `- ${p.name} — ${p.marketShare || 'N/A'} share`).join('\n')}` : ''; })()}

Return ONLY valid JSON with this exact shape:
{
  "headline": "One compelling sentence summarising the key market finding (include a number)",
  "tickerBoxes": [
    { "label": "Current Market Size (n)", "value": "$XX.XB", "secondaryValue": "XX.X million units (if volume data available, else omit)", "trend": "up" },
    { "label": "CAGR (n to n+5)", "value": "XX.X%", "trend": "up" },
    { "label": "Projected Market Size (n+5)", "value": "$XX.XB", "secondaryValue": "XX.X million units (if volume data available, else omit)", "trend": "up" },
    { "label": "Unorganized Market Share", "value": "XX% (if available and relevant, else omit this ticker entirely)" },
    { "label": "Organized Channel Share (Top 5)", "value": "XX%" }
  ],
  "kpis": [
    { "label": "Market Size (n)", "value": "$XX.XB", "trend": "up" },
    { "label": "CAGR", "value": "XX.X%", "trend": "up" },
    { "label": "Projected (n+5)", "value": "$XX.XB", "trend": "up" },
    { "label": "Leading Segment", "value": "Name (XX%)", "trend": "up|down|flat" },
    { "label": "Top Player", "value": "Company (XX%)", "trend": "flat" }
  ],
  "marketSizeChartSpec": {
    "type": "combo",
    "title": "Market Size: Historical & Projected",
    "xLabel": "Year", "yLabel": "Market Size (USD Bn)", "yRightLabel": "CAGR %",
    "data": [{"label": "2020", "value": <size>, "growth": <cagr>}, {"label": "2021", ...}, ... up to projected year],
    "series": [
      {"key": "value", "name": "Market Size", "type": "bar", "yAxisId": "left"},
      {"key": "growth", "name": "CAGR %", "type": "line", "yAxisId": "right"}
    ]
  },
  "concentrationInsights": "2-3 sentences on whether the market is concentrated or fragmented, top-N player concentration ratio, organized vs unorganized split",
  "keyPlayersInsights": "3-5 sentences listing ALL known players (both SELECTED KEY PLAYERS and OTHER KNOWN PLAYERS from the context above) with their approximate market share percentages. Every player must be named.",
  "topTrends": [
    "Trend 1: One sentence summary",
    "Trend 2: One sentence summary",
    "Trend 3: One sentence summary"
  ],
  "recentMaJvInsights": "2-3 sentences on any recent M&A activity, joint ventures, and notable new entrants in the past 12 months",
  "paragraphs": [
    "• Summary bullet 1 about market size and growth trajectory\n• Summary bullet 2 about key drivers\n• Summary bullet 3 about competitive dynamics",
    "• Summary bullet 4 about technology trends\n• Summary bullet 5 about regulatory impact\n• Summary bullet 6 about outlook"
  ],
  "scenarios": [
    { "name": "Bull", "description": "2-3 sentences on optimistic scenario", "marketSize": "$XXXB by n+5" },
    { "name": "Base", "description": "2-3 sentences on expected scenario", "marketSize": "$XXXB by n+5" },
    { "name": "Bear", "description": "2-3 sentences on pessimistic scenario", "marketSize": "$XXXB by n+5" }
  ]
}

RULES:
- n = previous year from the date of request (e.g. if request date is 2026, n = 2025)
- tickerBoxes: include 3-5 ticker boxes. CRITICAL: If volume data is provided in MARKET SIZING above (Current Volume / Projected Volume), you MUST include the volume as secondaryValue in the Current and Projected ticker boxes. Format: "XX.X million units" or equivalent. Omit "Unorganized Market Share" ticker if not relevant to this market.
- marketSizeChartSpec: MUST include historical years (n-4 to n) AND projected years (n+1 to n+5). Data values MUST be numbers.
- concentrationInsights, keyPlayersInsights, topTrends, recentMaJvInsights: All required. Extract from the drafted sections.
- keyPlayersInsights MUST name every competitor from both SELECTED KEY PLAYERS and OTHER KNOWN PLAYERS lists. Do not omit any player.
- topTrends: exactly 3-5 items, each a single concise sentence
- kpis: keep as fallback, 4-6 metrics with trend direction
- Paragraphs: use bullet points (• ) separated by newlines
- Scenarios: must be grounded in drivers/restraints from the report sections
- headline: must include at least one specific number
- Every figure must be traceable to a section already drafted — do not invent new data
`.trim();

  const message = await client.messages.create({
    model: SYNTHESIS_MODEL,
    max_tokens: 8192,
    temperature: 0.2,
    system: `You are a senior market analyst producing an executive summary for C-suite readers. Be concise, impactful, and data-driven. Output ONLY valid JSON. ${RECENCY_DIRECTIVE}`,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const content = message.content[0];
  if (content.type !== 'text') throw new Error('Unexpected Claude response type');

  const raw = content.text;
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON found in executive summary response');

  const parsed = JSON.parse(jsonMatch[0]) as ExecutiveSummary;
  if (!parsed.headline || (!parsed.tickerBoxes?.length && !parsed.kpis?.length) || !parsed.paragraphs?.length) {
    throw new Error('Incomplete executive summary');
  }

  return parsed;
}

// ── V2 Section Definitions (enhanced report with SWOT, Porter's, TEI) ───────

const SECTION_DEFINITIONS_V2: Record<string, { title: string; tableHint: string; chartHint: string; subsectionHint: string }> = {
  market_overview: {
    title: 'Market Overview',
    tableHint: 'Include a table (in keyTable) with headers: ["Year", "Market Size (Value)", "Market Size (Volume)", "YoY Growth (%)", "Scenario Band (Low/Base/High)"] showing historical data for n-4 to n (last 5 calendar years). Include both value (USD) and volume (units/tonnes/etc.) columns. If volume data not available, leave volume cells as "N/A".',
    chartHint: 'Include a "combo" chart (in chartSpec) showing current market size and historical CAGR. data: [{label: "2020", value: <size_in_billions>, growth: <yoy_percent>}, {label: "2021", ...}, ...for 5 years], series: [{key: "value", name: "Market Size (USD Bn)", type: "bar", yAxisId: "left"}, {key: "growth", name: "YoY Growth %", type: "line", yAxisId: "right"}], yRightLabel: "Growth %". ALL data values MUST be numbers.',
    subsectionHint: 'Structure the section as follows:\n1. bodyParagraphs[0]: Current market size (value + volume if available), historical CAGR, and overall growth characterization (tag as HIGH GROWTH / MEDIUM GROWTH / LOW GROWTH).\n2. Subsection "Growth Insights": MUST have "content" field (3-5 bullet points). Explicitly classify growth as High, Medium, or Low. Explain key growth drivers, inflection points, and growth trajectory.\n3. Subsection "Market Concentration & Fragmentation": MUST have "content" field (3-5 bullet points). Whether market is concentrated (top 3-5 players dominate) or fragmented (many small players), organized vs unorganized market split (with % estimates), HHI-equivalent assessment.\n4. Subsection "Major Players & Key Insights": MUST have "content" field (3-5 bullet points). Top 3-5 ACTIVE players with market share %, key differentiators, recent strategic moves, plus any other key market insights. Only list companies that are currently operating — do NOT include companies that have shut down, gone bankrupt, or exited the market. If any notable players have recently shut down or filed for bankruptcy, mention them separately with a ⚠ marker and brief context (e.g. "⚠ XYZ Corp filed for Chapter 11 in 2024 due to…").\nCRITICAL: Every subsection MUST have a non-empty "content" string with substantive analysis (at least 3 bullet points using • character). Do NOT leave content empty.',
  },
  market_size_by_segment: {
    title: 'Market Size by Segment',
    tableHint: 'For EACH segment (from SELECTED MARKET SEGMENTS if provided, otherwise identify 4-6 major segments from the research data — e.g. by product type, by geography, by application, by price tier, by channel), include a table in that subsection\'s keyTable with headers: ["Segment-Subtype", "Est. Market Size", "Share of SAM", "Est. CAGR (n to n+5)", "Key Players"]. Use both volume and value figures if available, otherwise value only. Market Size column should show "$X.XB" format.',
    chartHint: 'For each segment subsection, build a "stacked_bar" chart showing sub-segments stacked with CAGR line. data: [{label: "2020", "<sub1>": <val>, "<sub2>": <val>, cagrTrend: <total_cagr>}, ...], series: [{key: "<sub1>", name: "Sub-segment 1", type: "bar", yAxisId: "left", stack: "seg"}, ..., {key: "cagrTrend", name: "CAGR Trend", type: "line", yAxisId: "right"}]. Use volume figures for chart if both volume and value estimates are available with medium/high confidence.',
    subsectionHint: 'CRITICAL: This section MUST have subsections. If SELECTED MARKET SEGMENTS are provided, use those. If NOT, identify and analyze 4-6 major market segments from the research data (e.g. "By Product Type", "By Geography", "By Application", "By Price Tier", "By Distribution Channel").\nEach subsection MUST have:\n1. content: 3-5 lines of analysis covering which sub-segments are increasing/decreasing, sub-segment specific market trends, regulatory impacts\n2. keyTable: table with the segment-subtype breakdown as described above\n3. chartSpec: stacked_bar chart as described above\nDo NOT skip this section. Even without user-selected segments, you MUST identify segments from research.',
  },
  market_dynamics: {
    title: 'Market Dynamics',
    tableHint: 'Return 4 tables in the "tables" array (NOT keyTable). Each table has title and specific headers:\n1. Title: "Business Trends", Headers: ["Name of Trend", "Impact", "Description", "Examples"]\n2. Title: "Tech Trends", Headers: ["Name of Trend", "Impact", "Description", "Examples"]\n3. Title: "Drivers", Headers: ["Name of Driver", "Impact", "Description", "Examples"]\n4. Title: "Barriers", Headers: ["Name of Barrier", "Impact", "Description", "Examples"]\nThe "Examples" column MUST contain real-world references: news articles, company events, specific player actions, regulatory changes. Include 5-8 rows per table. Impact should be High/Medium/Low.',
    chartHint: 'No chart needed. Set chartSpec to null.',
    subsectionHint: 'No subsections needed. The 4 tables carry all the content. Include 1-2 bodyParagraphs summarizing the overall market dynamics landscape.',
  },
  competition_analysis: {
    title: 'Competition Analysis',
    tableHint: 'Include a summary table (in keyTable) with headers: ["Company", "Market Share (%)", "Revenue (USD Bn)", "HQ", "Key Strength"] for ALL known players — both SELECTED KEY PLAYERS and OTHER KNOWN PLAYERS listed in the context.',
    chartHint: 'Include a "horizontal_bar" chart (in chartSpec) showing market share of ALL known players (selected + other known players).',
    subsectionHint: 'CRITICAL STRUCTURE:\n1. The FIRST bodyParagraph MUST outline: competition overview, market share distribution, market type (oligopoly, duopoly, perfect competition, price-led, innovation-led, etc.), organized vs unorganized market share. IMPORTANT: This paragraph MUST mention ALL competitors — both SELECTED KEY PLAYERS and OTHER KNOWN PLAYERS from the context. Every single player should be named at least once in the competition analysis body text.\n2. Include "bcgMatrixData" array: [{name: "Company", marketSize: <revenue_number>, growth: <growth_rate_number>, quadrant: "star|cash_cow|question_mark|dog"}, ...] for ALL identified active players (both selected and other known). Do NOT include companies that have shut down, ceased operations, or filed for bankruptcy in the BCG matrix.\n3. Include "competitorProfiles" array with detailed profiles ONLY for SELECTED KEY PLAYERS (the ones marked for profiling). Each: {name, parentCompany, hqLocation, keyProducts, overallRevenue, categoryRevenue, marketShare, manufacturingLocation, recentNews (key news from past 3 months), jvMaPartnerships (significant JV/M&A/partnerships), otherInsights}. Do NOT build profiles for OTHER KNOWN PLAYERS (unselected) or defunct companies.\n4. DEFUNCT PLAYERS CALLOUT: If any notable companies in this market have shut down, filed for bankruptcy, been liquidated, or permanently ceased operations, add a separate bodyParagraph titled "⚠ Defunct / Bankrupt Players" listing them with: company name, year of closure/bankruptcy, brief reason (e.g. financial distress, acquisition & shutdown, regulatory action), and any market impact. This is critical for investor and strategic awareness.\nDo NOT include subsections — use competitorProfiles instead.',
  },
  regulatory_overview: {
    title: 'Regulatory Overview',
    tableHint: 'Return 4 tables in the "tables" array (NOT keyTable). Each table has title and specific headers:\n1. Title: "Regulatory Bodies", Headers: ["Regulatory Body", "Geography", "Role", "Key Regulations / Recent Regulation"]\n2. Title: "Regulation Tracker", Headers: ["Regulation / Policy", "Effective Date", "Scope", "Impact Level", "Strategic Implication"]\n3. Title: "Trade & Compliance Barriers", Headers: ["Barrier Type", "Geography", "Specific Requirement", "Compliance Cost / Burden", "Strategic Implication"]\n4. Title: "Pending Regulations", Headers: ["Pending Rule / Policy", "Expected Date", "Regulatory Body", "Scope", "Impact Level", "Strategic Implication"]\nInclude 3-6 rows per table.',
    chartHint: 'No chart needed. Set chartSpec to null.',
    subsectionHint: 'No subsections needed. Include 1-2 bodyParagraphs summarizing the regulatory landscape.',
  },
  forecast: {
    title: 'Market Forecast',
    tableHint: 'Include TWO tables in "tables" array:\n1. Title: "Scenario Assumptions", Headers: ["Assumption", "Pessimistic", "Realistic", "Optimistic"] with 4-6 key assumption rows.\n2. Title: "Forecast Summary", Headers: ["Metric", "Pessimistic", "Realistic", "Optimistic"] with rows: Current Market Size, Projected Market Size, CAGR (%), Probability of Scenario, Key Growth Drivers.',
    chartHint: 'Include 3 separate "combo" charts in the "charts" array (NOT chartSpec). One chart per scenario:\n1. Title: "Pessimistic Scenario" — bars for projected market size by year + line for CAGR\n2. Title: "Realistic Scenario" — same structure\n3. Title: "Optimistic Scenario" — same structure\nEach chart: data: [{label: "2025", value: <size>, growth: <cagr>}, ...], series: [{key: "value", name: "Market Size", type: "bar", yAxisId: "left"}, {key: "growth", name: "CAGR %", type: "line", yAxisId: "right"}], yRightLabel: "CAGR %".',
    subsectionHint: 'Include 1-2 bodyParagraphs introducing the forecast: type of growth (linear/exponential/step), key factors driving growth, which market segments are primary growth engines.',
  },
  swot: {
    title: 'SWOT Analysis',
    tableHint: 'No table needed. Set keyTable to null.',
    chartHint: 'No chart needed. Set chartSpec to null.',
    subsectionHint: 'No subsections. No bodyParagraphs needed (set to empty array []). ONLY return "swotData": { "strengths": [{"title": "...", "description": "...", "impact": "high|medium|low"}], "weaknesses": [...], "opportunities": [...], "threats": [...] }. 4-6 items per quadrant. Focus on being concise — each item should be 1-2 sentences.',
  },
  porters_five_forces: {
    title: "Porter's Five Forces Analysis",
    tableHint: 'No table needed. Set keyTable to null.',
    chartHint: 'No chart needed. Set chartSpec to null.',
    subsectionHint: 'No subsections. No bodyParagraphs needed (set to empty array []). ONLY return "portersData": { "competitiveRivalry": {"rating": "high|medium|low", "factors": ["..."], "description": "..."}, "supplierPower": {...}, "buyerPower": {...}, "threatOfSubstitution": {...}, "threatOfNewEntry": {...} }. Each force needs rating + 3-5 factors + 1-2 sentence description.',
  },
  tei_analysis: {
    title: 'Total Economic Impact',
    tableHint: 'No traditional keyTable. Set keyTable to null.',
    chartHint: 'No chart needed. Set chartSpec to null.',
    subsectionHint: 'No subsections. No bodyParagraphs needed (set to empty array []). ONLY return "macroTeiData": { "items": [{"trigger": "Macroeconomic event/factor name", "impactLevel": "high|medium|low", "description": "Description of the macroeconomic trigger", "examples": "Real-world examples, recent events, data points", "marketSizeImpact": "+X.X% or -X.X% impact on market size"}, ...] }. Include 6-10 macroeconomic triggers (e.g., interest rate changes, inflation, trade wars, currency fluctuations, GDP growth, commodity prices, regulatory shifts, geopolitical events).',
  },
};

/**
 * V2 Section Drafting — uses SECTION_DEFINITIONS_V2, supports swotData/portersData/teiData.
 */
export async function draftSectionsBatchV2(
  scope: IndustryReportScope,
  allResearch: string,
  marketSizing: MarketSizingData,
  sectionIds: string[]
): Promise<ReportSection[]> {
  const safeResearch = allResearch.length > 20000 ? allResearch.slice(0, 20000) : allResearch;

  const segmentContext = scope.selectedSegments?.length
    ? `\nSELECTED MARKET SEGMENTS:\n${scope.selectedSegments.map((s) => `- ${s.label} (${s.type}): ${s.subSegments?.join(', ') || 'N/A'}`).join('\n')}`
    : '';

  const selectedNames = new Set((scope.selectedPlayers || []).map((p) => p.name));
  const unselectedPlayers = (scope.allPlayers || []).filter((p) => !selectedNames.has(p.name));

  const playerContext = scope.selectedPlayers?.length
    ? `\nSELECTED KEY PLAYERS (build detailed profiles for these):\n${scope.selectedPlayers.map((p) => `- ${p.name} (${p.headquarters || 'N/A'}) — ${p.marketShare || 'N/A'} share, ${p.revenue || 'N/A'} revenue`).join('\n')}`
    : '';

  const unselectedPlayerContext = unselectedPlayers.length
    ? `\nOTHER KNOWN PLAYERS (do NOT build profiles, but MUST mention in executive summary and competition analysis body text):\n${unselectedPlayers.map((p) => `- ${p.name} (${p.headquarters || 'N/A'}) — ${p.marketShare || 'N/A'} share, ${p.revenue || 'N/A'} revenue`).join('\n')}`
    : '';

  const sectionInstructions = sectionIds.map((id) => {
    const def = SECTION_DEFINITIONS_V2[id];
    if (!def) return '';
    return `\nSECTION: "${id}"\nTitle: "${def.title}"\n- ${def.tableHint}\n- ${def.chartHint}\n- ${def.subsectionHint}\n`;
  }).join('\n');

  const userPrompt = `
You are drafting sections of a comprehensive market intelligence report on the ${scope.industry} market in ${scope.geography} (${scope.timeHorizon}).
${scope.subIndustry ? `Sub-industry focus: ${scope.subIndustry}` : ''}
${scope.excludeRegion ? `EXCLUDE from analysis: ${scope.excludeRegion}` : ''}
${segmentContext}${playerContext}${unselectedPlayerContext}

MARKET SIZING CONTEXT:
- Current (Value): ${marketSizing.currentMarketSize}
- Projected (Value): ${marketSizing.projectedMarketSize}
- CAGR: ${marketSizing.cagr}
- Current (Volume): ${marketSizing.currentVolume || 'Not available — estimate if the industry involves physical goods/units'}
- Projected (Volume): ${marketSizing.projectedVolume || 'Not available — estimate if the industry involves physical goods/units'}

RESEARCH DATA:
${safeResearch}

Draft the following ${sectionIds.length} sections:
${sectionInstructions}

Return ONLY a valid JSON array. Each element:
{
  "id": "section_id", "title": "...",
  "bodyParagraphs": ["..."] (use • bullet points; may be empty [] for swot/porters/tei),
  "keyTable": {...} OR null,
  "tables": [{title, headers, rows}, ...] OR null (for multi-table sections like market_dynamics, regulatory_overview, forecast),
  "chartSpec": {...} OR null,
  "charts": [{type, title, xLabel, yLabel, yRightLabel, data, series}, ...] OR null (for multi-chart sections like forecast),
  "subsections": [{"title": "...", "content": "paragraph text with • bullets", "keyTable": {...} OR null, "tables": [...] OR null, "chartSpec": {...} OR null, "charts": [...] OR null}] OR null,
  "citations": ["..."],
  "swotData": {...} OR null,
  "portersData": {...} OR null,
  "macroTeiData": {"items": [...]} OR null,
  "bcgMatrixData": [{name, marketSize, growth, quadrant}, ...] OR null,
  "competitorProfiles": [{name, parentCompany, hqLocation, keyProducts, overallRevenue, categoryRevenue, marketShare, manufacturingLocation, recentNews, jvMaPartnerships, otherInsights}, ...] OR null
}

CRITICAL RULES:
- chartSpec.data and charts[].data values MUST be numbers. For stacked_bar: keys for each sub-segment + cagrTrend.
- For swot/porters/tei sections: include ONLY the specialized data field. bodyParagraphs can be empty [].
- For market_dynamics and regulatory_overview: use "tables" array (NOT keyTable) for multiple tables.
- For forecast: use "tables" array for assumption/summary tables AND "charts" array for 3 scenario charts.
- For competition_analysis: include bcgMatrixData AND competitorProfiles alongside keyTable and chartSpec.
- Be specific: cite figures, company names, percentages, dates.
- bcgMatrixData.marketSize and .growth must be numeric values (not strings).
- EVERY subsection MUST have a non-empty "content" string with substantive bullet-point analysis. Never leave subsection content as "" or null.
- DEFUNCT COMPANY GUARDRAIL: Do NOT build competitor profiles, BCG matrix entries, or key player listings for companies that have shut down operations, filed for bankruptcy, been liquidated, or permanently exited the market. Instead, highlight such companies separately as "⚠ Defunct / Bankrupt" with the year and reason. Only profile active, operating companies.
`.trim();

  const message = await client.messages.create({
    model: SYNTHESIS_MODEL,
    max_tokens: 8192,  // increased from 4096 — sections need full completion for valid JSON
    temperature: 0.2,
    system: `You are a senior industry analyst drafting a market intelligence report. Be specific, data-driven, and cite sources. Output ONLY valid JSON. ${RECENCY_DIRECTIVE}`,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const content = message.content[0];
  if (content.type !== 'text') throw new Error('Unexpected Claude response type');

  const raw = content.text;
  console.log(`[draftV2] Batch [${sectionIds.join(', ')}] raw length: ${raw.length}, stop_reason: ${message.stop_reason}`);
  const parsed = safeParseJsonArray(raw);
  if (!parsed || parsed.length === 0) {
    console.error(`[draftV2] Failed to parse batch [${sectionIds.join(', ')}]. First 500 chars:`, raw.slice(0, 500));
    // If this is a single-section retry, return empty instead of throwing so the report can continue
    if (sectionIds.length === 1) {
      console.warn(`[draftV2] Skipping section ${sectionIds[0]} — parse failed even on individual retry.`);
      return [];
    }
    throw new Error(`No V2 sections parsed for batch [${sectionIds.join(', ')}]`);
  }

  // Debug: log what was parsed
  console.log(`[draftV2] Parsed ${parsed.length} sections: ${(parsed as any[]).map((s: any) => s.id || '?').join(', ')}`);


  // Sections with specialized data (swot/porters/tei) may have empty bodyParagraphs
  // Sections with tables/charts instead of bodyParagraphs (market_dynamics, regulatory) are valid
  const valid = (parsed as ReportSection[]).filter((s) => {
    if (!s.id || !s.title) return false;
    const hasBody = s.bodyParagraphs?.length > 0;
    const hasSpecialData = s.swotData || s.portersData || s.macroTeiData;
    const hasTables = (s.tables && s.tables.length > 0) || s.keyTable;
    const hasCharts = (s.charts && s.charts.length > 0) || s.chartSpec;
    const hasProfiles = s.competitorProfiles && s.competitorProfiles.length > 0;
    const hasBcg = s.bcgMatrixData && s.bcgMatrixData.length > 0;
    const hasSubsections = s.subsections && s.subsections.length > 0;
    // Valid if it has: body OR special data OR (tables/charts) OR profiles/BCG OR subsections
    return hasBody || hasSpecialData || hasTables || hasCharts || hasProfiles || hasBcg || hasSubsections;
  });
  console.log(`[draftV2] Batch [${sectionIds.join(', ')}]: parsed ${parsed.length} objects, ${valid.length} valid sections`);
  if (valid.length < parsed.length) {
    console.warn(`[draftV2] Filtered out ${parsed.length - valid.length} sections. Filtered:`, (parsed as any[]).filter((s: any) => !valid.includes(s)).map((s: any) => `${s.id} (bodyParagraphs:${s.bodyParagraphs?.length || 0}, tables:${s.tables?.length || 0}, charts:${s.charts?.length || 0})`).join(', '));
  }
  return valid;
}

// ══════════════════════════════════════════════════════════════════════════════
// HIGH GROWTH NICHE INDUSTRY SYNTHESIS
// ══════════════════════════════════════════════════════════════════════════════

import {
  NicheIndustryInput, NicheTopicRow,
  MarketingStrategyInput, StrategyDimensionRow,
} from '../types';

export async function synthesizeNicheTopics(
  input: NicheIndustryInput,
  research: string
): Promise<NicheTopicRow[]> {
  const modeLabel =
    input.outputMode === 'white_space' ? 'white-space'
    : input.outputMode === 'bestseller' ? 'bestseller'
    : 'white-space AND bestseller';

  const depthNote = input.segmentationDepth === 'deep'
    ? 'Also include application layer and buyer type as segmentation axes.'
    : '';

  const systemPrompt = `You are a senior market intelligence strategist specializing in syndicated research report topic identification, with deep expertise in how firms like MarketsandMarkets, GlobalData, Grand View Research, Global Market Insights, and Market Research Future select and validate niche high-growth topics.
Rules:
- Every topic must be specific enough that a buyer would pay $3,000–$5,000 for a standalone report.
- Cite analyst coverage gaps and research platform data where possible.
- Output ONLY a valid JSON array. No markdown fences, no text outside the JSON.
- ${RECENCY_DIRECTIVE}`;

  const userPrompt = `Based on the following research, identify ${input.numberOfTopics} ${modeLabel} niche report topics.

INDUSTRY VERTICAL: ${input.industryVertical}
${input.subSegmentOrTheme ? `SUB-SEGMENT / THEME: ${input.subSegmentOrTheme}` : ''}
GEOGRAPHY: ${input.geography}
MINIMUM CAGR: ≥${input.minimumCAGR}%
SEGMENTATION: ${input.segmentationDepth === 'deep' ? 'Deep (technology, region, end-use, application layer, buyer type)' : 'Standard (technology, region, end-use)'}
${input.additionalContext ? `ADDITIONAL CONTEXT: ${input.additionalContext.slice(0, 3000)}` : ''}

RESEARCH:
${research.slice(0, 55000)}

Apply ALL THREE filters:
FILTER 1 — SPECIFICITY: Narrow enough for a $3K–$5K standalone report. Generic parent-level topics fail.
FILTER 2 — GROWTH SIGNAL: Structural CAGR ≥${input.minimumCAGR}% driven by ≥2 megatrends.
FILTER 3 — SEGMENTABILITY: Segmentable along ≥3 axes. ${depthNote}

For white-space topics: NO major platform has a standalone report yet, OR coverage is 3+ years old. Justify the gap.
For bestseller topics: mirror highest-selling reports — specific product + specific application + geographic qualifier + near-future forecast window.

Return a JSON array of exactly ${input.numberOfTopics} objects with these keys:
[
  {
    "topic_title": "Specific report title in MarketsandMarkets/Grand View Research style",
    "type": "white_space" | "bestseller",
    "estimated_cagr": "18–22%",
    "base_market_size": "$2.4B (2024)",
    "white_space_score": 8,
    "competition_level": "none" | "low" | "moderate" | "high",
    "primary_growth_driver": "One sentence naming the specific megatrend(s)",
    "segmentation_axes": ["Technology Type", "Region", "End-Use", "Application Layer"],
    "verdict": "strong buy" | "pursue" | "monitor",
    "rationale": "2 sentences max explaining why this topic qualifies"
  }
]

Sort by verdict (strong buy first), then by white_space_score descending.`;

  const message = await client.messages.create({
    model: SYNTHESIS_MODEL,
    max_tokens: MAX_OUTPUT_TOKENS,
    messages: [{ role: 'user', content: userPrompt }],
    system: systemPrompt,
  });

  const raw = (message.content[0] as { type: string; text: string }).text;
  const items = safeParseJsonArray(raw);
  if (!items || items.length === 0) throw new Error('No valid niche topics parsed');
  return (items as NicheTopicRow[]).filter((r) => r.topic_title && r.type && r.estimated_cagr && r.verdict);
}

// ══════════════════════════════════════════════════════════════════════════════
// MARKETING STRATEGY FRAMEWORK SYNTHESIS
// ══════════════════════════════════════════════════════════════════════════════

export async function synthesizeMarketingStrategy(
  input: MarketingStrategyInput,
  research: string
): Promise<{
  frameworkSummary: string;
  dimensions: StrategyDimensionRow[];
  strategicRecommendations: string[];
}> {
  const systemPrompt = `You are a seasoned McKinsey senior partner with 25 years of strategy consulting experience. You produce institutional-grade strategic analyses that Fortune 500 CEOs rely on for decision-making.
Rules:
- Every dimension must have specific data points, named companies, and quantified evidence.
- Analysis must be 3-5 sentences — analytical, forward-looking, and actionable.
- Strategic implications must be concrete enough to act on.
- Priority ratings must be justified by evidence.
- Output ONLY valid JSON. No markdown fences.
- ${RECENCY_DIRECTIVE}`;

  const frameworkDimensions: Record<string, string[]> = {
    'BCG Matrix': ['Stars', 'Cash Cows', 'Question Marks', 'Dogs'],
    'SWOT': ['Strengths', 'Weaknesses', 'Opportunities', 'Threats'],
    'Porters Five Forces': ['Competitive Rivalry', 'Threat of New Entrants', 'Threat of Substitutes', 'Bargaining Power of Buyers', 'Bargaining Power of Suppliers'],
    'Ansoff Matrix': ['Market Penetration', 'Market Development', 'Product Development', 'Diversification'],
    '4P/7P Marketing Mix': ['Product', 'Price', 'Place', 'Promotion', 'People', 'Process', 'Physical Evidence'],
    'AIDA': ['Attention', 'Interest', 'Desire', 'Action'],
    'PESTEL': ['Political', 'Economic', 'Social', 'Technological', 'Environmental', 'Legal'],
    'North Star': ['North Star Metric', 'Leading Indicators', 'Input Metrics', 'Lagging Indicators'],
    'Flywheel Model': ['Acquisition', 'Activation', 'Retention', 'Revenue', 'Referral'],
    'Blue Ocean': ['Eliminate', 'Reduce', 'Raise', 'Create'],
    '7S Framework': ['Strategy', 'Structure', 'Systems', 'Shared Values', 'Style', 'Staff', 'Skills'],
    'GE-McKinsey Matrix': ['Invest/Grow', 'Hold/Selective', 'Harvest/Divest'],
    'Eisenhower Matrix': ['Urgent & Important', 'Important but Not Urgent', 'Urgent but Not Important', 'Neither Urgent nor Important'],
  };

  const dims = frameworkDimensions[input.framework] || ['Dimension 1', 'Dimension 2', 'Dimension 3'];

  const userPrompt = `Conduct a comprehensive ${input.framework} analysis for the "${input.industryOrSegment}" industry.
${input.productContext ? `\nPRODUCT/SERVICE CONTEXT:\n${input.productContext.slice(0, 3000)}` : ''}
${input.additionalContext ? `\nADDITIONAL CONTEXT:\n${input.additionalContext.slice(0, 2000)}` : ''}

RESEARCH:
${research.slice(0, 55000)}

The ${input.framework} dimensions are: ${dims.join(', ')}.

Return a single JSON object:
{
  "frameworkSummary": "3-5 sentence executive summary of the ${input.framework} analysis findings — the most important takeaways a CEO needs to know.",
  "dimensions": [
    {
      "dimension": "${dims[0]}",
      "element": "Specific item/factor within this dimension",
      "analysis": "3-5 sentences of deep, data-driven analysis with specific figures and named examples",
      "strategicImplication": "1-2 sentences on what this means for strategy and what action to take",
      "priority": "High" | "Medium" | "Low"
    }
  ],
  "strategicRecommendations": [
    "Recommendation 1: Specific, actionable recommendation with expected impact",
    "Recommendation 2: ...",
    "..."
  ]
}

Requirements:
- Provide 2-4 elements per dimension (${dims.length * 3} total elements minimum).
- Provide 5-8 strategic recommendations.
- Every analysis must cite specific data, company names, or market figures.
- Sort elements within each dimension by priority (High first).`;

  const message = await client.messages.create({
    model: SYNTHESIS_MODEL,
    max_tokens: MAX_OUTPUT_TOKENS,
    messages: [{ role: 'user', content: userPrompt }],
    system: systemPrompt,
  });

  const raw = (message.content[0] as { type: string; text: string }).text;
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No valid JSON object in marketing strategy response');

  let parsed: { frameworkSummary?: string; dimensions?: StrategyDimensionRow[]; strategicRecommendations?: string[] };
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    throw new Error('Failed to parse marketing strategy JSON');
  }

  return {
    frameworkSummary: parsed.frameworkSummary || '',
    dimensions: (parsed.dimensions || []).filter((d) => d.dimension && d.element && d.analysis),
    strategicRecommendations: parsed.strategicRecommendations || [],
  };
}
