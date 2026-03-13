import Anthropic from '@anthropic-ai/sdk';
import {
  BenchmarkInput, BenchmarkDimension, GapAnalysisRow,
  ThemeInput, ThemeRow,
  ChallengesGrowthInput, ChallengesGrowthRow,
  FinancialAnalysisInput, FinancialAnalysisResult,
  RevenueDataPoint, MarginDataPoint, FinancialStatementRow,
  FinancialSegmentRow, GeoRow,
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
- Keep each value field to 1-2 concise sentences.
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
  keyHighlights: string[];
  segmentRevenue?: FinancialSegmentRow[];
  geoRevenue?: GeoRow[];
}

export async function synthesizeFinancialInsights(
  input: FinancialAnalysisInput,
  yahooData: Partial<FinancialAnalysisResult>,
  segmentResearch: string
): Promise<FinancialInsightsPayload> {
  const hasSegmentResearch = !isEmptyResearch(segmentResearch);

  const systemPrompt = `You are a senior equity analyst producing institutional-grade financial commentary.
Rules:
- Be specific: cite figures, percentages, year-on-year changes, named programmes.
- Insights must be 3-5 sentences each — analytical and forward-looking, not descriptive.
- Key highlights must be brief bullets suitable for an executive summary.
- For segment/geo data extraction, output precise numbers from the research.
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

REVENUE HISTORY: ${revenueStr || 'Not available'}
MARGIN HISTORY: ${marginStr || 'Not available'}
P&L HIGHLIGHTS: ${plStr || 'Not available'}
BALANCE SHEET HIGHLIGHTS: ${bsStr || 'Not available'}
CASH FLOW HIGHLIGHTS: ${cfStr || 'Not available'}

${hasSegmentResearch ? `SEGMENT/GEO RESEARCH:\n${segmentResearch.slice(0, 40000)}` : '[No segment research available]'}

Return a single JSON object with EXACTLY this structure:
{
  "revenueInsight": "3-5 sentences analysing the revenue trend, growth rate trajectory, and what it signals about competitive positioning and market share.",
  "marginInsight": "3-5 sentences on margin evolution — what is driving expansion or compression, how it compares to sector peers, and the path forward.",
  "plInsight": "3-5 sentences on the P&L — the most significant items, cost structure efficiency, and any one-time items or structural shifts.",
  "bsInsight": "3-5 sentences on balance sheet health — liquidity, leverage, capital allocation, and balance sheet flexibility.",
  "cfInsight": "3-5 sentences on cash generation quality — operating cash conversion, capex intensity, free cash flow, and capital returns.",
  "keyHighlights": [
    "Bullet 1: single most important financial takeaway",
    "Bullet 2: key risk or headwind visible in the financials",
    "Bullet 3: significant growth driver or catalyst",
    "Bullet 4: notable strategic capital allocation decision",
    "Bullet 5: forward-looking signal from the financial data"
  ],
  "segmentRevenue": [
    { "segment": "Segment Name", "revenue": "$X.XB", "percentage": 42.5, "yoyGrowth": "+8.2%" }
  ],
  "geoRevenue": [
    { "region": "Americas", "revenue": "$X.XB", "percentage": 55.0 }
  ],
  "segmentInsight": "3-5 sentences on segment mix — which segments are growing, which are declining, and what the mix shift means strategically. Omit if no segment data available.",
  "geoInsight": "3-5 sentences on geographic mix — regional growth rates, concentration risk, and international expansion signals. Omit if no geo data available."
}

For segmentRevenue and geoRevenue: extract from the SEGMENT/GEO RESEARCH above. If data is not available, return empty arrays [].
For segmentInsight and geoInsight: only include if meaningful data exists in the research. Otherwise set to null.`;

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
    const parsed = JSON.parse(match[0]) as FinancialInsightsPayload;
    return {
      revenueInsight: parsed.revenueInsight || '',
      marginInsight: parsed.marginInsight || '',
      segmentInsight: parsed.segmentInsight || undefined,
      geoInsight: parsed.geoInsight || undefined,
      plInsight: parsed.plInsight || '',
      bsInsight: parsed.bsInsight || '',
      cfInsight: parsed.cfInsight || '',
      keyHighlights: Array.isArray(parsed.keyHighlights) ? parsed.keyHighlights : [],
      segmentRevenue: Array.isArray(parsed.segmentRevenue) ? parsed.segmentRevenue : [],
      geoRevenue: Array.isArray(parsed.geoRevenue) ? parsed.geoRevenue : [],
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
  ]
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
    const parsed = JSON.parse(match[0]) as PrivateCompanyPayload;
    return {
      estimatedRevenue: parsed.estimatedRevenue || 'Not publicly disclosed',
      profitabilityMargin: parsed.profitabilityMargin || 'Not publicly disclosed',
      estimatedYoyGrowth: parsed.estimatedYoyGrowth || 'Not publicly disclosed',
      fundingInfo: parsed.fundingInfo,
      lastValuation: parsed.lastValuation,
      privateInsights: Array.isArray(parsed.privateInsights) ? parsed.privateInsights : [],
    };
  } catch {
    throw new Error('Failed to parse private company JSON');
  }
}
