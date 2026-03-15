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
} from '../types';

// Returns true when a research string contains no real data
function isEmptyResearch(text: string): boolean {
  return !text || text.startsWith('Research unavailable') || text.trim().length < 50;
}

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MAX_OUTPUT_TOKENS = 8192; // claude-sonnet-4-6 supports up to 8192
const SYNTHESIS_MODEL = 'claude-sonnet-4-6';

// ── Truncate research to stay within token budget ───────────────────────────

function truncateResearch(research: Record<string, string>, maxChars = 60000): Record<string, string> {
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
- Output ONLY valid JSON. No markdown fences, no explanation outside the JSON.`;

  const userPrompt = `Synthesize the following research into a peer benchmarking table comparing "${input.targetCompany}" against: ${peerNames}.

Selling org: "${input.userOrganization}" | Industry: ${input.industryContext}${input.focusAreas ? ` | Focus: ${input.focusAreas}` : ''}
${missingResearch.length > 0 ? `NOTE: No live research for ${missingResearch.join(', ')} — use training knowledge.` : ''}

RESEARCH DATA:
${Object.entries(safeResearch)
    .map(([co, r]) => `### ${co}\n${isEmptyResearch(r) ? `[Use training knowledge for ${co}]` : r}`)
    .join('\n---\n')}

Return a JSON array with EXACTLY this shape (one object per dimension):
[{"dimension":"ERP & Core IT Stack","targetCompany":{"value":"...","notes":"..."},"peers":{"${input.selectedCompetitors[0] ?? 'Peer1'}":{"value":"...","notes":"..."}}}]

Dimensions to cover (one array element each, in this exact order):
1. Stated IT Priority / Focus Area
2. AI / ML & Automation Investments
3. ERP & Core IT Stack
4. Digital Commerce & Customer Platform${input.focusAreas ? `\n5. ${input.focusAreas}` : ''}`;

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
  const safeResearch = truncateResearch(companyResearch, 24000);
  const peerNames = input.selectedCompetitors.join(', ');

  const missingResearch = Object.entries(safeResearch)
    .filter(([, text]) => isEmptyResearch(text))
    .map(([company]) => company);

  const systemPrompt = `You are a senior B2B sales intelligence analyst producing gap analyses for enterprise sales.
Rules:
- Draw primarily from the benchmarking table already compiled; use research data as supplementary context.
- Map SPECIFIC products from the selling org's portfolio to each gap (not generic capability names).
- Include realistic proof points or analyst benchmarks for each row.
- Never leave any field empty.
- FORMATTING: All text fields (peersBestPractice, targetStatus, gapDetail, solutionFit, proofPoint) MUST be formatted as bullet points separated by " • ". Wrap the most important keyword or phrase in each bullet with **double asterisks** for emphasis. Example: "**Real-time analytics** across supply chain • **Automated procurement** reducing cycle time by 40%"
- Output ONLY valid JSON. No markdown fences, no text outside the JSON array.`;

  const userPrompt = `Create a gap analysis for "${input.targetCompany}" vs peers: ${peerNames}.

Selling org: "${input.userOrganization}"${input.solutionPortfolio ? ` | Portfolio: ${input.solutionPortfolio}` : ''}
Industry: ${input.industryContext}
${missingResearch.length > 0 ? `NOTE: No live research for ${missingResearch.join(', ')} — rely on benchmarking table + training knowledge.` : ''}

BENCHMARKING TABLE (compact):
${JSON.stringify(benchmarkingTable)}

SUPPLEMENTARY RESEARCH (summary per company, max 4000 chars each):
${Object.entries(safeResearch)
    .map(([co, r]) => `### ${co}\n${isEmptyResearch(r) ? `[Use training knowledge]` : r.slice(0, 4000)}`)
    .join('\n---\n')}

Return a JSON array with EXACTLY this shape (one object per capability):
[{"capability":"...","peersBestPractice":"...","targetStatus":"...","gapLevel":"RED","gapDetail":"...","solutionFit":"...","proofPoint":"..."}]

gapLevel must be one of: "RED" (critical gap), "AMBER" (partial gap), "GREEN" (strength/parity).

Cover these 6 capability areas (one array element each):
1. ERP / Core Data Infrastructure
2. Digital Commerce & Customer Experience
3. AI / ML & Intelligent Automation
4. Contract & Process Automation
5. Supply Chain / Operational Execution
6. Scale & Investment Capacity`;

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
  return (items as GapAnalysisRow[]).filter((row) => row.capability && row.gapLevel);
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
- Output ONLY valid JSON. No markdown fences, no text outside the JSON array.`;

  const userPrompt = `Analyse the following research on "${input.companyName}" and identify their top ${config.label}.

${config.hint}

${hasResearch ? `RESEARCH:\n${research.slice(0, 60000)}` : `[No live research available — use your training knowledge about ${input.companyName}. Label estimates as "(est.)".]`}

${input.userOrganization ? `Selling organisation: "${input.userOrganization}"${input.solutionPortfolio ? ` | Portfolio: ${input.solutionPortfolio}` : ''}` : ''}

Return a JSON array with EXACTLY this shape (one object per theme, 6-8 themes total):
[
  {
    "theme": "Short punchy theme name (3-5 words)",
    "description": "2-3 sentence explanation of what this theme means for ${input.companyName} — be specific, cite programmes, executives, or data where available.",
    "examples": "Concrete example 1 | Concrete example 2 | Concrete example 3",
    "strategicImpact": "1-2 sentences on the strategic significance and what it signals about ${input.companyName}'s direction."
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
- Output ONLY valid JSON. No markdown fences, no text outside the JSON array.`;

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
  ? `RESEARCH:\n${research.slice(0, 60000)}`
  : `[No live research available — use training knowledge about ${input.companyName}. Label estimates as "(est.)".]`}

${input.userOrganization
  ? `Selling organisation: "${input.userOrganization}"${input.solutionPortfolio ? ` | Portfolio: ${input.solutionPortfolio}` : ''}`
  : ''}

Return a JSON array with EXACTLY this shape (8 objects):
[
  {
    "dimension": "Macroeconomics",
    "challenge": "2-3 sentences describing the most material macroeconomic challenge facing ${input.companyName} — be specific: name rates, geographies, FX pairs, or economic indicators.",
    "growthProspect": "2-3 sentences describing the macro or structural tailwind that creates the biggest growth opportunity — cite specific markets, demographics, or policy drivers."
  }
]

For EACH dimension:
- "challenge": The single most material, specific challenge — cite data, name the threat, quantify where possible.
- "growthProspect": The most compelling growth opportunity in that dimension — forward-looking, specific, actionable insight.`;

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
- Output ONLY valid JSON. No markdown fences, no text outside the JSON.`;

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

  const userPrompt = `Analyse the financial data for "${input.companyName}" (ticker: ${yahooData.ticker || 'N/A'}) and produce structured insights.

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
${hasParallelResearch ? parallelResearch.slice(0, 48000) : '[Not available — use the Google Finance data above and your training knowledge]'}

Return a single JSON object with EXACTLY this structure:
{
  "revenueInsight": "3-5 sentences analysing the revenue trend, growth rate trajectory, and what it signals about competitive positioning and market share.",
  "marginInsight": "3-5 sentences on margin evolution — what is driving expansion or compression, how it compares to sector peers, and the path forward.",
  "plInsight": "3-5 sentences on the P&L — the most significant items, cost structure efficiency, and any one-time items or structural shifts.",
  "bsInsight": "3-5 sentences on balance sheet health — liquidity, leverage, capital allocation, and balance sheet flexibility.",
  "cfInsight": "3-5 sentences on cash generation quality — operating cash conversion, capex intensity, free cash flow, and capital returns.",
  "keyHighlights": {
    "overallPerformance": "2-4 sentences: overall financial health, revenue scale, profitability status, and market position.",
    "overallPerformanceTagline": "3-6 word phrase summarising the main point, e.g. 'Strong revenue, margin pressure'",
    "factorsDrivingGrowth": "2-4 sentences: specific factors, products, segments, or markets driving revenue and profit growth.",
    "factorsDrivingGrowthTagline": "3-6 word phrase, e.g. 'Cloud & AI segment surge'",
    "factorsInhibitingGrowth": "2-4 sentences: headwinds, risks, competitive pressures, or structural challenges limiting growth.",
    "factorsInhibitingGrowthTagline": "3-6 word phrase, e.g. 'Rising input costs, FX headwinds'",
    "futureStrategy": "2-4 sentences: management's stated strategic priorities, capital allocation plans, M&A activity, or transformation initiatives.",
    "futureStrategyTagline": "3-6 word phrase, e.g. 'Pivot to platform model'",
    "growthOutlook": "2-4 sentences: forward-looking growth prospects, analyst consensus, guidance, and catalysts or risks on the horizon.",
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
    { "label": "Revenue", "value": "$383.3B", "yoy": "-2.8%", "isBold": true },
    { "label": "Cost of Revenue", "value": "$214.1B", "isBold": false },
    { "label": "Gross Profit", "value": "$169.1B", "yoy": "-1.5%", "isBold": true }
  ],
  "balanceSheetExtracted": [
    { "label": "Total Assets", "value": "$352.6B", "isBold": true }
  ],
  "cashFlowExtracted": [
    { "label": "Operating Cash Flow", "value": "$114.0B", "isBold": true }
  ]
}

Extraction rules:
- revenueHistoryExtracted / marginHistoryExtracted: 3-5 years newest-first. revenue must be raw integer USD (e.g. 383285000000). Percentages as numbers not strings.
- plStatementExtracted / balanceSheetExtracted / cashFlowExtracted: 8-15 key rows. isSection=true for category headers (value=""). isBold=true for subtotals/totals.
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
- Output ONLY valid JSON. No markdown fences.`;

  const userPrompt = `Produce a financial profile for private company "${input.companyName}".

${hasResearch ? `RESEARCH:\n${research.slice(0, 50000)}` : `[No live research — use training knowledge. Label all estimates as "(est.)"]`}

Return a JSON object with EXACTLY this structure:
{
  "estimatedRevenue": "Revenue estimate e.g. '$800M – $1.2B ARR (est.)' or '$2.4B revenue (FY2023)'",
  "profitabilityMargin": "Margin estimate e.g. 'EBITDA margin ~20-25% (est.)' or 'GAAP-profitable since Q3 2023'",
  "estimatedYoyGrowth": "Growth estimate e.g. '~25-35% YoY (est.)' or '18% revenue growth (2023)'",
  "fundingInfo": "e.g. 'Series D | $450M total raised | Last round: $150M in 2023 (Tiger Global, Andreessen Horowitz)'",
  "lastValuation": "e.g. '$4.5B (Series D, 2023)' or 'Not publicly disclosed'",
  "privateInsights": [
    "3-5 sentence insight about the company's financial trajectory and competitive positioning",
    "Key risk factor visible from the financial and funding profile",
    "Most significant growth driver or market opportunity",
    "Notable recent development (acquisition, partnership, product launch, leadership change)"
  ],
  "privateKeyHighlights": {
    "overallPerformance": "2-4 sentences: overall financial health, revenue scale, profitability status, and competitive positioning of this private company.",
    "overallPerformanceTagline": "3-6 word phrase summarising the main point, e.g. 'Rapid growth, pre-profit stage'",
    "factorsDrivingGrowth": "2-4 sentences: specific factors, products, markets, or strategic moves driving this company's growth.",
    "factorsDrivingGrowthTagline": "3-6 word phrase, e.g. 'Enterprise adoption accelerating'",
    "factorsInhibitingGrowth": "2-4 sentences: risks, competitive threats, market headwinds, or challenges limiting this company's growth.",
    "factorsInhibitingGrowthTagline": "3-6 word phrase, e.g. 'Intense competitive pressure'",
    "futureStrategy": "2-4 sentences: the company's known strategic direction, upcoming product launches, expansion plans, or transformation initiatives.",
    "futureStrategyTagline": "3-6 word phrase, e.g. 'Global expansion push'",
    "growthOutlook": "2-4 sentences: forward-looking assessment of the company's growth trajectory, market opportunity, and potential catalysts or risks.",
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
- Output ONLY valid JSON. No markdown fences, no text outside the JSON.`;

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
      "companySolution": "2-3 sentences: how ${input.yourCompany}'s solution directly addresses this priority with specifics",
      "proofPoints": "2-3 concrete proof points: cite metrics, case study outcomes, or industry recognitions",
      "whyNotCompetitor": "2-3 evidence-backed reasons ${input.competitorName} falls short on this specific priority"
    }
  ],
  "industrySolutions": [
    {
      "name": "Solution name",
      "problemSolved": "Specific problem this solves for ${input.targetIndustry} companies",
      "description": "1-2 sentence description of the solution and its key differentiator"
    }
  ],
  "techSummary": "3-4 sentences on ${input.yourCompany}'s technology stack, proprietary AI/ML capabilities, cloud architecture, and what fundamentally differentiates it from ${input.competitorName}",
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
- Output ONLY valid JSON. No markdown fences, no text outside the JSON array.`;

  const userPrompt = `Analyse the following research on "${input.companyName}" and produce a Key Prospective Buyers table.

The table should map senior executives to their publicly stated business focus areas, making it easy for a sales team to tailor their pitch.

${hasResearch
  ? `RESEARCH:\n${research.slice(0, 60000)}`
  : `[No live research available — use training knowledge about ${input.companyName}'s key executives and their known strategic priorities. Label estimates as "(est.)".]`}

Return a JSON array with 10-15 rows, EXACTLY this shape:
[
  {
    "keyExecutive": "Full Name, Exact Title, Department (e.g. 'John Smith, Chief Technology Officer, Technology')",
    "theme": "The business focus area the executive is championing (e.g. 'AI-Driven Supply Chain Optimisation', 'Cloud-First Digital Transformation', 'Sustainability & Net Zero')",
    "reference": "The EVENT where the executive made this statement — e.g. 'Annual General Meeting 2024', 'Investor Day Keynote, Nov 2024', 'World Economic Forum Panel, Jan 2025', 'Q3 FY2025 Earnings Call', 'Industry Summit Keynote'. This is NOT the source URL — it is the occasion, event, or forum where the quote originated.",
    "excerpt": "A direct quote from the executive if available (in quotation marks), OR a close paraphrase of their key statement. Keep it concise — 1-2 sentences max."
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
- Output ONLY valid JSON. No markdown fences, no text outside the JSON object.`;

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
  ? `RESEARCH:\n${research.slice(0, 60000)}`
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
