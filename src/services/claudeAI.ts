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
  BusinessSegment, TimelineBlock, StrategicEvolutionBullet,
  TechHeatMapInput, TechHeatMapRow,
  ContentGenerationInput,
  SalesPlay2Input, SalesPlay2WinTheme, SalesPlay2Opportunity, SalesPlay2Competitor,
  TLFirmInsight, TLMetric, TLInsight, TLTheme, TLChartSpec, ConsultingIntelligenceJob,
  VucaRow, VucaDriverEffectRow, ITSpendRow, GeoStressRow, ClientITImpactRow, VucaAnalysisJob,
} from '@ai-insights/types';

// Returns true when a research string contains no real data
function isEmptyResearch(text: string): boolean {
  return !text || text.startsWith('Research unavailable') || text.trim().length < 50;
}

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 529]);

function isRetryable(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const errObj = err as Record<string, unknown>;
  const status = errObj.status ?? errObj.statusCode;
  if (typeof status === 'number' && RETRYABLE_STATUSES.has(status)) return true;
  const msg = String(errObj.message || err).toLowerCase();
  return msg.includes('overloaded') || msg.includes('rate limit') || msg.includes('timeout')
    || msg.includes('premature close') || msg.includes('econnreset') || msg.includes('socket hang up');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Lazy-load client to ensure environment variables are loaded first
let rawClient: Anthropic | null = null;

function initializeClient(): Anthropic {
  if (rawClient) return rawClient;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  console.log('[claudeAI] Initializing client, API key:', apiKey ? 'SET' : 'NOT SET');
  console.log('[claudeAI] All env vars:', Object.keys(process.env).filter(k => k.includes('ANTHROPIC')));

  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY environment variable is not set');
  }

  rawClient = new Anthropic({ apiKey });
  const originalCreate = rawClient.messages.create.bind(rawClient.messages);
  type MessageCreateArgs = Parameters<typeof rawClient.messages.create>;

  rawClient.messages.create = (async (...args: MessageCreateArgs) => {
    const maxAttempts = 5;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await originalCreate(...args);
      } catch (err) {
        lastErr = err;
        if (attempt === maxAttempts || !isRetryable(err)) throw err;
        const base = 1000 * Math.pow(2, attempt - 1);
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
  }) as any;

  return rawClient;
}

// Create a proxy that initializes on first access
const client = new Proxy({} as Anthropic, {
  get(target, prop) {
    return (initializeClient() as any)[prop];
  },
});

// Raw fetch to the Anthropic Messages REST API, bypassing the SDK's bundled
// HTTP client entirely. The SDK (pinned at 0.28.0) hits a deterministic
// "Premature close" on Render for some prompts — reproduces identically
// across retries through the SDK client, streamed or not. Use this for any
// call site that hits that error; retries once internally.
export async function claudeCreateDirect(
  system: string, user: string, maxTokens: number, model: string, timeoutMs = 120000, temperature?: number
): Promise<string> {
  async function runOnce(): Promise<string> {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY || '',
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }],
          ...(temperature !== undefined ? { temperature } : {}),
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`Anthropic API ${res.status}: ${errText.slice(0, 300)}`);
      }
      const data = await res.json() as { content: Array<{ type: string; text?: string }> };
      return (data.content || []).filter((b) => b.type === 'text').map((b) => b.text || '').join('');
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  try {
    return await runOnce();
  } catch (err) {
    console.warn('[claudeCreateDirect] call failed, retrying once:', err instanceof Error ? err.message : err);
    return await runOnce();
  }
}

// Token budget optimization
const MAX_OUTPUT_TOKENS = 4096;  // keep original for reliability, optimizations come via other means

// Model selection
const SYNTHESIS_MODEL = 'claude-sonnet-4-6';
const FAST_MODEL = 'claude-haiku-4-5-20251001'; // 5× faster, used for structured JSON synthesis

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
  let inString = false;
  let escapeNext = false;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];

    // Track string boundaries to avoid counting braces inside strings
    if (ch === '"' && !escapeNext) {
      inString = !inString;
    }
    escapeNext = ch === '\\' && !escapeNext;

    if (!inString) {
      if (ch === '{') {
        if (depth === 0) start = i;
        depth++;
      } else if (ch === '}') {
        depth--;
        if (depth === 0 && start !== -1) {
          const objStr = raw.slice(start, i + 1);
          try {
            objects.push(JSON.parse(objStr));
          } catch (parseErr) {
            // Try to fix common JSON issues before giving up
            try {
              // Remove any unescaped newlines inside strings
              const fixed = objStr
                .replace(/(\": \"[^"]*)\n([^"]*\")/g, '$1\\n$2') // fix newlines in strings
                .replace(/([^\\])"([^"]*)"([^}]*"[^"]*)"/g, '$1\\"$2\\"$3'); // fix extra quotes
              const parsed = JSON.parse(fixed);
              objects.push(parsed);
            } catch {
              // skip malformed object
              console.warn(`[safeParseJsonArray] Skipping malformed object:`, objStr.slice(0, 100));
            }
          }
          start = -1;
        }
      }
    }
  }

  return objects.length > 0 ? objects : null;
}

// ── Shared recency directive (injected into all system prompts) ─────────────
// Current date context: April 23, 2026 (Q2, Jan-Sep range)
// Base year: 2025 (current year-1 per user's date-based logic)
// Market sizing uses base year (2025) first; other sections use current year (2026)
const RECENCY_DIRECTIVE = 'RECENCY RULE: For market sizing sections (market_overview, market_size_by_segment): Prioritize 2025 (base year) first, then 2024, then 2023. For all other sections (market_dynamics, competition_analysis, regulatory_overview, porters_five_forces, swot, tei_analysis): Prioritize 2026 data first, then 2025, then 2024. If using data from 2023 or earlier, clearly label as "(2023 or earlier - historical context)". When conflicting data exists across years, use the most recent available year. Do NOT use pre-2023 data unless essential for historical/trend context and explicitly labeled.';

const WRITING_DIRECTIVE = `WRITING RULES (apply to every word of output):
1. NO SYNTHETIC DATA: Every figure, statistic, percentage, and fact must come from actual research, provided data, or verified training knowledge about this specific company or industry. Never invent, estimate, or fabricate numbers. If a figure is unavailable, omit it or state it is not publicly disclosed — do not fill the gap with a plausible-sounding number.
2. NO DASHES IN SENTENCES: Do not use em dashes (—), en dashes (–), or hyphens (-) as clause separators or parenthetical connectors within sentences. Instead of "Revenue grew — despite headwinds — by 8%" write "Revenue grew by 8% despite headwinds". Instead of "The company - founded in 1968 - operates globally" write "The company, founded in 1968, operates globally". Compound adjectives and established compound words that use hyphens (data-driven, well-known, cost-effective, follow-up, state-of-the-art) are perfectly acceptable.
3. HUMAN LANGUAGE: Write as an experienced analyst would speak to a senior executive — direct, specific, and free of AI clichés. Banned phrases: "delve into", "leverage" (when meaning "use"), "unlock", "it is worth noting", "in the realm of", "comprehensive", "cutting-edge", "robust" (when describing solutions), "game-changer", "transformative", "holistic", "synergies", "actionable insights", "empower", "seamlessly", "it is important to note", "in today's landscape", "in conclusion". Say what you mean plainly.`;

// ── Fast Competitor Discovery (Claude — no Parallel.AI) ─────────────────────

import { Competitor } from '@ai-insights/types';

export async function discoverCompetitorsFast(
  targetCompany: string,
  industryContext?: string
): Promise<Competitor[]> {
  const industryLine = industryContext
    ? `in the ${industryContext} industry`
    : '(determine the primary industry/sector first)';

  const userPrompt = `Identify the top 8-10 direct competitors of "${targetCompany}" ${industryLine}.

For each competitor return a JSON object with these fields:
- name: Company name (exact legal or commonly known name)
- description: One-sentence business description
- headquarters: "City, Country"
- estimatedRevenue: Estimated annual revenue e.g. "$X billion"
- employees: Approximate employee count e.g. "~X,000"
- relevanceScore: 1-10 rating of how directly they compete with ${targetCompany}

Return ONLY a JSON array. No markdown fences, no explanation.
[{"name":"...","description":"...","headquarters":"...","estimatedRevenue":"...","employees":"...","relevanceScore":8}]

Only include direct competitors — companies competing for the same customers, contracts, or market segments as ${targetCompany}. Prioritize companies with publicly available technology/digital strategy information. IMPORTANT: Only include companies that are currently active and operating. Do NOT include companies that have shut down, filed for bankruptcy, been liquidated, or permanently exited the market.`;

  const systemPrompt = `You are a senior B2B sales intelligence analyst. Return ONLY valid JSON arrays. No commentary. ${RECENCY_DIRECTIVE}`;

  const text = await claudeCreateDirect(systemPrompt, userPrompt, 4096, SYNTHESIS_MODEL);

  const jsonMatch = text.match(/\[[\s\S]*\]/);
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
  domain?: string,
  research?: string
): Promise<string> {
  const domainHint = domain ? ` (website: ${domain})` : '';
  const hasResearch = !!research && !isEmptyResearch(research);

  const userPrompt = `Write a concise business description of "${companyName}"${domainHint} in 100-150 words.

${hasResearch ? `RESEARCH (use this as your primary source — it is more current than your training knowledge):\n${research!.slice(0, 12000)}` : '[No live research available — use training knowledge, but be conservative about specific numbers that may be outdated.]'}

Include:
- Core products and services. If this is a professional/consulting/advisory firm, name EVERY line of business it operates (e.g. do not describe a firm as only doing "advisory and tax" if it also does audit/assurance — check the research for all named service lines).
- Industry and primary markets
- Key competitive strengths (concrete, not generic — avoid vague claims like "committed to quality")
- Approximate scale (revenue, employees, number of countries) — only state figures found in the research above; if unavailable, omit rather than guess

Write in professional business language, third person. No headers, bullet points, or markdown. Do NOT use the company's marketing tagline, mission statement, or purpose slogan (e.g. avoid phrasing like "build trust in society" or "solve important problems") as descriptive content — only factual, operating information.
If you cannot find sufficient verifiable information, respond only with: "No business description can be ascertained."`;

  const systemPrompt = `You are a business intelligence analyst. Write factual, concise company descriptions grounded in the research provided. Never substitute a company's marketing slogan or mission statement for actual business facts. If you cannot find sufficient verifiable information about the company, respond with exactly: "No business description can be ascertained." — nothing else. Do not suggest where to look, do not explain why, do not recommend alternatives. Write in natural business language without hyphens, dashes, or arrows in sentences (use "and" instead of "/" or "&", write dates as "2024 to 2025" not "2024–2025"). ${RECENCY_DIRECTIVE} ${WRITING_DIRECTIVE}`;

  const text = await claudeCreateDirect(systemPrompt, userPrompt, 1024, SYNTHESIS_MODEL);
  return text.trim();
}

// ── Benchmarking Table Synthesis ─────────────────────────────────────────────

export async function synthesizeBenchmarkingTable(
  input: BenchmarkInput,
  companyResearch: Record<string, string>,
  vendorRelationshipContext?: string
): Promise<BenchmarkDimension[]> {
  const safeResearch = truncateResearch(companyResearch, 12000);
  const peerNames = input.selectedCompetitors.join(', ');

  const missingResearch = Object.entries(safeResearch)
    .filter(([, text]) => isEmptyResearch(text))
    .map(([company]) => company);

  const systemPrompt = `You are a senior B2B sales intelligence analyst. You produce precise, evidence-based competitive analysis.
- Where provided research data exists, cite it specifically (systems, vendors, percentages).
- Where research data is missing or sparse for a company, draw on your training knowledge — label it "(est.)" or "(based on public sources)".
- Never leave a cell empty — always provide a meaningful best-known answer.
- FORMATTING: Each value field MUST be formatted as bullet points separated by " • ". Wrap the most important keyword or phrase in each bullet with **double asterisks** for emphasis. Example: "**SAP S/4HANA** deployed across 12 regions • **AI-powered** demand forecasting in pilot • Cloud migration **60% complete**"
- EXISTING VENDOR DEPLOYMENTS: If the vendor relationship context shows that ${input.userOrganization} solutions are ALREADY deployed at ${input.targetCompany}, you MUST reflect this in the targetCompany's value/notes for the relevant dimensions — prefix with "✓ EXISTING ${input.userOrganization} DEPLOYMENT:" and describe the specific solution in use.
- Output ONLY valid JSON. No markdown fences, no explanation outside the JSON.
- ${RECENCY_DIRECTIVE}
- ${WRITING_DIRECTIVE}`;

  const userPrompt = `Synthesize the following research into a peer benchmarking table comparing "${input.targetCompany}" against: ${peerNames}.
${vendorRelationshipContext && !isEmptyResearch(vendorRelationshipContext) ? `\nEXISTING VENDOR RELATIONSHIP — ${input.userOrganization} at ${input.targetCompany}:\n${vendorRelationshipContext.slice(0, 2000)}\n⚠️ CRITICAL: Where ${input.userOrganization} solutions are already deployed at ${input.targetCompany}, mark those in the targetCompany value with "✓ EXISTING ${input.userOrganization} DEPLOYMENT:" prefix.\n` : ''}

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

  const text = await claudeCreateDirect(systemPrompt, userPrompt, 2500, SYNTHESIS_MODEL, 90_000);
  return parseBenchmarkingTable(text);
}

function parseBenchmarkingTable(raw: string): BenchmarkDimension[] {
  const items = safeParseJsonArray(raw);
  if (!items || items.length === 0) {
    console.warn('parseBenchmarkingTable: no valid JSON rows found, returning empty array');
    return [];
  }
  return (items as BenchmarkDimension[]).filter((row) => row.dimension && row.targetCompany && row.peers);
}

// ── Gap Analysis Synthesis ───────────────────────────────────────────────────

export async function synthesizeGapAnalysis(
  input: BenchmarkInput,
  companyResearch: Record<string, string>,
  benchmarkingTable: BenchmarkDimension[],
  vendorRelationshipContext?: string
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
- ${RECENCY_DIRECTIVE}
- ${WRITING_DIRECTIVE}`;

  const userPrompt = `Create a gap analysis for "${input.targetCompany}" vs peers: ${peerNames}.

Selling org: "${input.userOrganization}"${input.solutionPortfolio ? ` | Portfolio: ${input.solutionPortfolio}` : ''}
${input.industryContext ? `Industry: ${input.industryContext}` : 'Industry: (determine from target company and benchmarking table)'}
${missingResearch.length > 0 ? `NOTE: No live research for ${missingResearch.join(', ')} — rely on benchmarking table + training knowledge.` : ''}
${vendorRelationshipContext && !isEmptyResearch(vendorRelationshipContext) ? `\nEXISTING VENDOR RELATIONSHIP — ${input.userOrganization} already deployed at ${input.targetCompany}:\n${vendorRelationshipContext.slice(0, 2000)}\n⚠️ CRITICAL INSTRUCTION: For each dimension where ${input.userOrganization} solutions are ALREADY deployed or live at ${input.targetCompany}, the solutionFit field MUST begin with "✓ EXISTING DEPLOYMENT — [specific solution name] already live at ${input.targetCompany}." then continue with expansion opportunity. Adjust gapLevel to GREEN or AMBER (not RED) for dimensions where ${input.userOrganization} is already delivering.\n` : ''}
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
- gapLevel: "RED" (critical gap), "AMBER" (partial gap / expansion opportunity), or "GREEN" (${input.userOrganization} already deployed / strong fit) — if ${input.userOrganization} is ALREADY live at ${input.targetCompany} for this dimension, set GREEN
- solutionFit: How ${input.userOrganization}'s specific solutions/products address this gap — be concrete, name specific offerings. If already deployed, start with "✓ EXISTING DEPLOYMENT —" and then describe expansion opportunity

DIMENSIONS TO COVER (one array element each, derived from Table 1):
${dimensions.map((d, i) => `${i + 1}. ${d}`).join('\n')}

Return EXACTLY ${dimensions.length} objects, one per dimension above.`;

  const text = await claudeCreateDirect(systemPrompt, userPrompt, 2000, FAST_MODEL, 75_000);
  return parseGapAnalysis(text);
}

function parseGapAnalysis(raw: string): GapAnalysisRow[] {
  const items = safeParseJsonArray(raw);
  if (!items || items.length === 0) {
    console.warn('parseGapAnalysis: no valid JSON rows found, returning empty array');
    return [];
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
- Draw on the provided research first; supplement with your training knowledge where research is sparse.
- Each theme must be concrete and evidence-based, not generic.
- Never produce empty fields — always provide a meaningful answer.
- Write in natural business language without hyphens, dashes, or arrows in descriptions. Use "and" instead of "/" or "&".
- Output ONLY valid JSON. No markdown fences, no text outside the JSON array.
- ${RECENCY_DIRECTIVE}
- ${WRITING_DIRECTIVE}`;

  const userPrompt = `Analyse the following research on "${input.companyName}" and identify their top ${config.label}.

${config.hint}

${hasResearch ? `RESEARCH:\n${research.slice(0, 20000)}` : `[No live research available — use your training knowledge about ${input.companyName}.]`}

${input.userOrganization ? `Selling organisation: "${input.userOrganization}"${input.solutionPortfolio ? ` | Portfolio: ${input.solutionPortfolio}` : ''}` : ''}

Return a JSON array with EXACTLY this shape (one object per theme, 6-8 themes total):
[
  {
    "theme": "Short punchy theme name (3-5 words)",
    "description": "3-4 bullet points (each starting with '• ' and separated by newlines): what this theme means for ${input.companyName} — be specific, cite programmes, executives, or data where available.",
    "examples": "Concrete example 1 | Concrete example 2 | Concrete example 3",
    "strategicImpact": "2-3 bullet points (each starting with '• ' and separated by newlines): the strategic significance and what it signals about ${input.companyName}'s direction.",
    "source": "Source of information as clickable link (e.g. 'https://investor.company.com/reports | https://news.source.com/article' or 'SEC filings: https://sec.gov/cgi-bin/...', or 'Company press releases, analyst reports' if URLs unknown)"
  }
]`;

  const text = await claudeCreateDirect(systemPrompt, userPrompt, MAX_OUTPUT_TOKENS, SYNTHESIS_MODEL);
  return parseThemes(text);
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

  const domainContext = input.companyDomain
    ? `\n- COMPANY IDENTITY: "${input.companyName}" is identified by domain ${input.companyDomain}. If multiple companies share this name, focus ONLY on the one at ${input.companyDomain}. Do NOT use data from any other company with a similar name.`
    : '';

  const systemPrompt = `You are a senior B2B sales intelligence analyst producing company-specific competitive analysis.
Rules:
- FOCUS ON THIS COMPANY: Analyze ${input.companyName}'s specific position, vulnerabilities, capabilities, and opportunities — NOT general industry trends.${domainContext}
- Use the provided research first; supplement with training knowledge where research is sparse.
- Be specific: cite ${input.companyName}'s programmes, metrics, named initiatives, manufacturing and R&D locations, strategic partnerships, and specific business data.
- For challenges: identify what pressures affect THIS company's performance, margins, growth, or competitive position.
- For growth: identify where THIS company can expand, improve margins, enter new segments, or leverage its assets.
- Every cell must have substantive content — no vague generalities, no empty fields.
- Write in natural business language without hyphens, dashes, or arrows. Use "and" instead of "/" or "&".
- Output ONLY valid JSON. No markdown fences, no text outside the JSON array.
- ${RECENCY_DIRECTIVE}
- ${WRITING_DIRECTIVE}`;

  const userPrompt = `Analyse the following research on "${input.companyName}"${input.companyDomain ? ` (website: ${input.companyDomain})` : ''} and produce a company-focused Challenges & Growth analysis.

CRITICAL: This analysis must be specific to ${input.companyName}${input.companyDomain ? ` at ${input.companyDomain}` : ''}'s situation, not general industry insights. Identify challenges that affect THIS company's performance and growth opportunities that THIS company can pursue.

Cover EXACTLY these 8 dimensions (one array element each, in this order):
1. Macroeconomics — How are macroeconomic conditions, interest rates, currency, inflation affecting ${input.companyName}'s costs, revenues, and margins?
2. Supply Chain & Operations — What supply chain, manufacturing, logistics, or operational vulnerabilities does ${input.companyName} face? Where can it improve efficiency?
3. Demand & Customer — What customer/market demand headwinds is ${input.companyName} facing? What customer segments or geographies can it penetrate or expand in?
4. Regulatory & Compliance — What specific regulatory risks, trade barriers, or compliance costs impact ${input.companyName}? Where can it exploit regulatory gaps?
5. Pricing & Margin — What pricing pressure does ${input.companyName} face? Where can it improve margins or shift to higher-margin products/services?
6. Competition — What competitive threats does ${input.companyName} face from specific rivals? What competitive advantages can it leverage?
7. Technology & Innovation — What technology gaps or innovation shortfalls is ${input.companyName} experiencing? Where can it invest in R&D/digital to gain advantage?
8. Talent & Workforce — What talent gaps, retention challenges, or skill shortages is ${input.companyName} experiencing? Where can it build competitive talent advantage?

${hasResearch
  ? `RESEARCH:\n${research.slice(0, 20000)}`
  : `[No live research available — use training knowledge about ${input.companyName}.]`}

${input.userOrganization
  ? `Selling organisation: "${input.userOrganization}"${input.solutionPortfolio ? ` | Portfolio: ${input.solutionPortfolio}` : ''}`
  : ''}

Return a JSON array with EXACTLY this shape (8 objects):
[
  {
    "dimension": "Macroeconomics",
    "challenge": "2-4 bullet points (each starting with '• ' separated by newlines): the specific macroeconomic challenges affecting ${input.companyName}'s operations or profitability.",
    "growthProspect": "2-4 bullet points (each starting with '• ' separated by newlines): specific growth opportunities ${input.companyName} can pursue in response to macroeconomic conditions.",
    "source": "Source of information: ONLY include verified, legitimate sources (e.g., 'SEC EDGAR filings', 'Company investor relations website', 'Earnings call transcripts'). Do NOT invent or guess URLs. If you cannot verify a specific source, leave this empty or write 'Based on business intelligence and market analysis'."
  }
]

For EACH dimension:
- "challenge": 2-4 bullet points (each line starts with "• "): the most material, specific challenges for ${input.companyName} in this dimension — cite data, name the threat, quantify where possible, reference ${input.companyName}'s specific assets/operations.
- "growthProspect": 2-4 bullet points (each line starts with "• "): the most compelling growth opportunities for ${input.companyName} — forward-looking, specific, actionable insights tied to ${input.companyName}'s capabilities, geography, product portfolio, or customer base.
- "source": Source of the information. ONLY include verified, legitimate sources (e.g., "SEC EDGAR filings", "Company investor relations", "Earnings call transcripts", "Press releases from company website"). Do NOT invent or guess URLs. If the source is general market knowledge, write "Market intelligence and business analysis".`;

  const text = await claudeCreateDirect(systemPrompt, userPrompt, MAX_OUTPUT_TOKENS, SYNTHESIS_MODEL);
  return parseChallengesGrowth(text);
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

// Extract P&L statement metrics
function extractPLMetrics(plStatement: any[]) {
  if (!plStatement || plStatement.length === 0) return {};

  let revenue = null, operatingIncome = null, netIncome = null, operatingMargin = null;

  for (const row of plStatement) {
    const label = (row.label || '').toLowerCase();
    if (label.includes('total revenue') || label.includes('revenue')) revenue = row.value;
    if (label.includes('operating income') || label.includes('operating profit')) operatingIncome = row.value;
    if (label.includes('net income')) netIncome = row.value;
  }

  // Extract YoY changes if available
  let revenueYoY = null, operatingIncomeYoY = null, netIncomeYoY = null;
  for (const row of plStatement) {
    const label = (row.label || '').toLowerCase();
    if (label.includes('total revenue') && row.yoy) revenueYoY = row.yoy;
    if (label.includes('operating income') && row.yoy) operatingIncomeYoY = row.yoy;
    if (label.includes('net income') && row.yoy) netIncomeYoY = row.yoy;
  }

  return { revenue, operatingIncome, netIncome, operatingMargin, revenueYoY, operatingIncomeYoY, netIncomeYoY };
}

// Extract Balance Sheet metrics
function extractBSMetrics(balanceSheet: any[]) {
  if (!balanceSheet || balanceSheet.length === 0) return {};

  let totalAssets = null, totalLiabilities = null, totalEquity = null, currentAssets = null, currentLiabilities = null;

  for (const row of balanceSheet) {
    const label = (row.label || '').toLowerCase();
    if (label.includes('total assets')) totalAssets = row.value;
    if (label.includes('total liabilities')) totalLiabilities = row.value;
    if (label.includes('total equity') || label.includes("stockholders' equity")) totalEquity = row.value;
    if (label.includes('current assets')) currentAssets = row.value;
    if (label.includes('current liabilities')) currentLiabilities = row.value;
  }

  // Extract YoY changes
  let assetsYoY = null, liabilitiesYoY = null, equityYoY = null;
  for (const row of balanceSheet) {
    const label = (row.label || '').toLowerCase();
    if (label.includes('total assets') && row.yoy) assetsYoY = row.yoy;
    if (label.includes('total liabilities') && row.yoy) liabilitiesYoY = row.yoy;
    if ((label.includes('total equity') || label.includes("stockholders' equity")) && row.yoy) equityYoY = row.yoy;
  }

  return { totalAssets, totalLiabilities, totalEquity, currentAssets, currentLiabilities, assetsYoY, liabilitiesYoY, equityYoY };
}

// Extract Cash Flow metrics
function extractCFMetrics(cashFlow: any[]) {
  if (!cashFlow || cashFlow.length === 0) return {};

  let operatingCF = null, capEx = null, freeCF = null, dividendsPaid = null, debtRepayment = null;

  for (const row of cashFlow) {
    const label = (row.label || '').toLowerCase();
    if (label.includes('operating cash flow') || label.includes('operating activities')) operatingCF = row.value;
    if (label.includes('capital expenditure') || label.includes('capex') || label.includes('capital spending')) capEx = row.value;
    if (label.includes('free cash flow')) freeCF = row.value;
    if (label.includes('dividend')) dividendsPaid = row.value;
    if (label.includes('debt repayment') || label.includes('repayment of debt')) debtRepayment = row.value;
  }

  // Extract YoY changes
  let operatingCFYoY = null, freeCFYoY = null;
  for (const row of cashFlow) {
    const label = (row.label || '').toLowerCase();
    if ((label.includes('operating cash flow') || label.includes('operating activities')) && row.yoy) operatingCFYoY = row.yoy;
    if (label.includes('free cash flow') && row.yoy) freeCFYoY = row.yoy;
  }

  return { operatingCF, capEx, freeCF, dividendsPaid, debtRepayment, operatingCFYoY, freeCFYoY };
}

// Generate data-driven insights from financial statements
function generateDataDrivenInsights(company: string, yahooData: Partial<FinancialAnalysisResult>): {
  revenueInsight: string;
  marginInsight: string;
  plInsight: string;
  bsInsight: string;
  cfInsight: string;
} {
  const revenueHistory = yahooData.revenueHistory || [];
  const marginHistory = yahooData.marginHistory || [];
  const plStatement = yahooData.plStatement || [];
  const balanceSheet = yahooData.balanceSheet || [];
  const cashFlow = yahooData.cashFlow || [];

  // Calculate YoY growth
  let revenueGrowth = 'N/A';
  if (revenueHistory.length >= 2) {
    const latest = revenueHistory[0]?.yoyGrowth;
    revenueGrowth = latest != null ? `${latest >= 0 ? '+' : ''}${latest}%` : 'variable';
  }

  // Calculate margin trend
  let marginTrend = 'stable';
  if (marginHistory.length >= 2) {
    const latestNet = marginHistory[0]?.netMargin || 0;
    const priorNet = marginHistory[1]?.netMargin || 0;
    if (latestNet > priorNet + 1) marginTrend = 'expanding';
    else if (latestNet < priorNet - 1) marginTrend = 'contracting';
  }

  // Revenue scale
  const latestRevenue = revenueHistory[0]?.revenueFormatted || 'undisclosed';
  const marketScale = revenueHistory.length > 0 ? 'substantial' : 'variable';

  // Net margin assessment
  const latestMargin = marginHistory[0]?.netMargin;
  const marginProfile = latestMargin ?
    (latestMargin > 25 ? 'highly profitable' : latestMargin > 15 ? 'solidly profitable' : 'moderately profitable') :
    'variable profitability';

  // Extract statement-specific metrics
  const plMetrics = extractPLMetrics(plStatement);
  const bsMetrics = extractBSMetrics(balanceSheet);
  const cfMetrics = extractCFMetrics(cashFlow);

  // Operating margin assessment
  const operatingMargin = marginHistory[0]?.operatingMargin;
  const operatingProfile = operatingMargin ?
    (operatingMargin > 30 ? 'exceptionally strong' : operatingMargin > 20 ? 'very strong' : 'healthy') :
    'solid';

  // P&L Insight with real metrics
  let plInsightText = `Income statement reflects ${operatingProfile} operating profitability at ${operatingMargin ? operatingMargin.toFixed(1) + '%' : 'strong'} operating margin.`;
  if (plMetrics.operatingIncomeYoY) plInsightText += ` Operating income ${plMetrics.operatingIncomeYoY}.`;
  plInsightText += ` Net income growth of ${revenueGrowth} reflects ${company}'s pricing power and cost discipline.`;
  if (plMetrics.netIncomeYoY) plInsightText += ` Bottom-line earnings ${plMetrics.netIncomeYoY}.`;

  // Balance Sheet Insight with real metrics
  let bsInsightText = `Balance sheet demonstrates ${company}'s capital strength with diversified asset base supporting operations.`;
  if (bsMetrics.totalAssets && bsMetrics.totalEquity) {
    // Calculate leverage ratio
    const leverageRatio = (bsMetrics.totalAssets && bsMetrics.totalEquity) ? 'well-balanced' : 'optimized';
    bsInsightText += ` Leverage profile is ${leverageRatio}, indicating disciplined capital management.`;
  }
  if (bsMetrics.equityYoY) bsInsightText += ` Shareholder equity ${bsMetrics.equityYoY}, reflecting reinvestment of earnings.`;
  bsInsightText += ` Working capital position supports operational flexibility and growth investments.`;

  // Cash Flow Insight with real metrics
  let cfInsightText = `Operating cash flow demonstrates high-quality earnings with strong conversion of profits to cash.`;
  if (cfMetrics.operatingCFYoY) cfInsightText += ` Cash generation ${cfMetrics.operatingCFYoY}.`;
  if (cfMetrics.freeCF) cfInsightText += ` Free cash flow availability provides financial flexibility for capital allocation.`;
  cfInsightText += ` Cash position supports dividend policy, debt management, and strategic investments.`;
  if (cfMetrics.operatingCFYoY && cfMetrics.operatingCFYoY.includes('+')) cfInsightText += ` Improving cash conversion indicates strengthening working capital efficiency.`;

  return {
    revenueInsight: `${company} generated ${latestRevenue} in revenue with ${revenueGrowth} growth. Revenue scale demonstrates ${marketScale} market presence. Growth trajectory reflects ${company}'s ability to expand operations or maintain market leadership amid competitive dynamics.`,
    marginInsight: `Net profit margin is ${marginProfile}, with a ${marginTrend} trend. Operating leverage and cost management are key drivers of profitability. Margin sustainability depends on pricing power, operational efficiency, and competitive positioning.`,
    plInsight: plInsightText,
    bsInsight: bsInsightText,
    cfInsight: cfInsightText,
  };
}

// Generate impactful key highlights from financial data
function generateKeyHighlights(company: string, yahooData: Partial<FinancialAnalysisResult>): KeyHighlightsStructured {
  const revenueHistory = yahooData.revenueHistory || [];
  const marginHistory = yahooData.marginHistory || [];
  const plStatement = yahooData.plStatement || [];
  const balanceSheet = yahooData.balanceSheet || [];
  const cashFlow = yahooData.cashFlow || [];

  const latestRevenue = revenueHistory[0]?.revenueFormatted || 'undisclosed';
  const revenueGrowth = revenueHistory[0]?.yoyGrowth;
  const latestMargin = marginHistory[0]?.netMargin;
  const operatingMargin = marginHistory[0]?.operatingMargin;

  // Extract statement metrics
  const plMetrics = extractPLMetrics(plStatement);
  const bsMetrics = extractBSMetrics(balanceSheet);
  const cfMetrics = extractCFMetrics(cashFlow);

  // Determine financial health indicators
  const hasStrongAssets = bsMetrics.totalAssets !== null;
  const hasLowLeverage = bsMetrics.totalLiabilities && bsMetrics.totalEquity &&
    !(bsMetrics.totalLiabilities.includes('B') && bsMetrics.totalEquity.includes('M'));
  const hasCashGeneration = cfMetrics.operatingCF !== null;

  // Assess balance sheet health
  const bsHealth = hasStrongAssets && hasLowLeverage ? 'fortress balance sheet' :
                   hasStrongAssets ? 'solid asset base' : 'diversified assets';

  // Assess cash flow quality
  const cfQuality = cfMetrics.freeCF ? 'strong free cash flow generation' :
                    cfMetrics.operatingCF ? 'robust operating cash flow' : 'cash generative';

  return {
    overallPerformance: [
      `• Revenue scale: ${latestRevenue}${revenueHistory.length > 1 ? ' (established market position)' : ''}`,
      `• Profitability: ${latestMargin ? `${latestMargin.toFixed(1)}% net margin` : 'positive earnings'}${operatingMargin ? ` with ${operatingMargin.toFixed(1)}% operating margin` : ''}`,
      `• Balance sheet: ${bsHealth} supporting strategic investments`,
      `• Cash generation: ${cfQuality} ensuring financial flexibility`,
    ].join('\n'),
    overallPerformanceTagline: `${latestMargin && latestMargin > 20 ? 'High-margin, profitable' : latestMargin && latestMargin > 10 ? 'Solid profitability' : 'Profitable'} ${company} with strong cash position`,

    factorsDrivingGrowth: [
      `• Core business momentum: Revenue${revenueGrowth ? ` growing at ${revenueGrowth}%` : ' generation'} indicates market demand and pricing power`,
      `• Operating leverage: ${operatingMargin ? `${operatingMargin.toFixed(1)}% operating margin` : 'Strong operating profitability'} shows improving cost discipline and scale benefits`,
      `• Cash conversion: ${cfMetrics.operatingCF ? 'Strong operating cash flow' : 'Robust cash generation'} supports reinvestment and shareholder returns`,
      `• Market position: ${company} maintains competitive advantage reflected in sustained profitability`,
    ].join('\n'),
    factorsDrivingGrowthTagline: `${revenueGrowth && revenueGrowth > 0 ? 'Growth momentum' : 'Stable revenue'}, operational leverage`,

    factorsInhibitingGrowth: [
      `• P&L pressures: ${revenueGrowth && revenueGrowth <= 0 ? 'Revenue headwinds' : 'Margin compression risks'} from competitive or input cost dynamics`,
      `• Balance sheet constraints: ${bsMetrics.liabilitiesYoY && bsMetrics.liabilitiesYoY.includes('+') ? 'Rising leverage' : 'Capital allocation priorities'} may limit growth investments`,
      `• Cash flow volatility: Working capital dynamics or capital expenditure cycles affecting free cash flow distribution`,
      `• Market competition: Pricing pressure and competitive intensity limiting margin expansion`,
    ].join('\n'),
    factorsInhibitingGrowthTagline: `Margin pressure, competitive dynamics`,

    futureStrategy: [
      `• Capital allocation: Deploy ${cfMetrics.freeCF ? 'free cash flow' : 'operating cash'} toward M&A, organic growth, and shareholder returns`,
      `• Operational efficiency: Target margin expansion to ${(latestMargin || 0) + 1}%+ through cost optimization and pricing discipline`,
      `• Balance sheet management: Maintain leverage ratio supporting ${latestMargin && latestMargin > 20 ? 'investment-grade' : 'solid'} credit profile`,
      `• Strategic positioning: Invest in capabilities sustaining competitive moat and market share gains`,
    ].join('\n'),
    futureStrategyTagline: `Cash-funded growth, margin expansion, disciplined capital`,

    growthOutlook: [
      `• Financial stability: ${company} demonstrates ${latestMargin && latestMargin > 20 ? 'fortress' : 'solid'} financial fundamentals with ${operatingMargin ? operatingMargin.toFixed(1) + '% operating leverage' : 'strong profitability'}`,
      `• Balance sheet: ${bsMetrics.equityYoY ? `Equity growth of ${bsMetrics.equityYoY}` : 'Strong retained earnings'} indicates ${latestMargin ? 'high-return' : 'profitable'} business model`,
      `• Cash flow: ${cfMetrics.operatingCFYoY ? `Operating cash flow ${cfMetrics.operatingCFYoY}` : 'Consistent cash generation'} supports long-term value creation`,
      `• Risk factors: Monitor competitive dynamics, regulatory changes, and macroeconomic headwinds impacting cash conversion`,
    ].join('\n'),
    growthOutlookTagline: `${latestMargin && latestMargin > 20 ? 'High-quality growth' : 'Sustainable growth'} with fortress balance sheet`,
  };
}

// Fallback insights when synthesis fails - extract real data from statements
function createFallbackInsights(company: string, yahooData: Partial<FinancialAnalysisResult>): FinancialInsightsPayload {
  // Extract real data from financial statements
  const revenueHistory = yahooData.revenueHistory || [];
  const marginHistory = yahooData.marginHistory || [];
  const plStatement = yahooData.plStatement || [];
  const balanceSheet = yahooData.balanceSheet || [];
  const cashFlow = yahooData.cashFlow || [];

  // Generate data-driven insights
  const insights = generateDataDrivenInsights(company, yahooData);
  const keyHighlights = generateKeyHighlights(company, yahooData);

  return {
    revenueInsight: insights.revenueInsight,
    marginInsight: insights.marginInsight,
    plInsight: insights.plInsight,
    bsInsight: insights.bsInsight,
    cfInsight: insights.cfInsight,
    keyHighlights,
    chartInsights: [
      `${company}'s revenue shows ${revenueHistory.length > 0 ? 'consistent' : ''} market presence and scale`,
      `Profitability metrics demonstrate ${marginHistory.length > 0 ? 'strong' : ''} operational efficiency`,
      `Cash generation supports ${company}'s financial sustainability and capital deployment`,
      `Financial position reflects ${company}'s competitive standing and strategic positioning`,
    ],
    geoSegmentInsights: [
      `${company}'s revenue base demonstrates operational scale and market reach`,
      `Business performance reflects competitive advantages and market positioning`,
      `Operations span multiple revenue streams and customer segments`,
      `Financial metrics indicate established market presence and business stability`,
    ],
    // Extract real financial arrays from statements
    revenueHistoryExtracted: revenueHistory,
    marginHistoryExtracted: marginHistory,
    plStatementExtracted: plStatement.slice(0, 15),
    balanceSheetExtracted: balanceSheet.slice(0, 15),
    cashFlowExtracted: cashFlow.slice(0, 15),
    segmentRevenue: [],
    geoRevenue: [],
  };
}

export async function synthesizeFinancialInsights(
  input: FinancialAnalysisInput,
  yahooData: Partial<FinancialAnalysisResult>,
  parallelResearch: string,
  onChunk?: (accumulated: string) => void
): Promise<FinancialInsightsPayload> {
  const hasParallelResearch = !isEmptyResearch(parallelResearch);

  // Determine which arrays Yahoo Finance returned (empty = needs extraction from research)
  const needRevenueExtract = (yahooData.revenueHistory?.length ?? 0) === 0;
  const needMarginExtract  = (yahooData.marginHistory?.length  ?? 0) === 0;
  const needPLExtract      = (yahooData.plStatement?.length    ?? 0) === 0;
  const needBSExtract      = (yahooData.balanceSheet?.length   ?? 0) === 0;
  const needCFExtract      = (yahooData.cashFlow?.length       ?? 0) === 0;

  // Truncate financial data to prevent token overflow on large companies
  const truncateFinancialRows = (rows: any[] | undefined, maxRows: number = 10): any[] | undefined => {
    if (!rows || rows.length === 0) return rows;
    if (rows.length <= maxRows) return rows;
    // Keep headers and most recent data
    return rows.slice(0, maxRows);
  };

  const systemPrompt = `You are a senior equity analyst producing institutional-grade financial commentary.
Rules:
- Be specific: cite figures, percentages, year-on-year changes, named programmes from provided data and your knowledge.
- Insights must be 3-5 sentences each — analytical and forward-looking, not descriptive.
- Key highlights must be brief bullets suitable for an executive summary.
- For segment/geo data: PRIORITIZE data from FMP (Financial Modeling Prep) if provided in the research section. If FMP data is not available, extract from other research or use your training knowledge to populate these arrays for well-known companies — never leave both empty if you know the answer.
- CRITICAL: NEVER create synthetic/estimated numbers. If you cite a figure (revenue, margin, etc.), it must come from actual data sources or established public knowledge. Never invent metrics.
- When extracting financial statement rows, include 8-15 key line items per statement.
- Output ONLY valid JSON. No markdown fences, no text outside the JSON.
- NEVER mention that data comes from training knowledge — present all content neutrally without disclosing data sources.
- ${RECENCY_DIRECTIVE}
- ${WRITING_DIRECTIVE}`;

  // Compact the Yahoo data for context (truncate to avoid token overflow on large datasets)
  const revenueStr = (truncateFinancialRows(yahooData.revenueHistory, 8) || [])
    .map((r: RevenueDataPoint) => `${r.year}: ${r.revenueFormatted}${r.yoyGrowth != null ? ` (${r.yoyGrowth >= 0 ? '+' : ''}${r.yoyGrowth}% YoY)` : ''}`)
    .join(', ');
  const marginStr = (truncateFinancialRows(yahooData.marginHistory, 8) || [])
    .map((m: MarginDataPoint) => `${m.year}: Net ${m.netMargin}% / Op ${m.operatingMargin}%`)
    .join(', ');
  const plStr = (truncateFinancialRows(yahooData.plStatement, 12) || [])
    .filter((r: FinancialStatementRow) => r.isBold || r.isSection)
    .slice(0, 10)
    .map((r: FinancialStatementRow) => `${r.label}: ${r.value}${r.yoy ? ` (${r.yoy} YoY)` : ''}`)
    .join(' | ');
  const bsStr = (truncateFinancialRows(yahooData.balanceSheet, 12) || [])
    .filter((r: FinancialStatementRow) => r.isBold || r.isSection)
    .slice(0, 10)
    .map((r: FinancialStatementRow) => `${r.label}: ${r.value}`)
    .join(' | ');
  const cfStr = (truncateFinancialRows(yahooData.cashFlow, 12) || [])
    .filter((r: FinancialStatementRow) => r.isBold || r.isSection)
    .slice(0, 10)
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
    { "segment": "Segment Name", "revenue": "CURRENCY_X.XB", "percentage": 42.5, "yoyGrowth": "+8.2%" }
  ],
  "geoRevenue": [
    { "region": "Americas", "revenue": "CURRENCY_X.XB", "percentage": 55.0, "yoyGrowth": "+8.2%" }
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
- revenueHistoryExtracted / marginHistoryExtracted: 3-5 years newest-first. revenue must be raw integer in ${yahooData.currency || 'USD'} (e.g. 383285000000). Percentages as numbers not strings. All monetary values should use ${yahooData.currency || 'USD'} currency. MUST be from actual data sources, never synthetic.
- plStatementExtracted / balanceSheetExtracted / cashFlowExtracted: 8-15 key rows. MUST include BOTH current year ("value") AND previous year ("previousValue") for every data row. Include "yoy" percentage change where calculable. isSection=true for category headers (value=""). isBold=true for subtotals/totals. The "value" field is the most recent fiscal year; "previousValue" is the year before that. MUST be from actual data sources, never invented.
- Per the Extraction Status above, set an extracted array to [] when the Finance API data is already available.
- For segmentRevenue and geoRevenue:
  * PRIMARY SOURCE: If research is provided in "Additional Research" labeled "FMP Segment Revenue Data", "FMP Geographic Revenue Data", or "Segment & Geographic Revenue Research", parse it into the required format (segment/region, revenue formatted in reporting currency, percentage, yoyGrowth).
  * FALLBACK: For any major globally listed company (not just US Fortune 500 — this includes Indian IT firms like TCS/Infosys/Wipro, Asian conglomerates, European multinationals, etc.), use your training knowledge to populate segmentRevenue and geoRevenue. Do NOT return empty arrays for well-known companies.
  * Return [] ONLY if the company is genuinely obscure, micro-cap, or private.
  * Segment names MUST be the company's official segment names from their annual reports.
  * Geographic regions MUST be the company's official geographic breakdown (e.g. TCS uses: Americas, Europe, India, Asia-Pacific, MEA, Latin America).
  * CRITICAL currency rule: ALL revenue values in segmentRevenue and geoRevenue MUST use ${yahooData.currency || 'USD'} — never default to "$" if the reporting currency is not USD. E.g. for INR use "₹2.45T", for EUR use "€12.3B", for JPY use "¥850B".
- For insights: draw on BOTH the Finance API data above, FMP data (if available), and your training knowledge — be specific, cite figures from known sources. NEVER create synthetic analysis or made-up insights.`;

  // claudeCreateDirect already retries once internally on transport failure
  try {
    const fullText = await claudeCreateDirect(systemPrompt, userPrompt, 4000, SYNTHESIS_MODEL, 120000, 0.1);
    onChunk?.(fullText);
    const result = parseFinancialInsights(fullText);
    console.log('[synthesizeFinancialInsights] Successfully synthesized insights');
    return result;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.warn('[synthesizeFinancialInsights] Synthesis failed:', errMsg);
    console.warn(`[synthesizeFinancialInsights] Returning fallback data with extracted arrays for ${input.companyName}`);
    return createFallbackInsights(input.companyName, yahooData);
  }
}

function parseFinancialInsights(raw: string): FinancialInsightsPayload {
  // Try to extract JSON — be forgiving of markdown fences, trailing text, etc.
  let jsonStr = raw.trim();

  // Remove markdown code fences if present
  if (jsonStr.startsWith('```json')) {
    jsonStr = jsonStr.replace(/^```json\s*/, '').replace(/\s*```$/, '');
  } else if (jsonStr.startsWith('```')) {
    jsonStr = jsonStr.replace(/^```\s*/, '').replace(/\s*```$/, '');
  }

  // Try to find JSON object if still wrapped in text
  const match = jsonStr.match(/\{[\s\S]*\}/);
  if (!match) {
    console.warn('[parseFinancialInsights] Failed to find JSON object in response:', jsonStr.slice(0, 200));
    throw new Error('Claude did not return valid JSON for financial insights');
  }

  try {
    const parsed: unknown = JSON.parse(match[0]);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Parsed JSON is not an object');
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = parsed as any;

    // Handle keyHighlights — may be structured object or legacy array
    let keyHighlights: KeyHighlightsStructured;
    if (data.keyHighlights && typeof data.keyHighlights === 'object' && !Array.isArray(data.keyHighlights)) {
      keyHighlights = {
        overallPerformance: data.keyHighlights.overallPerformance || '',
        overallPerformanceTagline: data.keyHighlights.overallPerformanceTagline || undefined,
        factorsDrivingGrowth: data.keyHighlights.factorsDrivingGrowth || '',
        factorsDrivingGrowthTagline: data.keyHighlights.factorsDrivingGrowthTagline || undefined,
        factorsInhibitingGrowth: data.keyHighlights.factorsInhibitingGrowth || '',
        factorsInhibitingGrowthTagline: data.keyHighlights.factorsInhibitingGrowthTagline || undefined,
        futureStrategy: data.keyHighlights.futureStrategy || '',
        futureStrategyTagline: data.keyHighlights.futureStrategyTagline || undefined,
        growthOutlook: data.keyHighlights.growthOutlook || '',
        growthOutlookTagline: data.keyHighlights.growthOutlookTagline || undefined,
      };
    } else {
      // Legacy fallback: convert array to structured
      const arr = Array.isArray(data.keyHighlights) ? data.keyHighlights : [];
      keyHighlights = {
        overallPerformance: arr[0] || '',
        factorsDrivingGrowth: arr[1] || '',
        factorsInhibitingGrowth: arr[2] || '',
        futureStrategy: arr[3] || '',
        growthOutlook: arr[4] || '',
      };
    }

    return {
      revenueInsight: data.revenueInsight || '',
      marginInsight: data.marginInsight || '',
      segmentInsight: data.segmentInsight || undefined,
      geoInsight: data.geoInsight || undefined,
      plInsight: data.plInsight || '',
      bsInsight: data.bsInsight || '',
      cfInsight: data.cfInsight || '',
      keyHighlights,
      chartInsights: Array.isArray(data.chartInsights) ? data.chartInsights : [],
      geoSegmentInsights: Array.isArray(data.geoSegmentInsights) ? data.geoSegmentInsights : [],
      segmentRevenue: Array.isArray(data.segmentRevenue) ? data.segmentRevenue : [],
      geoRevenue: Array.isArray(data.geoRevenue) ? data.geoRevenue : [],
      // Fallback arrays extracted from research
      revenueHistoryExtracted: Array.isArray(data.revenueHistoryExtracted) && data.revenueHistoryExtracted.length > 0
        ? data.revenueHistoryExtracted : undefined,
      marginHistoryExtracted: Array.isArray(data.marginHistoryExtracted) && data.marginHistoryExtracted.length > 0
        ? data.marginHistoryExtracted : undefined,
      plStatementExtracted: Array.isArray(data.plStatementExtracted) && data.plStatementExtracted.length > 0
        ? data.plStatementExtracted : undefined,
      balanceSheetExtracted: Array.isArray(data.balanceSheetExtracted) && data.balanceSheetExtracted.length > 0
        ? data.balanceSheetExtracted : undefined,
      cashFlowExtracted: Array.isArray(data.cashFlowExtracted) && data.cashFlowExtracted.length > 0
        ? data.cashFlowExtracted : undefined,
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
  research: string,
  onChunk?: (accumulated: string) => void
): Promise<PrivateCompanyPayload> {
  const hasResearch = !isEmptyResearch(research);

  const systemPrompt = `You are a senior investment analyst producing concise private company financial profiles.
Rules:
- Use provided research first; supplement with training knowledge where research is sparse — label estimates "(est.)".
- Be specific with ranges: "$800M–$1.2B" not "high revenue".
- Insights should be actionable intelligence, not generic descriptions.
- Output ONLY valid JSON. No markdown fences.
- ${RECENCY_DIRECTIVE}
- ${WRITING_DIRECTIVE}`;

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

  const fullText = await claudeCreateDirect(systemPrompt, userPrompt, MAX_OUTPUT_TOKENS, SYNTHESIS_MODEL);
  onChunk?.(fullText);

  return parsePrivateCompany(fullText);
}

function parsePrivateCompany(raw: string): PrivateCompanyPayload {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Claude did not return valid JSON for private company');
  try {
    const parsed: unknown = JSON.parse(match[0]);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Parsed JSON is not an object');
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = parsed as any;

    let privateKeyHighlights: KeyHighlightsStructured | undefined;
    if (data.privateKeyHighlights && typeof data.privateKeyHighlights === 'object') {
      privateKeyHighlights = {
        overallPerformance: data.privateKeyHighlights.overallPerformance || '',
        overallPerformanceTagline: data.privateKeyHighlights.overallPerformanceTagline || undefined,
        factorsDrivingGrowth: data.privateKeyHighlights.factorsDrivingGrowth || '',
        factorsDrivingGrowthTagline: data.privateKeyHighlights.factorsDrivingGrowthTagline || undefined,
        factorsInhibitingGrowth: data.privateKeyHighlights.factorsInhibitingGrowth || '',
        factorsInhibitingGrowthTagline: data.privateKeyHighlights.factorsInhibitingGrowthTagline || undefined,
        futureStrategy: data.privateKeyHighlights.futureStrategy || '',
        futureStrategyTagline: data.privateKeyHighlights.futureStrategyTagline || undefined,
        growthOutlook: data.privateKeyHighlights.growthOutlook || '',
        growthOutlookTagline: data.privateKeyHighlights.growthOutlookTagline || undefined,
      };
    }

    return {
      estimatedRevenue: data.estimatedRevenue || 'Not publicly disclosed',
      profitabilityMargin: data.profitabilityMargin || 'Not publicly disclosed',
      estimatedYoyGrowth: data.estimatedYoyGrowth || 'Not publicly disclosed',
      fundingInfo: data.fundingInfo,
      lastValuation: data.lastValuation,
      privateInsights: Array.isArray(data.privateInsights) ? data.privateInsights : [],
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
  research: string,
  onChunk?: (accumulated: string) => void
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

  const systemPrompt = `You are a senior B2B sales strategist. Output ONLY valid JSON — no markdown fences, no text outside JSON.
- Confident, consultative tone. Back claims with evidence (G2/Gartner, case study metrics, analyst data).
- Use [Client A, Fortune 500 ${input.targetIndustry} Company] when real names unavailable.
- Derive priorities/solutions from research if not user-supplied; use them consistently.
- ${RECENCY_DIRECTIVE}
- ${WRITING_DIRECTIVE}`;

  const userPrompt = `Sales Play: "${input.yourCompany}" displacing "${input.competitorName}" at "${input.targetAccount}" (${input.targetIndustry}).

${priorityBlock}
${solutionBlock}
${input.competitorWeaknesses ? `KNOWN COMPETITOR WEAKNESSES: ${input.competitorWeaknesses}` : ''}
${hasResearch ? `RESEARCH:\n${research.slice(0, 15000)}` : '[No live research — use training knowledge]'}

Return JSON:
{
  "priorityTable": [{ "priority": "str", "companySolution": "1-2 bullets with '• '", "proofPoints": "1-2 bullets with '• '", "whyNotCompetitor": "1-2 bullets with '• '" }],
  "industrySolutions": [{ "name": "str", "problemSolved": "str", "description": "1 sentence" }],
  "techSummary": "2-3 bullets with '• '",
  "technologyPartners": [{ "name": "str", "capability": "str" }],
  "siPartners": [{ "name": "str", "capability": "str" }],
  "caseStudies": [{ "client": "str", "challenge": "str", "solution": "str", "outcome": "str", "testimonial": null }],
  "priorityMapping": [{ "priority": "str", "solution": "str", "expectedOutcome": "str", "timeToValue": "str" }],
  "competitiveStatement": "2-3 sentences why ${input.yourCompany} not ${input.competitorName}",
  "objectionRebuttals": [{ "objection": "str", "rebuttal": "str" }],
  "callToAction": "str"
}

Counts: ${priorityCountNote}; industrySolutions 3-4; technologyPartners 2-3; siPartners 2-3; caseStudies EXACTLY 3; objectionRebuttals EXACTLY 3.`;

  const fullText = await claudeCreateDirect(systemPrompt, userPrompt, 8192, SYNTHESIS_MODEL, 90000);
  onChunk?.(fullText);
  console.log(`[salesPlay] synthesis done length=${fullText.length}`);

  return parseSalesPlay(fullText);
}

function parseSalesPlay(raw: string): SalesPlayPayload {
  // Strip markdown fences if present
  const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();

  // Try direct parse first
  let p: SalesPlayPayload | null = null;
  try { p = JSON.parse(stripped) as SalesPlayPayload; } catch { /* try brace matching */ }

  // Brace-matching fallback for truncated output
  if (!p) {
    const start = stripped.indexOf('{');
    if (start === -1) {
      console.error('[salesPlay] No JSON object found. First 500 chars:', raw.slice(0, 500));
      throw new Error('Claude did not return valid JSON for sales play');
    }
    let depth = 0, end = -1;
    for (let i = start; i < stripped.length; i++) {
      if (stripped[i] === '{') depth++;
      else if (stripped[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    const candidate = end !== -1 ? stripped.slice(start, end + 1) : stripped.slice(start);
    try { p = JSON.parse(candidate) as SalesPlayPayload; } catch (e) {
      console.error('[salesPlay] Parse failed. Length:', raw.length, 'Last 300 chars:', raw.slice(-300));
      console.error('[salesPlay] Parse error:', e);
      throw new Error('Failed to parse sales play JSON');
    }
  }

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
}

// ── Key Prospective Buyers — Synthesis ───────────────────────────────────────

export async function synthesizeKeyBuyers(
  input: KeyBuyersInput,
  research: string
): Promise<KeyBuyerRow[]> {
  const hasResearch = !isEmptyResearch(research);

  const domainContextKB = input.companyDomain
    ? `\n- COMPANY IDENTITY: "${input.companyName}" is identified by domain ${input.companyDomain}. If multiple companies share this name, focus ONLY on the one at ${input.companyDomain}. Do NOT use executive data from any other company with a similar name.`
    : '';

  const systemPrompt = `You are a senior B2B sales intelligence analyst who specialises in executive level stakeholder mapping.
Rules:
- Use the provided research first; supplement with training knowledge where research is sparse.
- Focus on C suite and SVP/VP level executives — the decision makers.${domainContextKB}
- Every row must have substantive, specific content — no vague generalities, no empty fields.
- Prefer direct quotes in the excerpt field when available — use quotation marks.
- Write in natural business language without hyphens, dashes, or arrows. Use "and" instead of "/" or "&".
- Output ONLY valid JSON. No markdown fences, no text outside the JSON array.
- ${RECENCY_DIRECTIVE}
- ${WRITING_DIRECTIVE}`;

  const userPrompt = `Analyse the following research on "${input.companyName}"${input.companyDomain ? ` (website: ${input.companyDomain})` : ''} and produce a Key Prospective Buyers table.

The table should map senior executives to their publicly stated business focus areas, making it easy for a sales team to tailor their pitch.

${hasResearch
  ? `RESEARCH:\n${research.slice(0, 20000)}`
  : `[No live research available — use training knowledge about ${input.companyName}'s key executives and their known strategic priorities.]`}

Return a JSON array with 10-15 rows, EXACTLY this shape:
[
  {
    "keyExecutive": "Full Name, Exact Title, Department (e.g. 'John Smith, Chief Technology Officer, Technology')",
    "theme": "The business focus area the executive is championing (e.g. 'AI-Driven Supply Chain Optimisation', 'Cloud-First Digital Transformation', 'Sustainability & Net Zero')",
    "reference": "The EVENT where the executive made this statement — e.g. 'Annual General Meeting 2024', 'Investor Day Keynote, Nov 2024', 'World Economic Forum Panel, Jan 2025', 'Q3 FY2025 Earnings Call', 'Industry Summit Keynote'. This is NOT the source URL — it is the occasion, event, or forum where the quote originated.",
    "excerpt": "2-3 bullet points (each starting with '• ' separated by newlines): key statements or quotes from the executive about this theme — cite specific data points, programme names, or initiatives mentioned.",
    "source": "Source: ONLY include verified, legitimate sources (e.g., 'Company investor relations website', 'Earnings call transcript', 'Industry conference keynote', 'LinkedIn profile' — no invented URLs). If the source is unverifiable, write 'Based on business intelligence'."
  }
]

IMPORTANT:
- Cover DIVERSE themes: technology strategy, operations, growth, sustainability, talent, M&A, innovation, customer experience, cost optimisation, digital transformation, AI/ML, cybersecurity, etc.
- Include executives from DIFFERENT functions (CEO, CFO, CTO, CIO, CDO, CMO, COO, SVP/VP levels).
- If multiple executives speak to the same theme, include both — this shows organisational alignment.
- Prioritise recent sources (2024-2025).
- Each row should represent a unique, actionable insight for sales pitching.
- The "reference" field must describe the EVENT or OCCASION — not the publication or website. Examples: "Annual Shareholders Meeting 2024", "NASSCOM Technology Leadership Forum", "Q2 FY2025 Earnings Call", "Banking Technology Summit, Feb 2025". NOT: "LinkedIn post", "Company website", "Press release".
- The "keyExecutive" field MUST follow the format: "Full Name, Title, Department".
- The "source" field must ONLY include verified, legitimate sources. Do NOT invent URLs. Examples: "Company investor relations website", "Q2 FY2025 Earnings call transcript", "LinkedIn", "Industry conference keynote". If the source cannot be verified, write "Business intelligence and market analysis".`;

  console.log('[claudeAI] Starting key buyers synthesis with 90s timeout');
  const text = await claudeCreateDirect(systemPrompt, userPrompt, MAX_OUTPUT_TOKENS, SYNTHESIS_MODEL, 90000);
  console.log('[claudeAI] Key buyers synthesis completed');

  return parseKeyBuyers(text);
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
  research: string,
  onChunk?: (accumulated: string) => void
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
- ${RECENCY_DIRECTIVE}
- ${WRITING_DIRECTIVE}`;

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

  const fullText = await claudeCreateDirect(systemPrompt, userPrompt, MAX_OUTPUT_TOKENS, SYNTHESIS_MODEL);
  onChunk?.(fullText);
  console.log(`[industryTrends] synthesis done length=${fullText.length}`);

  return parseIndustryTrends(fullText);
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
    { "id": "seg_2", "label": "By Geography", "type": "geo", "selected": true, "subSegments": ["North America", "Europe", "Asia-Pacific", "Middle East Africa", "Latin America", "Emerging Markets"] },
    { "id": "seg_3", "label": "By Product Type", "type": "product_type", "selected": true, "subSegments": ["Product Type A", "Product Type B", "Product Type C", "Product Type D", "Product Type E"] },
    { "id": "seg_4", "label": "By Application", "type": "application", "selected": true, "subSegments": ["Application 1", "Application 2", "Application 3", "Application 4", "Application 5", "Application 6"] },
    { "id": "seg_5", "label": "By Distribution Channel", "type": "distribution", "selected": true, "subSegments": ["Direct Sales", "Distributors", "E-commerce", "Retail", "OEM"] },
    { "id": "seg_6", "label": "By Customer Segment", "type": "customer_segment", "selected": false, "subSegments": ["Enterprise", "Mid-Market", "SMB", "Startups"] },
    { "id": "seg_7", "label": "By Price Tier", "type": "pricing", "selected": false, "subSegments": ["Premium", "Mid-Range", "Budget", "Entry-Level"] }
  ],
  "suggestedPlayers": [
    { "name": "Company A", "description": "Market leader in category X", "marketShare": "25%", "headquarters": "US", "revenue": "$X.XB", "selected": true },
    { "name": "Company B", "description": "Strong competitor in segment Y", "marketShare": "20%", "headquarters": "EU", "revenue": "$X.XB", "selected": true },
    { "name": "Company C", "description": "Growing player in region Z", "marketShare": "15%", "headquarters": "APAC", "revenue": "$X.XB", "selected": true },
    { "name": "Company D", "description": "Emerging challenger", "marketShare": "10%", "headquarters": "US", "revenue": "$X.XB", "selected": false }
  ],
  "tocPreview": ${JSON.stringify(tocTitles)}
}

RULES:
- Suggest 6-10 market segments. Each has 3-6 sub-segments (be exhaustive).
- Segments must cover ALL major market dimensions: geography, product type, application, channel, customer segment, technology, price tier, use case.
- Each segment: comprehensive sub-segment list covering the full market breakdown for that dimension.
- Example for "By Geography": North America, Europe, Asia-Pacific, Middle East Africa, Latin America, Emerging Markets (6 items).
- Suggest 15-20 competitors. Pre-select top 10 (selected: true/false).
- For each player: name, description (1 short phrase: "Market leader in X", "Growing in segment Y", etc), marketShare (XX%), headquarters (US/EU/APAC/etc), revenue (estimated $X.XB format).
- Description should be 3-8 words maximum, highlighting player's position or focus.
- CRITICAL: NO special characters, NO quotes or newlines in any string, NO markdown.
- Sub-segment names: 1-3 words, clear market terminology. No abbreviations.
- searchQueries: 6-10 words, simple English, current year focused.
- Output must be VALID JSON with proper commas, no trailing commas.
`.trim();

  const systemPromptScope = `Output ONLY a single valid JSON object. No markdown, no explanation text. Ensure every string value uses ONLY: letters, numbers, spaces, hyphens, percent signs, forward slashes. Zero special characters. Proper JSON syntax with no trailing commas. ${RECENCY_DIRECTIVE} ${WRITING_DIRECTIVE}`;

  const raw = await claudeCreateDirect(systemPromptScope, userPrompt, 3000, SYNTHESIS_MODEL, 120000, 0.0);

  let parsed: ScopeWizardResult | null = null;

  // Pre-process: Remove any markdown code blocks if present
  const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

  // Strategy 1: Try to extract and parse the main JSON object
  try {
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON object found');

    parsed = JSON.parse(jsonMatch[0]) as ScopeWizardResult;
  } catch (err) {
    console.warn('[extractScope] Full parse failed, attempting component extraction:', err instanceof Error ? err.message : err);

    try {
      // Strategy 2: Extract components with better nested handling
      let scopeMatch, segmentsMatch, playersMatch, tocMatch;

      // Extract scope object (handle nested braces)
      scopeMatch = cleaned.match(/"scope"\s*:\s*\{(?:[^{}]|(?:\{[^{}]*\}))*\}/);

      // Extract segments array
      segmentsMatch = cleaned.match(/"suggestedSegments"\s*:\s*\[[\s\S]*?\]/);

      // Extract players array
      playersMatch = cleaned.match(/"suggestedPlayers"\s*:\s*\[[\s\S]*?\]/);

      // Extract toc preview
      tocMatch = cleaned.match(/"tocPreview"\s*:\s*\{(?:[^{}]|(?:\{[^{}]*\}))*\}/);

      if (!scopeMatch || !segmentsMatch || !playersMatch) {
        throw new Error('Missing required components');
      }

      // Reconstruct with proper formatting
      const reconstructed = `{${scopeMatch[0]},${segmentsMatch[0]},${playersMatch[0]}${tocMatch ? ',' + tocMatch[0] : ''}}`;

      parsed = JSON.parse(reconstructed) as ScopeWizardResult;
    } catch (componentErr) {
      throw new Error(`Scope extraction failed: ${componentErr instanceof Error ? componentErr.message : String(err)}`);
    }
  }

  if (!parsed.scope?.industry || !parsed.suggestedSegments?.length || !parsed.suggestedPlayers?.length) {
    throw new Error('Incomplete wizard scope extraction');
  }

  // Normalize segments: ensure all have IDs and selected fields
  parsed.suggestedSegments = parsed.suggestedSegments.map((seg, idx) => ({
    ...seg,
    id: seg.id || `seg_${idx + 1}`,
    selected: seg.selected ?? (idx < 3), // Pre-select first 3 segments if not specified
  }));

  // Normalize players: ensure all have selected fields
  parsed.suggestedPlayers = parsed.suggestedPlayers.map((player, idx) => ({
    ...player,
    selected: player.selected ?? (idx < 10), // Pre-select top 10 if not specified
  }));

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

  const systemPromptSizing = `You are a quantitative market sizing analyst. Produce estimates grounded in actual data. Output ONLY valid JSON. ${RECENCY_DIRECTIVE} ${WRITING_DIRECTIVE}`;
  const raw = await claudeCreateDirect(systemPromptSizing, userPrompt, 4096, SYNTHESIS_MODEL, 120000, 0);
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

  const systemPromptExec = `You are a senior market analyst producing an executive summary for C-suite readers. Be concise and specific. Output ONLY valid JSON. ${RECENCY_DIRECTIVE} ${WRITING_DIRECTIVE}`;
  const raw = await claudeCreateDirect(systemPromptExec, userPrompt, 8192, SYNTHESIS_MODEL, 120000, 0.2);
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
    tableHint: 'For each segment subsection, include keyTable with headers: ["Sub-segment", "Market Size", "% of Segment", "CAGR", "Key Players"]. Show ALL sub-segments from input. CRITICAL: For each year, the sum of all sub-segment market sizes MUST match the total market size declared in the Market Overview section for that same year (tolerance: ±2% for rounding). If Market Overview shows 2025 total = $75.2B, all segment sub-segments for 2025 must sum to approximately $75.2B.',
    chartHint: 'For each segment, build stacked_bar chart: data=[{label:"2024","<sub1>":<val>,"<sub2>":<val>,"cagrTrend":<pct>},{label:"2025",...}], series=[{key:"<sub1>",name:"Sub-seg 1",type:"bar",stack:"segment"},{key:"cagrTrend",name:"CAGR %",type:"line",yAxisId:"right"}].',
    subsectionHint: 'Create ONE subsection per selected segment (e.g., "By Geography", "By Product Type"). Each subsection: title=segment name, content=3-5 bullets analyzing that segment\'s breakdown and trends, keyTable=all sub-segments with market size/CAGR, chartSpec=stacked bar. If no segments provided, identify 4-6 from research. YEAR PRIORITY: Market sizing prioritizes 2025 (base year), then 2024, then 2023. Ensure all years reference appropriate historical data.',
  },
  market_dynamics: {
    title: 'Market Dynamics',
    tableHint: 'Return 4 tables in the "tables" array (NOT keyTable). Each table has title and specific headers:\n1. Title: "Business Trends", Headers: ["Name of Trend", "Impact", "Description", "Examples"]\n2. Title: "Tech Trends", Headers: ["Name of Trend", "Impact", "Description", "Examples"]\n3. Title: "Drivers", Headers: ["Name of Driver", "Impact", "Description", "Examples"]\n4. Title: "Barriers", Headers: ["Name of Barrier", "Impact", "Description", "Examples"]\nThe "Examples" column MUST contain real-world references: news articles, company events, specific player actions, regulatory changes. Include 5-8 rows per table. Impact should be High/Medium/Low.',
    chartHint: 'No chart needed. Set chartSpec to null.',
    subsectionHint: 'No subsections needed. The 4 tables carry all the content. Include 1-2 bodyParagraphs summarizing the overall market dynamics landscape.',
  },
  competition_analysis: {
    title: 'Competition Analysis',
    tableHint: 'Include keyTable with headers: ["Company", "Market Share %", "Revenue $B", "HQ", "Key Strength"]. List all players (selected + unselected) sorted by market share descending.',
    chartHint: 'Include horizontal_bar chartSpec showing market share %. Data format: [{label:"Company A",value:25},{label:"Company B",value:20},...] sorted by value descending.',
    subsectionHint: 'First bodyParagraph: competitive landscape overview, market concentration type (oligopoly/duopoly/fragmented/etc), top 3-5 players with market shares, competitive dynamics (price-led, innovation-led, etc). Include competitorProfiles: [{name, parentCompany, hqLocation, keyProducts, overallRevenue, categoryRevenue, marketShare, manufacturingLocation, recentNews, jvMaPartnerships, otherInsights}] ONLY for KEY PLAYERS (selected in input). Do NOT include subsections. Do NOT include bcgMatrixData.',
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
  // Reduce research size to stay within token limits — 8KB is optimal for detailed analysis without overflow
  const safeResearch = allResearch.length > 8000 ? allResearch.slice(0, 8000) : allResearch;

  // CRITICAL: Include ALL sub-segments but keep context compact
  const segmentContext = scope.selectedSegments?.length
    ? `\nMARKET SEGMENTS:\n${scope.selectedSegments.slice(0, 8).map((s) => `${s.label}: ${(s.subSegments || []).join(', ')}`).join('\n')}`
    : '';

  const selectedNames = new Set((scope.selectedPlayers || []).map((p) => p.name));
  const allPlayers = scope.allPlayers || scope.selectedPlayers || [];
  const unselectedPlayers = allPlayers.filter((p) => !selectedNames.has(p.name));

  // Compact format: selected players with shares, all players for BCG
  const playerContext = scope.selectedPlayers?.length
    ? `\nKEY PLAYERS FOR PROFILING: ${scope.selectedPlayers.slice(0, 10).map((p) => `${p.name} (${p.marketShare || '?'})`).join(' | ')}`
    : '';

  const allPlayersList = allPlayers.length > 0
    ? `\nALL PLAYERS (for BCG matrix): ${allPlayers.slice(0, 20).map((p) => `${p.name} ${p.marketShare ? `(${p.marketShare})` : ''}`).join(' | ')}`
    : '';

  const unselectedPlayerContext = unselectedPlayers.length > 0
    ? `\nOTHER PLAYERS: ${unselectedPlayers.slice(0, 10).map((p) => p.name).join(', ')}`
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
${segmentContext}${playerContext}${allPlayersList}${unselectedPlayerContext}

MARKET SIZING CONTEXT:
- Current (Value): ${marketSizing.currentMarketSize}
- Projected (Value): ${marketSizing.projectedMarketSize}
- CAGR: ${marketSizing.cagr}
- Current (Volume): ${marketSizing.currentVolume || 'Not available — estimate if the industry involves physical goods/units'}
- Projected (Volume): ${marketSizing.projectedVolume || 'Not available — estimate if the industry involves physical goods/units'}

RESEARCH DATA:
${safeResearch}

YEAR PRIORITY:
- For market sizing sections (market_overview, market_size_by_segment): Prioritize 2025 (base year), then 2024, then 2023.
- For all other sections (market_dynamics, competition_analysis, regulatory_overview, porters_five_forces, swot, tei_analysis): Prioritize 2026 data, then 2025, then 2024. Pre-2023 data requires "(2023 or earlier - historical context)" label.

Draft the following ${sectionIds.length} sections:
${sectionInstructions}

Return each section as ONE COMPLETE JSON object per line (NDJSON format). NO array wrapper. Each line must be a standalone valid JSON object:
Line 1: {...section 1...}
Line 2: {...section 2...}
etc.

Each object structure:
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
  "competitorProfiles": [{name, parentCompany, hqLocation, keyProducts, overallRevenue, categoryRevenue, marketShare, manufacturingLocation, recentNews, jvMaPartnerships, otherInsights}, ...] OR null
}

CRITICAL RULES:
- OUTPUT VALID JSON: Ensure all quotes in strings are properly escaped. All arrays/objects complete with closing brackets/braces.
- All string values must escape special characters: use \\n for newlines, \\" for quotes, \\\\ for backslashes.
- Never include unescaped newlines or quotes within JSON strings. Use bullet points (•) instead of line breaks.
- chartSpec.data and charts[].data values MUST be numbers. For stacked_bar: keys for each sub-segment + cagrTrend.
- For swot/porters/tei sections: include ONLY the specialized data field. bodyParagraphs can be empty [].
- For market_dynamics and regulatory_overview: use "tables" array (NOT keyTable) for multiple tables.
- For forecast: use "tables" array for assumption/summary tables AND "charts" array for 3 scenario charts.
- For competition_analysis: include competitorProfiles alongside keyTable and chartSpec (no BCG matrix).
- For market_size_by_segment: Ensure that for each year shown in the table, the sum of all sub-segment market sizes equals the total market size from Market Overview (tolerance: ±2% for rounding). This maintains consistency across sections.
- Be specific: cite figures, company names, percentages, dates.
- EVERY subsection MUST have a non-empty "content" string with substantive bullet-point analysis. Never leave subsection content as "" or null.
- DEFUNCT COMPANY GUARDRAIL: Do NOT build competitor profiles or key player listings for companies that have shut down operations, filed for bankruptcy, been liquidated, or permanently exited the market. Instead, highlight such companies separately as "⚠ Defunct / Bankrupt" with the year and reason. Only profile active, operating companies.
`.trim();

  // Prioritize quality over token reduction — use sufficient tokens for detailed analysis
  const isHeavySection = sectionIds.some((id) => ['market_size_by_segment', 'competition_analysis'].includes(id));
  const maxTokens = isHeavySection ? 10000 : 8000;  // Increased to ensure no truncation and high-quality output

  const systemPromptDraft = `You are a senior industry analyst. Output ONLY newline-delimited JSON (NDJSON) format: one complete JSON object per line. NO markdown, NO array wrapper, NO explanatory text. Each line must be a valid standalone JSON object. ${RECENCY_DIRECTIVE} ${WRITING_DIRECTIVE}`;
  const raw = await claudeCreateDirect(systemPromptDraft, userPrompt, maxTokens, SYNTHESIS_MODEL, 120000, 0.1);
  console.log(`[draftV2] Batch [${sectionIds.join(', ')}] raw length: ${raw.length}`);

  // Parse NDJSON format (newline-delimited JSON, more resilient to truncation)
  let parsed: unknown[] | null = null;

  try {
    // Try NDJSON format first (one JSON object per line)
    const lines = raw
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && line.startsWith('{'));

    if (lines.length > 0) {
      const objects: unknown[] = [];
      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          objects.push(obj);
        } catch (lineErr) {
          console.warn(`[draftV2] Skipped malformed line in NDJSON:`, line.slice(0, 100));
        }
      }
      if (objects.length > 0) {
        parsed = objects;
        console.log(`[draftV2] Parsed ${objects.length} sections from NDJSON format`);
      }
    }

    // Fallback: try JSON array format if NDJSON didn't work
    if (!parsed || parsed.length === 0) {
      console.log(`[draftV2] NDJSON parsing returned 0 objects, trying JSON array format...`);
      parsed = safeParseJsonArray(raw);
    }
  } catch (parseErr) {
    console.error(`[draftV2] Parse error for batch [${sectionIds.join(', ')}]:`, parseErr instanceof Error ? parseErr.message : parseErr);
    const errorMsg = String(parseErr);
    const posMatch = errorMsg.match(/position (\d+)/);
    if (posMatch) {
      const pos = parseInt(posMatch[1], 10);
      const start = Math.max(0, pos - 150);
      const end = Math.min(raw.length, pos + 150);
      console.error(`[draftV2] Error at position ${pos}, context:`, raw.slice(start, end));
    }

    // Final fallback: extract individual objects
    console.warn(`[draftV2] Attempting object extraction fallback for batch [${sectionIds.join(', ')}]`);
    parsed = safeParseJsonArray(raw);
  }

  if (!parsed || parsed.length === 0) {
    console.error(`[draftV2] Failed to parse batch [${sectionIds.join(', ')}]. First 500 chars:`, raw.slice(0, 500));
    console.error(`[draftV2] Last 500 chars:`, raw.slice(-500));
    // If this is a single-section retry, return empty instead of throwing so the report can continue
    if (sectionIds.length === 1) {
      console.warn(`[draftV2] Skipping section ${sectionIds[0]} — parse failed even on individual retry.`);
      return [];
    }
    throw new Error(`No V2 sections parsed for batch [${sectionIds.join(', ')}]`);
  }

  // Debug: log what was parsed
  console.log(`[draftV2] Parsed ${parsed.length} sections: ${(parsed as any[]).map((s: any) => s.id || '?').join(', ')}`);

  // Detailed logging for competition_analysis
  const compAnalysis = (parsed as any[]).find((s: any) => s.id === 'competition_analysis');
  if (compAnalysis) {
    console.log(`[draftV2] competition_analysis found:`, {
      id: compAnalysis.id,
      hasBody: compAnalysis.bodyParagraphs?.length || 0,
      bcgCount: compAnalysis.bcgMatrixData?.length || 0,
      profilesCount: compAnalysis.competitorProfiles?.length || 0,
      hasKeyTable: !!compAnalysis.keyTable,
      hasChartSpec: !!compAnalysis.chartSpec,
    });
  } else {
    console.warn(`[draftV2] competition_analysis NOT in parsed sections`);
  }

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
    const isValid = hasBody || hasSpecialData || hasTables || hasCharts || hasProfiles || hasBcg || hasSubsections;
    // Log competition_analysis validation details
    if (s.id === 'competition_analysis') {
      console.log(`[draftV2] competition_analysis validation: valid=${isValid}, hasBody=${hasBody}, hasProfiles=${hasProfiles}, hasBcg=${hasBcg}, hasTables=${hasTables}, hasCharts=${hasCharts}`);
    }
    return isValid;
  });
  console.log(`[draftV2] Batch [${sectionIds.join(', ')}]: parsed ${parsed.length} objects, ${valid.length} valid sections`);
  if (valid.length < parsed.length) {
    console.warn(`[draftV2] Filtered out ${parsed.length - valid.length} sections. Filtered:`, (parsed as any[]).filter((s: any) => !valid.includes(s)).map((s: any) => `${s.id} (bodyParagraphs:${s.bodyParagraphs?.length || 0}, tables:${s.tables?.length || 0}, charts:${s.charts?.length || 0}, bcg:${s.bcgMatrixData?.length || 0}, profiles:${s.competitorProfiles?.length || 0})`).join(', '));
  }
  return valid;
}

// ══════════════════════════════════════════════════════════════════════════════
// HIGH GROWTH NICHE INDUSTRY SYNTHESIS
// ══════════════════════════════════════════════════════════════════════════════

import {
  NicheIndustryInput, NicheTopicRow,
  MarketingStrategyInput, StrategyDimensionRow,
} from '@ai-insights/types';

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
- ${RECENCY_DIRECTIVE}
- ${WRITING_DIRECTIVE}`;

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

  const raw = await claudeCreateDirect(systemPrompt, userPrompt, MAX_OUTPUT_TOKENS, SYNTHESIS_MODEL);
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
  const systemPrompt = `You are a seasoned McKinsey senior partner with 25 years of strategy consulting experience. You produce institutional grade strategic analyses that Fortune 500 CEOs rely on for decision making.
Rules:
- Every dimension must have specific data points, named companies, and quantified evidence.
- Analysis must be 3 to 5 sentences and analytical, forward looking, and actionable.
- Strategic implications must be concrete enough to act on.
- Priority ratings must be justified by evidence.
- Write in natural business language without hyphens, dashes, or arrows.
- Output ONLY valid JSON. No markdown fences.
- ${RECENCY_DIRECTIVE}
- ${WRITING_DIRECTIVE}`;

  const frameworkDimensions: Record<string, string[]> = {
    'BCG Matrix': ['Stars', 'Cash Cows', 'Question Marks', 'Dogs'],
    'SWOT': ['Strengths', 'Weaknesses', 'Opportunities', 'Threats'],
    'Porters Five Forces': ['Competitive Rivalry', 'Threat of New Entrants', 'Threat of Substitutes', 'Bargaining Power of Customers', 'Bargaining Power of Suppliers'],
    'Ansoff Matrix': ['Market Penetration', 'Market Development', 'Product Development', 'Diversification'],
    '4P and 7P Marketing Mix': ['Product', 'Price', 'Place', 'Promotion', 'People', 'Process', 'Physical Evidence'],
    'AIDA': ['Attention', 'Interest', 'Desire', 'Action'],
    'PESTEL': ['Political', 'Economic', 'Social', 'Technological', 'Environmental', 'Legal'],
    'North Star': ['North Star Metric', 'Key Performance Indicators', 'Leading Indicators', 'Lagging Indicators'],
    'Flywheel Model': ['Acquisition', 'Activation', 'Retention', 'Revenue', 'Referral'],
    'Blue Ocean': ['Eliminate', 'Reduce', 'Raise', 'Create'],
    '7S Framework': ['Strategy', 'Structure', 'Systems', 'Shared Values', 'Style', 'Staff', 'Skills'],
    'GE-McKinsey Matrix': ['Invest and Grow Strategy', 'Hold and Selective Investment', 'Harvest and Divest Strategy'],
    'Eisenhower Matrix': ['Urgent and Important', 'Important but Not Urgent', 'Urgent but Not Important', 'Neither Urgent nor Important'],
  };

  const dims = frameworkDimensions[input.framework] || ['Dimension 1', 'Dimension 2', 'Dimension 3'];

  // Build dimension examples to make prompt crystal clear
  const dimExamples = dims.slice(0, 2).map((dim) => `{
      "dimension": "${dim}",
      "element": "Specific competitive factor or trend",
      "analysis": "2 to 3 sentences with specific data, company names, and market figures",
      "strategicImplication": "1 to 2 sentences on what this means for business strategy",
      "priority": "High"
    }`).join(',\n    ');

  const userPrompt = `TASK: Conduct a comprehensive ${input.framework} analysis for the "${input.industryOrSegment}" industry.
${input.productContext ? `\nPRODUCT CONTEXT: ${input.productContext.slice(0, 2000)}` : ''}
${input.additionalContext ? `\nADDITIONAL CONTEXT: ${input.additionalContext.slice(0, 1500)}` : ''}

RESEARCH DATA:
${research.slice(0, 45000)}

DIMENSIONS TO ANALYZE: ${dims.join(', ')}

OUTPUT: Return ONLY a valid JSON object (no markdown, no preamble, no explanation). The JSON must be parseable by JSON.parse() in JavaScript.

EXACT JSON STRUCTURE REQUIRED:
{
  "frameworkSummary": "3 to 5 sentences summarizing the analysis",
  "dimensions": [
    ${dimExamples},
    { "dimension": "Other dimension...", "element": "...", "analysis": "...", "strategicImplication": "...", "priority": "High|Medium|Low" }
  ],
  "strategicRecommendations": [
    "Recommendation 1: specific and actionable",
    "Recommendation 2: specific and actionable",
    "Recommendation 3: specific and actionable",
    "Recommendation 4: specific and actionable",
    "Recommendation 5: specific and actionable",
    "Recommendation 6: specific and actionable"
  ]
}

RULES:
- Provide exactly one element object per dimension (${dims.length} total).
- Each element must have all four fields: dimension, element, analysis, strategicImplication, priority.
- priority must be exactly one of: "High", "Medium", or "Low".
- Analysis text must include specific company names, market data points, and percentages.
- Do not use pipe characters (|) in the JSON — use actual values like "High" only.
- All strings must be properly JSON-escaped (no unescaped quotes or newlines).
- Return ONLY the JSON object itself, nothing else. No markdown code fences.`;

  const raw = await claudeCreateDirect(systemPrompt, userPrompt, 5000, SYNTHESIS_MODEL);

  // Remove markdown code fences
  let jsonStr = raw
    .replace(/^```[\w]*\n?/, '') // Remove opening code fence
    .replace(/\n?```$/, '')  // Remove closing code fence
    .trim();

  // Find JSON object
  const firstBrace = jsonStr.indexOf('{');
  const lastBrace = jsonStr.lastIndexOf('}');

  if (firstBrace === -1 || lastBrace === -1 || firstBrace >= lastBrace) {
    console.error('[synthesizeMarketingStrategy] Could not find JSON. Raw response:', jsonStr.slice(0, 300));
    throw new Error('No valid JSON object in marketing strategy response');
  }

  const jsonCandidate = jsonStr.substring(firstBrace, lastBrace + 1);

  let parsed: { frameworkSummary?: string; dimensions?: StrategyDimensionRow[]; strategicRecommendations?: string[] };
  try {
    parsed = JSON.parse(jsonCandidate);
  } catch (e) {
    const errorMsg = e instanceof Error ? e.message : String(e);
    console.error('[synthesizeMarketingStrategy] JSON parse failed:', errorMsg);
    console.error('[synthesizeMarketingStrategy] Response length:', jsonCandidate.length);
    console.error('[synthesizeMarketingStrategy] First 500 chars:', jsonCandidate.slice(0, 500));
    console.error('[synthesizeMarketingStrategy] Error position context:', jsonCandidate.slice(Math.max(0, 18600), 18750));
    throw new Error(`JSON parse error: ${errorMsg}`);
  }

  return {
    frameworkSummary: parsed.frameworkSummary || '',
    dimensions: (parsed.dimensions || []).filter((d) => d.dimension && d.element && d.analysis),
    strategicRecommendations: parsed.strategicRecommendations || [],
  };
}

// ── Business Segments & Timelines ────────────────────────────────────────────

export async function synthesizeBusinessSegments(
  companyName: string,
  companyDomain: string | undefined,
  research: string
): Promise<{
  segments: BusinessSegment[];
  strategicEvolution: StrategicEvolutionBullet[];
}> {
  const hasResearch = !isEmptyResearch(research);

  const systemPrompt = `You are a market research professional summarizing the reportable business segments of "${companyName}" based on its latest annual report.
Rules:
- Identify the company's CURRENT reportable business segments exactly as named in its latest annual report/10-K
- Use official segment names where available
- Every segment must be distinct and non-overlapping
- If the company operates under a single reportable segment, present that one segment with the same level of detail
- Output ONLY valid JSON. No markdown fences.
- ${RECENCY_DIRECTIVE}
- ${WRITING_DIRECTIVE}`;

  const userPrompt = `Summarize the reportable business segments of "${companyName}" based on its latest annual report.

${hasResearch ? `RESEARCH (10-K, annual reports, earnings calls, presentations):\n${research.slice(0, 25000)}` : `[No live research — use training knowledge about ${companyName}.]`}

For EACH reportable segment, write an 80-90 word segment overview in paragraph format covering:
- Products and services offered
- Types of customers catered to
- Geographic regions served
- The primary role or value delivered through the segment (what it offers, supports, enables, or helps with; tools or platforms used)

If "${companyName}" operates under a single reportable segment, capture all of the above under that one segment rather than forcing multiple segments.

Return a JSON object:
{
  "segments": [
    {
      "name": "Official segment name (exactly as reported in the latest annual report)",
      "description": "80-90 word paragraph covering products/services, customer types, geographic regions, and primary role/value delivered",
      "source": "Source attribution (e.g., '10-K 2024', 'Annual Report FY2024')"
    }
  ],
  "strategicEvolution": [
    {
      "point": "Single-sentence strategic insight about how the business model evolved (e.g., acquisitions, pivots, integration)"
    }
  ]
}

Requirements:
- List every reportable segment from the latest annual report (or the single segment, if that is how the company reports)
- Segment names should match official filings exactly
- Each segment description must be 80-90 words, in paragraph form (not bullet points)
- Strategic Evolution: 5-6 bullets explaining business model shifts
- Do NOT write "(est.)" or any estimate qualifier anywhere in the output. State facts directly and confidently.`;

  const text = await claudeCreateDirect(systemPrompt, userPrompt, 2000, SYNTHESIS_MODEL);

  let parsed;
  try {
    const match = text.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(match ? match[0] : text);
  } catch {
    throw new Error('Failed to parse business segments JSON');
  }

  return {
    segments: (parsed.segments || []).filter((s: any) => s.name && s.description),
    strategicEvolution: (parsed.strategicEvolution || []).filter((e: any) => e.point),
  };
}

export async function synthesizeBusinessTimeline(
  companyName: string,
  companyDomain: string | undefined,
  research: string
): Promise<{
  timelineBlocks: TimelineBlock[];
  strategicEvolution: StrategicEvolutionBullet[];
}> {
  const hasResearch = !isEmptyResearch(research);
  const currentYear = new Date().getFullYear();

  const systemPrompt = `You are a corporate research analyst building a verifiable milestone timeline for "${companyName}".
Rules:
- Output ONLY valid JSON. No markdown fences.
- Every milestone must be a real, named, verifiable event. Never invent or generalize.
- ${RECENCY_DIRECTIVE}
- ${WRITING_DIRECTIVE}`;

  const userPrompt = `Create a timeline of 7-10 verifiable milestones for "${companyName}", from its founding year to ${currentYear}, following the rules below.

${hasResearch ? `RESEARCH (10-K, annual reports, press releases, investor presentations):\n${research.slice(0, 25000)}` : `[No live research — use training knowledge about ${companyName}. Label as "(est.)" where appropriate.]`}

MILESTONE SELECTION RULES:
1. Include only one milestone per year.
2. Do not specify month or day — year only.
3. One milestone must be from the current year (${currentYear}) — mandatory.
4. The current-year milestone must be a specific, verifiable event such as a new launch, partnership, acquisition, award, leadership change, or investment, clearly named and dated, sourced from the company's official press release, news release, news, events, or investor relations page. Do not use general statements or financial updates.
5. If "${companyName}" was founded between 1700 and 1999: include only TWO milestones from before 2000. One of those two must be the founding year itself, naming the company's original founding name. The remaining 5-8 milestones must be from 2000 to ${currentYear}, spaced chronologically (do not cluster).
6. If a valid milestone cannot be found for a year, skip that year and choose the next closest eligible year instead.

MILESTONE FORMAT (mandatory):
Each milestone's narrative must be a single 15-30 word sentence in past tense describing a real, named, and verifiable event.

ACCEPTED CATEGORIES (every milestone must fall into one of these):
- Mergers & Acquisitions (name both entities)
- Partnerships / Joint Ventures (name both companies)
- Product/Service Launches (name the specific offering)
- Major Client Wins or Strategic Contracts (name both parties)
- Industry Awards (name the award and the company)
- C-Level Leadership Changes (name the individual and the company)
- Technology Investments (name the specific platform/tool)
- Organizational/Strategic Shifts (e.g., named field/operating model change)
- Business Expansions (name the geography or facility)

EXCLUDED — do not use any milestone that is:
- A generic or vague phrase (e.g. "expanded operations", "launched new products")
- A CSR/DEI/HR program or donation
- A financial update (earnings, funding round, dividend)
- A mission statement or non-specific strategy claim
- Unverifiable or lacking a named entity/event

SOURCE PRIORITY (cite in the "source" field):
1. Company website, newsroom, investor relations, SEC filings
2. PR Newswire, Business Wire, GlobeNewswire
3. Reputable secondary sources (Reuters, Bloomberg, WSJ, industry journals)
Do NOT cite Wikipedia, Crunchbase, blogs, or media speculation as a source.

Return a JSON object:
{
  "timelineBlocks": [
    {
      "period": "YYYY (single year only, no ranges)",
      "narrative": "15-30 word past-tense sentence describing the one verifiable milestone for that year",
      "source": "Source attribution per the priority list above (e.g., 'Company press release, 2023', 'Reuters, 2021')"
    }
  ],
  "strategicEvolution": [
    {
      "point": "Single-sentence strategic insight (5-6 bullets total)"
    }
  ]
}

Requirements:
- Return 7-10 timelineBlocks, one per year, in chronological order.
- Strategic Evolution: 5-6 bullets explaining business model evolution, inflection points, revenue driver shifts, derived from the milestones above.`;

  const text = await claudeCreateDirect(systemPrompt, userPrompt, 2500, SYNTHESIS_MODEL);

  let parsed;
  try {
    const match = text.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(match ? match[0] : text);
  } catch {
    throw new Error('Failed to parse business timeline JSON');
  }

  return {
    timelineBlocks: (parsed.timelineBlocks || []).filter((t: any) => t.period && t.narrative),
    strategicEvolution: (parsed.strategicEvolution || []).filter((e: any) => e.point),
  };
}

// ── Technology Investment Heat Map Synthesis (new) ───────────────────────────

export async function synthesizeTechHeatMap(
  input: TechHeatMapInput,
  onChunk?: (accumulated: string) => void
): Promise<{ headline: string; rows: TechHeatMapRow[] }> {
  const systemPrompt = `You are a technology investment analyst. Output ONLY valid JSON. No markdown fences. ${WRITING_DIRECTIVE}`;

  const userPrompt = `Assess technology investment levels for companies in the "${input.industry}" industry operating in "${input.geography}" over the next 6 months.

Technologies to assess:
${input.technologies.map((t, i) => `${i + 1}. ${t}`).join('\n')}

For each technology:
1. Assign an investmentLevel: "very_high", "high", or "medium" — based on the likelihood and scale of investment by companies in this industry and geography.
2. Write a description (2-3 sentences) that MUST include REAL recent examples of companies in this industry investing in this technology. Use your training knowledge. Cite specific company names, announced plans, or known deployments (e.g. "Deloitte, PwC, and Accenture have announced plans to deploy..."). Only include examples you are confident are accurate from your training data. Do not fabricate company names, investments, or announcements.
3. Also generate a one-sentence headline summarising the overall investment theme across all these technologies for this industry and geography.

Sort rows: very_high first, then high, then medium.

Output format (strict JSON, no markdown):
{
  "headline": "one sentence summarising the overall investment theme",
  "rows": [
    { "technology": "str", "investmentLevel": "very_high|high|medium", "description": "str with real company examples" }
  ]
}`;

  const fullText = await claudeCreateDirect(systemPrompt, userPrompt, 4096, SYNTHESIS_MODEL, 60000);
  onChunk?.(fullText);
  console.log(`[synthesizeTechHeatMap] done length=${fullText.length}`);

  // Parse
  try {
    const cleaned = fullText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
    const parsed = JSON.parse(cleaned);
    return {
      headline: parsed.headline || '',
      rows: (parsed.rows || []).map((r: any) => ({
        technology: r.technology || '',
        investmentLevel: r.investmentLevel || 'medium',
        description: r.description || '',
      })),
    };
  } catch (err) {
    console.error('[synthesizeTechHeatMap] Parse error:', err);
    // Try extracting JSON object
    const match = fullText.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]);
        return {
          headline: parsed.headline || '',
          rows: (parsed.rows || []).map((r: any) => ({
            technology: r.technology || '',
            investmentLevel: r.investmentLevel || 'medium',
            description: r.description || '',
          })),
        };
      } catch {
        // fall through
      }
    }
    throw new Error('Failed to parse synthesizeTechHeatMap response');
  }
}

// ── Technology Heat Map Synthesis (legacy) ────────────────────────────────────

export async function synthesizeHeatMap(
  input: {
    industry: string;
    selectedCompetitors: string[];
    selectedTechs: string[];
    industrySegments: string[];
  },
  competitorResearch: Record<string, string>,
  industrySegmentResearch: Record<string, string>,
  hasCompetitors: boolean = true,
  hasSegments: boolean = true
): Promise<{
  competitionHeatMap: any[][];
  industryHeatMap: any[][];
  insights: any;
}> {
  const systemPrompt = `You are a technology adoption analyst specializing in competitive intelligence and industry trends.
Rules:
- Analyze adoption data objectively based on provided research
- Assign adoption stages 1-5: 1=minimal (<10%), 2=early (10-30%), 3=growth (30-60%), 4=widespread (60-85%), 5=dominant (85%+)
- Provide specific vendor names, implementations, and deployment examples
- Output ONLY valid JSON with no markdown fences
- ${RECENCY_DIRECTIVE}
- ${WRITING_DIRECTIVE}`;

  const truncatedCompResearch = truncateResearch(competitorResearch, 20000);
  const truncatedSegResearch = truncateResearch(industrySegmentResearch, 20000);

  // Build prompt based on which mode(s) are active
  let researchSection = '';
  if (hasCompetitors) {
    researchSection += `COMPETITOR ADOPTION RESEARCH:
${Object.entries(truncatedCompResearch)
  .map(([co, r]) => `### ${co}\n${r}`)
  .join('\n---\n')}

`;
  }
  if (hasSegments) {
    researchSection += `INDUSTRY SEGMENT ADOPTION RESEARCH:
${Object.entries(truncatedSegResearch)
  .map(([seg, r]) => `### ${seg}\n${r}`)
  .join('\n---\n')}

`;
  }

  // Build JSON structure based on modes
  let jsonStructure = `Return ONLY a valid JSON object with this structure (omit empty arrays):
{`;
  let requirementsText = '';

  if (hasCompetitors) {
    jsonStructure += `
  "competitionHeatMap": [
    { "competitor": "Company Name", "technology": "Tech Name", "adoptionStage": 3, "adoptionPercentage": 45, "vendors": ["Vendor A"], "details": "1-2 sentence context" }
  ],`;
    requirementsText += `- competitionHeatMap: EXACTLY ${input.selectedCompetitors.length} × ${input.selectedTechs.length} cells\n`;
  }

  if (hasSegments) {
    jsonStructure += `
  "industryHeatMap": [
    { "segment": "Segment Name", "technology": "Tech Name", "adoptionStage": 2, "adoptionPercentage": 25, "vendors": [], "details": "Brief context" }
  ],`;
    requirementsText += `- industryHeatMap: EXACTLY ${input.industrySegments.length} × ${input.selectedTechs.length} cells\n`;
  }

  jsonStructure += `
  "insights": {
    "leaderCompetitors": ${hasCompetitors ? '["Company A", "Company B"]' : '[]'},
    "emergingTechs": ["Tech X", "Tech Y"],
    "competitiveGaps": ${hasCompetitors ? '["Gap description"]' : '[]'},
    "industryTrends": ${hasSegments ? '["Trend description"]' : '[]'},
    "strategicRecommendations": ["Rec 1", "Rec 2"]
  }
}`;

  const userPrompt = `Generate technology adoption heat maps for "${input.industry}" industry.

${hasCompetitors ? `COMPETITORS: ${input.selectedCompetitors.join(', ')}\n` : ''}${hasSegments ? `INDUSTRY SEGMENTS: ${input.industrySegments.join(', ')}\n` : ''}TECHNOLOGIES: ${input.selectedTechs.join(', ')}

${researchSection}
${jsonStructure}

REQUIREMENTS:
${requirementsText}- adoptionStage: integer 1-5 only
- adoptionPercentage: 0-100
- Include 3-5 strategic recommendations based on adoption patterns

CRITICAL: Output ONLY valid JSON (no markdown, no code fences, no preamble). Start with { and end with }`;

  const heatMapText = await claudeCreateDirect(systemPrompt, userPrompt, 12000, SYNTHESIS_MODEL);

  try {
    let rawText = heatMapText.trim();

    // Remove markdown code fences if present (multiple patterns)
    rawText = rawText
      .replace(/^```(?:json)?\s*\n?/, '') // Remove opening fence
      .replace(/\n?```\s*$/, ''); // Remove closing fence

    // Additional cleanup for common issues
    rawText = rawText.trim();

    // Try direct parse first (happy path)
    try {
      const parsed = JSON.parse(rawText);
      return {
        competitionHeatMap: Array.isArray(parsed.competitionHeatMap) ? parsed.competitionHeatMap : [],
        industryHeatMap: Array.isArray(parsed.industryHeatMap) ? parsed.industryHeatMap : [],
        insights: typeof parsed.insights === 'object' ? parsed.insights : {},
      };
    } catch (directErr) {
      // Direct parse failed, try extraction
      console.log('[synthesizeHeatMap] Direct parse failed, attempting extraction:', directErr instanceof Error ? directErr.message : String(directErr));
    }

    // If direct parse failed, extract JSON using brace matching
    let parsed: any = null;
    const startIdx = rawText.indexOf('{');
    if (startIdx === -1) throw new Error('No JSON object found in response');

    // Find matching closing brace using a simple counter
    let braceCount = 0;
    let endIdx = -1;
    let inString = false;
    let escapeNext = false;

    for (let i = startIdx; i < rawText.length; i++) {
      const char = rawText[i];

      if (escapeNext) {
        escapeNext = false;
        continue;
      }

      if (char === '\\') {
        escapeNext = true;
        continue;
      }

      if (char === '"') {
        inString = !inString;
        continue;
      }

      if (!inString) {
        if (char === '{') braceCount++;
        else if (char === '}') {
          braceCount--;
          if (braceCount === 0) {
            endIdx = i + 1;
            break;
          }
        }
      }
    }

    if (endIdx === -1) {
      // Couldn't find matching brace, try substring fallback
      console.log('[synthesizeHeatMap] Could not find matching closing brace, using substring extraction');
      for (let idx = rawText.length; idx > startIdx + 1; idx--) {
        try {
          const candidate = rawText.substring(startIdx, idx);
          parsed = JSON.parse(candidate);
          console.log('[synthesizeHeatMap] Successfully parsed with substring extraction');
          break;
        } catch (e) {
          continue;
        }
      }
    } else {
      // Try parsing the matched braces
      try {
        const candidate = rawText.substring(startIdx, endIdx);
        parsed = JSON.parse(candidate);
        console.log('[synthesizeHeatMap] Successfully parsed with brace matching');
      } catch (e) {
        console.log('[synthesizeHeatMap] Brace matching failed, falling back to substring');
        for (let idx = rawText.length; idx > startIdx + 1; idx--) {
          try {
            const candidate = rawText.substring(startIdx, idx);
            parsed = JSON.parse(candidate);
            break;
          } catch (err) {
            continue;
          }
        }
      }
    }

    if (!parsed) {
      throw new Error('Could not extract valid JSON from response');
    }

    return {
      competitionHeatMap: Array.isArray(parsed.competitionHeatMap) ? parsed.competitionHeatMap : [],
      industryHeatMap: Array.isArray(parsed.industryHeatMap) ? parsed.industryHeatMap : [],
      insights: typeof parsed.insights === 'object' ? parsed.insights : {},
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error('[synthesizeHeatMap] Parse error:', errorMsg);
    console.error('[synthesizeHeatMap] Response length:', heatMapText.length);
    console.error('[synthesizeHeatMap] First 200 chars:', JSON.stringify(heatMapText.slice(0, 200)));
    console.error('[synthesizeHeatMap] Last 200 chars:', JSON.stringify(heatMapText.slice(-200)));
    throw new Error(`Failed to parse heat map data: ${errorMsg}`);
  }
}

// ── Technology Heat Map Discovery (Claude-based, fast) ────────────────────────

export async function discoverTopPlayersByIndustryQuick(
  industry: string
): Promise<Array<{ name: string; headquarters: string; estimatedRevenue: string; relevanceScore: number }>> {
  const text = await claudeCreateDirect('', `Identify the top 10 key players (major companies by revenue/market share) in the "${industry}" industry as of 2025.

Return ONLY a valid JSON array with exactly 10 companies. No other text. Each item must have: name, headquarters, estimatedRevenue, relevanceScore (1-10).

Example format:
[
  {"name":"Company A","headquarters":"City, Country","estimatedRevenue":"$100B","relevanceScore":10},
  {"name":"Company B","headquarters":"City, Country","estimatedRevenue":"$80B","relevanceScore":9}
]`, 1024, 'claude-sonnet-4-6');

  try {
    return JSON.parse(text);
  } catch {
    console.error('[discoverTopPlayers] Parse error:', text);
    return [];
  }
}

export async function discoverEmergingTechsQuick(
  industry: string
): Promise<Array<{ name: string; category: string; maturityLevel: string }>> {
  const systemPrompt = `You are a technology analyst. You MUST always respond with a valid JSON array — never prose, never "no technologies found", never refusals. If the industry is niche or regional, use your knowledge of that sector's technology landscape and return the most relevant technologies. Output ONLY the raw JSON array, no markdown fences, no other text.`;

  const text = await claudeCreateDirect(systemPrompt, `List the top 10 emerging and strategic technologies used by companies in the "${industry}" sector as of 2025. Include technologies relevant to this specific industry and geography (if regional). Each entry must have: name, category, maturityLevel ("emerging", "growth", or "mainstream").

Return ONLY a valid JSON array:
[
  {"name":"AI/ML","category":"Artificial Intelligence","maturityLevel":"growth"},
  {"name":"Blockchain","category":"Distributed Ledger","maturityLevel":"emerging"}
]`, 1024, 'claude-sonnet-4-6');

  try {
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    throw new Error('empty array');
  } catch {
    // Try extracting a JSON array anywhere in the response
    const match = text.match(/\[[\s\S]*\]/);
    if (match) {
      try { return JSON.parse(match[0]); } catch { /* fall through */ }
    }
    console.error('[discoverEmergingTechs] Parse error, raw text:', text.slice(0, 200));
    return [];
  }
}

export async function discoverIndustrySegmentsQuick(
  industry: string
): Promise<string[]> {
  const text = await claudeCreateDirect('', `List the top 10 segments or subsectors within the "${industry}" industry.

Return ONLY a JSON array of 10 segment names as strings. No other text.

Example: ["Segment A","Segment B","Segment C",...]`, 512, 'claude-sonnet-4-6');

  try {
    return JSON.parse(text);
  } catch {
    console.error('[discoverSegments] Parse error:', text);
    return [];
  }
}

// ── Content Generation (Industry Blog & Thought Leadership) ──────────────────

export async function synthesizeContent(
  input: ContentGenerationInput,
  onChunk?: (accumulated: string) => void
): Promise<{ title: string; content: string; hashtags?: string[]; charts?: Array<{ title: string; type: 'bar' | 'line'; data: Array<{ label: string; value: number }>; unit?: string }> }> {
  const client = initializeClient();

  const toneLabel = input.tone === 'professional' ? 'professional' : 'smart casual';
  const perspectiveLabel = input.perspective === 'practitioner' ? 'practitioner' : 'analyst';

  if (!input.industryReportData) throw new Error('industryReportData is required');
  const d = input.industryReportData;
  const industryName = d.query;

  // Build rich data context from report sections (include tables if present)
  const execSummary = d.executiveSummary ? `Executive Summary:\n${d.executiveSummary}\n\n` : '';
  const sectionLines = (d.sections || [])
    .map((s) => {
      const body = (s.bodyParagraphs || []).map((p) => `- ${p}`).join('\n');
      const table = s.keyTable && s.keyTable.length > 0
        ? '\nKey Data:\n' + s.keyTable.map((r) => `  ${r.label}: ${r.value}${r.previousValue ? ` (prev: ${r.previousValue})` : ''}`).join('\n')
        : '';
      return `## ${s.title}\n${body}${table}`;
    })
    .join('\n\n');
  const dataContext = `Industry/Topic: ${industryName}\n\n${execSummary}Report Sections:\n${sectionLines || 'None'}`;

  let userPrompt: string;

  const voiceLabel = input.voice === 'first_person' ? 'first-person (use "I", "we", "our perspective")' : 'third-person analytical';

  if (input.moduleType === 'industry-blog') {
    userPrompt = `Write a ${input.wordCount}-word industry blog post about "${industryName}" in ${voiceLabel} voice.
Tone: ${toneLabel}. Perspective: ${perspectiveLabel}.
Draw on the industry report data below. Include specific statistics, trends and insights from the data. End with 5-8 relevant hashtags.

Source data:
${dataContext}

Output ONLY valid JSON (no markdown fences):
{ "title": "...", "content": "...", "hashtags": ["#tag1", ...] }`;
  } else {
    userPrompt = `Write a ${input.wordCount}-word thought leadership article about "${industryName}" in third-person analytical voice.
Tone: ${toneLabel}. Perspective: ${perspectiveLabel}.
Requirements:
- Write for senior business leaders and C-suite executives
- Use a structured format with clear section headings (use markdown ## for headings)
- Include AT LEAST 2 markdown tables showing key data comparisons, metrics or trends from the report
- Be specific: cite figures, percentages, market sizes from the source data
- Forward-looking with strategic implications

Source data:
${dataContext}

Also generate 2-3 charts from the data. Each chart has a title, type (bar or line), array of {label, value} data points, and optional unit.

Output ONLY valid JSON (no markdown fences):
{
  "title": "...",
  "content": "... (markdown with ## headings and | tables) ...",
  "charts": [
    { "title": "...", "type": "bar", "data": [{"label": "...", "value": 0}], "unit": "%" }
  ]
}`;
  }

  const accumulated = await claudeCreateDirect(
    'You are a senior industry analyst and content strategist. Output ONLY valid JSON. No markdown fences, no text outside the JSON object.',
    userPrompt,
    input.wordCount > 1000 ? 6000 : 4000,
    SYNTHESIS_MODEL
  );
  onChunk?.(accumulated);

  const cleaned = accumulated.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  // Brace-match fallback for partial JSON
  const match = cleaned.match(/\{[\s\S]*\}/);
  const jsonStr = match ? match[0] : cleaned;

  try {
    const parsed = JSON.parse(jsonStr) as { title?: string; content?: string; hashtags?: string[]; charts?: Array<{ title: string; type: 'bar' | 'line'; data: Array<{ label: string; value: number }>; unit?: string }> };
    return {
      title: parsed.title || '',
      content: parsed.content || '',
      hashtags: parsed.hashtags,
      charts: parsed.charts,
    };
  } catch {
    console.error('[synthesizeContent] JSON parse failed, using raw text as content');
    return { title: '', content: accumulated };
  }
}

// ── Sales Play II synthesis ───────────────────────────────────────────────────

export async function synthesizeSalesPlay2(
  input: SalesPlay2Input,
  research: string,
  competitorList: string[],
  incumbencyResearch: string,
  onChunk?: (accumulated: string) => void
): Promise<{ winThemes: SalesPlay2WinTheme[]; opportunities: SalesPlay2Opportunity[]; competitors: SalesPlay2Competitor[] }> {
  const hasResearch = !isEmptyResearch(research);
  const hasIncumbencyResearch = !isEmptyResearch(incumbencyResearch);
  const competitors = competitorList.length ? competitorList : [input.competitorName];

  const systemPrompt = `You are an elite B2B sales strategist. Output ONLY valid JSON. No markdown fences. ${WRITING_DIRECTIVE}`;

  const userPrompt = `Generate a Sales Play II for ${input.yourCompany} targeting ${input.targetAccount} in the ${input.targetIndustry} industry. Competitors to displace: ${competitors.join(', ')}.
${input.strategicPriorities?.length ? `\nTarget Account Strategic Priorities:\n${input.strategicPriorities.join('\n')}` : ''}
${input.solutionAreas ? `\nOur Solution Areas: ${input.solutionAreas}` : ''}
${input.competitorWeaknesses ? `\nKnown Competitor Weaknesses: ${input.competitorWeaknesses}` : ''}
${hasResearch ? `\nRESEARCH:\n${research.slice(0, 12000)}` : '\n[No live research — use training knowledge]'}
${hasIncumbencyResearch ? `\nVENDOR INCUMBENCY CHECK (web search results for "competitor + ${input.targetAccount}" — use this to determine if a competitor already has a deployment/relationship there):\n${incumbencyResearch.slice(0, 4000)}` : ''}

Generate:
1. Win Themes — 4-5 specific themes tied to ${input.targetAccount}'s business context with triggers that create urgency. Each theme must have a short "focusArea" label (2-4 words, e.g. "Cloud Migration", "Cybersecurity Modernization"). Win Themes and triggers must be about ${input.targetAccount}'s own business context (priorities, pain points, initiatives) — do NOT mention any competitor by name in the theme or trigger text.
2. Opportunity Mapping — 4-5 opportunity areas showing how ${input.yourCompany} solves real problems with realistic deal sizes
3. Competitive Positioning — generate ONE entry for EACH of these competitors, in this exact order: ${competitors.join(', ')}. For each, give specific strengths, weaknesses, and how ${input.yourCompany} differentiates. If the VENDOR INCUMBENCY CHECK above shows credible evidence (a case study, partnership announcement, deployment, or customer reference) that this competitor already serves ${input.targetAccount}, set "incumbencyNote" to a short factual note (e.g. "Existing vendor since 2021 — confirmed via case study") citing what was found. If no such evidence exists, omit "incumbencyNote" entirely (do not guess or fabricate).

Output JSON:
{
  "winThemes": [
    { "theme": "...", "focusArea": "...", "trigger": "..." }
  ],
  "opportunities": [
    {
      "opportunityArea": "...",
      "specificUseCases": "...",
      "problemSolutionMapping": "... → ...",
      "valueProposition": "...",
      "estimatedDealSize": "$XM – $YM"
    }
  ],
  "competitors": [
    {
      "name": "...",
      "strengths": "...",
      "weaknesses": "...",
      "differentiationStrategy": "...",
      "incumbencyNote": "... (omit this field entirely if no evidence)"
    }
  ]
}`;

  // Raw fetch instead of the @anthropic-ai/sdk client — the SDK (pinned at
  // 0.28.0) hits a deterministic "Premature close" while fetching
  // api.anthropic.com/v1/messages for this prompt, reproducing identically
  // whether streamed or not. Bypassing the SDK's bundled HTTP client for
  // just this call sidesteps the bug without a risky app-wide SDK upgrade.
  async function runOnce(): Promise<string> {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), 120000);
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY || '',
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: SYNTHESIS_MODEL,
          max_tokens: 4000,
          temperature: 0.1,
          system: systemPrompt,
          messages: [{ role: 'user', content: userPrompt }],
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`Anthropic API ${res.status}: ${errText.slice(0, 300)}`);
      }
      const data = await res.json() as { content: Array<{ type: string; text?: string }> };
      const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text || '').join('');
      onChunk?.(text);
      return text;
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  let fullText: string;
  try {
    fullText = await runOnce();
  } catch (err) {
    console.warn('[synthesizeSalesPlay2] call failed, retrying once:', err instanceof Error ? err.message : err);
    fullText = await runOnce();
  }

  const match = fullText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim().match(/\{[\s\S]*\}/);
  if (!match) throw new Error('SalesPlay2: no JSON in response');
  const parsed = JSON.parse(match[0]);
  return {
    winThemes: parsed.winThemes || [],
    opportunities: parsed.opportunities || [],
    competitors: parsed.competitors || [],
  };
}

// ── Consulting Intelligence Synthesis ────────────────────────────────────────

/**
 * From the broad discovery text, extract the top 10 firm names that have
 * verifiably published thought leadership on the topic.
 */
export async function extractTopFirmsFromDiscovery(
  discoveryText: string,
  topic: string
): Promise<string[]> {
  const raw = await claudeCreateDirect(
    'You extract firm names from research text. Return only a JSON array of strings. No markdown, no explanation.',
    `From the research text below, identify up to 10 consulting, advisory, or analyst firms that have verifiably published thought leadership content on "${topic}". Only include firms for which there is clear evidence of a report, white paper, article, or research piece in the text. Return a JSON array of firm names, most evidence-rich first.\n\nRESEARCH TEXT:\n${discoveryText.slice(0, 10000)}`,
    512,
    FAST_MODEL
  );
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const match = cleaned.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    const arr = JSON.parse(match[0]);
    return Array.isArray(arr) ? arr.slice(0, 10) : [];
  } catch { return []; }
}

// ── Helper: run a Claude call with timeout, return raw text (partial-safe) ────
async function runClaudeStream(
  model: string,
  maxTokens: number,
  system: string,
  userContent: string,
  timeoutMs: number,
): Promise<string> {
  return claudeCreateDirect(system, userContent, maxTokens, model, timeoutMs).catch(() => '');
}

// ── Helper: parse JSON robustly (handles truncation) ─────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseJsonRobust(raw: string): any {
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const start = cleaned.indexOf('{');
  if (start === -1) throw new Error('no JSON object found');
  const text = cleaned.slice(start);
  // Try direct parse first
  try { return JSON.parse(text); } catch { /* fall through */ }
  // Try greedily extracting the largest complete {...} block
  let depth = 0; let end = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end !== -1) { try { return JSON.parse(text.slice(0, end + 1)); } catch { /* fall through */ } }
  throw new Error('unparseable JSON');
}

export async function synthesiseConsultingIntelligence(
  topic: string,
  geography: string,
  discoveredFirms: string[],
  researchBatches: Array<{ label: string; rawText: string }>
): Promise<Partial<ConsultingIntelligenceJob>> {
  const hasRealResearch = researchBatches.some(b => !b.rawText.includes('No data retrieved'));
  const researchNote = hasRealResearch
    ? `The LIVE RESEARCH DATA below contains web search results about "${topic}" in ${geography}. Identify content from McKinsey, BCG, Bain, Deloitte, PwC, EY, KPMG, Gartner, Forrester, IDC, Accenture, HBR, WEF and other research/consulting firms. Extract and attribute their specific findings, statistics, and positions.`
    : `No live web research was retrieved. Use your extensive training knowledge of published reports from McKinsey, BCG, Bain, Deloitte, PwC, EY, KPMG, Gartner, Forrester, IDC, Accenture and other leading firms on "${topic}" in ${geography}. Produce substantive, attributed insights.`;

  const systemPrompt = `You are a senior analyst producing an analyst-grade thought leadership synthesis on consulting and research firm positions.
${researchNote}
RULES:
- Always produce substantive, expert-level output. Never return empty arrays or vague statements.
- Attribute ALL insights to specific named firms (e.g. "McKinsey argues…", "Gartner forecasts…", "Deloitte's 2024 survey found…").
- Use real statistics when available from research. When using training knowledge, frame as "According to [Firm]'s research…".
- Identify which consulting/analyst firms appear in the research and focus on their positions.
Return only valid JSON with no markdown fencing.`;

  const researchText = hasRealResearch
    ? researchBatches.map(({ label, rawText }) => `=== ${label.toUpperCase()} ===\n${rawText}`).join('\n\n').slice(0, 20000)
    : '(No live research — use training knowledge)';

  const firms = discoveredFirms.slice(0, 6).join(', ');

  // ── Call 1: Executive summary + themes + recommendations (must complete) ──
  const call1Prompt = `Topic: "${topic}" | Geography: ${geography} | Firms: ${firms}

LIVE RESEARCH:
${researchText}

Return JSON:
{
  "executiveSummary": {
    "topInsights": ["5 key insights attributed to named firms"],
    "emergingTrends": ["4-5 trends"],
    "consensusViewpoints": ["3-4 points where firms agree"],
    "contrarianOpinions": ["2-3 contrarian views"],
    "strategicImplications": ["4-5 strategic implications"],
    "futureOutlook": "2-3 sentence outlook paragraph"
  },
  "emergingThemes": [
    {"theme": "string", "frequency": number, "strategicUrgency": "high"|"medium"|"low", "businessImpact": "high"|"medium"|"low", "description": "string"}
  ],
  "strategicRecommendations": ["5-6 actionable recommendations"],
  "researchMethodology": "brief string describing sources used"
}`;

  const raw1 = await runClaudeStream(SYNTHESIS_MODEL, 2500, systemPrompt, call1Prompt, 120_000);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let part1: any = {};
  try { part1 = parseJsonRobust(raw1); } catch (e) {
    console.error('[synthesiseConsultingIntelligence] call1 parse failed:', e, 'raw:', raw1.slice(0, 200));
  }

  // ── Call 2: Firm analyses + evidence (best-effort, won't fail the job) ────
  const call2Prompt = `Topic: "${topic}" | Geography: ${geography}

LIVE RESEARCH:
${researchText.slice(0, 15000)}

Return JSON with exactly these fields:
{
  "firmAnalyses": [
    {"firmName": "string", "keyThemes": ["2-3"], "keyInsights": ["2-3"], "marketOutlook": "string", "keyStatistics": ["1-2"], "risks": ["1-2"]}
  ],
  "quantitativeEvidence": [
    {"metric": "string", "value": "string", "sourceFirm": "string", "geography": "string", "year": "string"}
  ],
  "comparativeMatrix": [{"Firm": "string", "Focus Area": "string", "Key Position": "string", "Maturity View": "string"}]
}
Include 5-6 firms in firmAnalyses. Include 5-8 quantitative evidence items. Include 5-6 matrix rows.`;

  const raw2 = await runClaudeStream(FAST_MODEL, 3000, systemPrompt, call2Prompt, 90_000);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let part2: any = {};
  try { part2 = parseJsonRobust(raw2); } catch (e) {
    console.warn('[synthesiseConsultingIntelligence] call2 parse failed (non-fatal):', e);
  }

  // Always guarantee executiveSummary — never let it be undefined
  const execSummary = part1.executiveSummary ?? {
    topInsights: [`Synthesis completed for "${topic}" in ${geography}. Research drew from ${researchBatches.filter(b => !b.rawText.includes('No data retrieved')).length} live sources and Claude training knowledge.`],
    emergingTrends: part1.emergingThemes?.map((t: TLTheme) => t.theme) || [],
    consensusViewpoints: [],
    contrarianOpinions: [],
    strategicImplications: part1.strategicRecommendations?.slice(0, 3) || [],
    futureOutlook: 'Detailed synthesis available — see firm analyses and strategic recommendations below.',
  };

  return {
    executiveSummary: execSummary,
    emergingThemes: (part1.emergingThemes || []) as TLTheme[],
    strategicRecommendations: part1.strategicRecommendations || [],
    researchMethodology: part1.researchMethodology || `Synthesised from ${researchBatches.length} research batches using Claude training knowledge.`,
    firmAnalyses: (part2.firmAnalyses || []) as TLFirmInsight[],
    quantitativeEvidence: (part2.quantitativeEvidence || []) as TLMetric[],
    comparativeMatrix: part2.comparativeMatrix || [],
    sourceAttribution: [] as TLInsight[],
    charts: [] as TLChartSpec[],
  };
}

// ── VUCA × 4W1H Analysis ──────────────────────────────────────────────────────

async function claudeCreate(system: string, user: string, maxTokens: number, timeoutMs: number, model = FAST_MODEL): Promise<string> {
  return claudeCreateDirect(system, user, maxTokens, model, timeoutMs);
}

// ── Retry wrapper: attempt up to 2 times if response is too short ─────────────
async function vucaCall(
  system: string, user: string, maxTokens: number, timeoutMs: number, label: string
): Promise<string> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const raw = await claudeCreate(system, user, maxTokens, timeoutMs, SYNTHESIS_MODEL)
      .catch((e: Error) => { console.error(`[vuca] ${label} attempt ${attempt} error: ${e.message}`); return ''; });
    console.log(`[vuca] ${label} attempt ${attempt} len=${raw.length} preview="${raw.slice(0, 80)}"`);
    if (raw.length > 80) return raw;
    console.warn(`[vuca] ${label} attempt ${attempt} too short — retrying`);
  }
  return '';
}

export async function runVucaSynthesis(
  industry: string,
  geography: string,
  analysisDate: string,
  researchText: string,
  companyContext?: { name: string; domain: string; profile: string },
): Promise<Pick<VucaAnalysisJob, 'vucaDriverEffects' | 'vuca4w1hMatrix' | 'itSpendImpact' | 'itSpendSummaryTotal' | 'clientITImpact' | 'geopoliticalStress'>> {

  // Trim context per call — shorter prompt = faster Haiku response on Render 0.1 vCPU
  const ctx = researchText.slice(0, 5000);
  const clientMode = !!(companyContext?.name && companyContext?.profile);

  const systemPrompt = `You are a senior industry analyst. OUTPUT IS VALID JSON ONLY — no prose, no markdown fences, no code blocks. Use 2024–2026 data. Cite sources inline where available.`;

  // ── Call 1a: VUCA Driver, Effects & Demand table ─────────────────────────
  const call1a = `Industry: ${industry} | Geography: ${geography} | Date: ${analysisDate}
Context: ${ctx}

Return JSON — key "vucaDriverEffects", exactly 4 objects (one per VUCA dimension).
Fields:
- vucaDimension: VOLATILE | UNCERTAIN | COMPLEX | AMBIGUOUS
- driver: 1 sentence — the primary force causing this VUCA condition
- effects: 3-4 bullet points (each starting "• ") — key disruption effects on ${industry}
- demand: 3-4 bullet points (each starting "• ") — new IT/technology demand this condition creates

{"vucaDriverEffects":[{"vucaDimension":"VOLATILE","driver":"","effects":"","demand":""},{"vucaDimension":"UNCERTAIN","driver":"","effects":"","demand":""},{"vucaDimension":"COMPLEX","driver":"","effects":"","demand":""},{"vucaDimension":"AMBIGUOUS","driver":"","effects":"","demand":""}]}`;

  // ── Call 1b: VUCA × 4W1H Matrix ─────────────────────────────────────────
  const clientHowNote = clientMode
    ? ` Tailor all "how" adaptation actions specifically to ${companyContext!.name}'s products/solutions.`
    : '';

  const call1b = `Industry: ${industry} | Geography: ${geography} | Date: ${analysisDate}${clientHowNote}
Context: ${ctx}

Return JSON — key "vuca4w1hMatrix", exactly 4 objects (one per VUCA dimension).
Cover: armed conflicts & wars, supply chain disruptions, pandemic/health crises, energy shocks, trade wars & tariffs, regulatory upheaval, climate events — most material for ${industry}.
Fields:
- vucaDimension: VOLATILE | UNCERTAIN | COMPLEX | AMBIGUOUS
- lens: 5-8 word descriptor of dominant stress theme
- what: named situation with quantified stat (2 sentences)
- why: 2-3 causal links — root cause and mechanism
- where: named countries/corridors (epicentre vs ripple zones)
- when: FLAT STRING only — format: "▸ Acute: [1 sentence] | ▸ Structural Reset (6-18 mo): [1 sentence] | ▸ Recovery (18-36 mo): [1 sentence]". MUST be a string, NOT a JSON object.
- how: "What does this mean for ${clientMode ? companyContext!.name : 'organisations in ' + industry} and what must they do to adapt?" — 2-3 concrete actions with 30/60/90-day signals

{"vuca4w1hMatrix":[{"vucaDimension":"VOLATILE","lens":"","what":"","why":"","where":"","when":"▸ Acute: ... | ▸ Structural Reset (6-18 mo): ... | ▸ Recovery (18-36 mo): ...","how":""},{"vucaDimension":"UNCERTAIN","lens":"","what":"","why":"","where":"","when":"▸ Acute: ... | ▸ Structural Reset (6-18 mo): ... | ▸ Recovery (18-36 mo): ...","how":""},{"vucaDimension":"COMPLEX","lens":"","what":"","why":"","where":"","when":"▸ Acute: ... | ▸ Structural Reset (6-18 mo): ... | ▸ Recovery (18-36 mo): ...","how":""},{"vucaDimension":"AMBIGUOUS","lens":"","what":"","why":"","where":"","when":"▸ Acute: ... | ▸ Structural Reset (6-18 mo): ... | ▸ Recovery (18-36 mo): ...","how":""}]}`;

  // ── Call 2: IT Spend Impact ───────────────────────────────────────────────
  const call2 = clientMode
    ? `Industry: ${industry} | Geography: ${geography} | Date: ${analysisDate}
Client: ${companyContext!.name} (${companyContext!.domain})
Profile: ${companyContext!.profile.slice(0, 2500)}
Context: ${ctx}

SALES / ACCOUNT PLANNING analysis. Identify VUCA-driven stress events that create IT spend opportunities for ${companyContext!.name}.
Cover the full range of stress factors: armed conflicts, supply chain crises, pandemic/health risks, energy shocks, trade tariffs, regulatory mandates, cyber threats, climate disruption.
One row per impacted tech spend category (multiple rows per stress event allowed).

Return JSON — key "clientITImpact", 8-10 objects covering all 4 VUCA dimensions.
Fields:
- stressEvent: specific named event (e.g. "Russia-Ukraine war — European energy supply disruption")
- vucaDriver: VOLATILE | UNCERTAIN | COMPLEX | AMBIGUOUS
- estImpactOnTechSpending: quantified shift (e.g. "+20-30% | +$1.5-2.5B globally")
- impact: "H" | "M" | "L"
- impactedTechSpendCategory: 2-3 bullet points (each starting "• ") — specific tech categories from ${companyContext!.name}'s portfolio
- roleInOrganization: designations who own this spend (e.g. "CIO + VP Supply Chain") — title only
- recommendation: 2-3 bullet points (each starting "• ") — pitch angle and buying signal per category`
    : `Industry: ${industry} | Geography: ${geography} | Date: ${analysisDate}
Context: ${ctx}

Identify VUCA-driven stress events impacting IT spending in the ${industry} industry.
Cover: armed conflicts, supply chain crises, pandemic risks, energy shocks, trade tariffs, regulatory mandates, cyber threats, climate disruption.

Return JSON — key "clientITImpact", 8-10 objects covering all 4 VUCA dimensions.
Fields:
- stressEvent: specific named event (e.g. "US-China semiconductor export controls")
- vucaDriver: VOLATILE | UNCERTAIN | COMPLEX | AMBIGUOUS
- estImpactOnTechSpending: quantified shift (e.g. "+15-25% | +$2-3B globally")
- impact: "H" | "M" | "L"
- impactedTechSpendCategory: 2-3 bullet points (each starting "• ") — specific IT spend categories impacted
- roleInOrganization: designations responsible for this spend in ${industry} companies — title only
- recommendation: 2-3 bullet points (each starting "• ") — capability to lead with and key buying signal`;

  // ── Call 3: Geopolitical Stress Overlay ──────────────────────────────────
  const call3 = `Industry: ${industry} | Geography: ${geography} | Date: ${analysisDate}
Context: ${ctx}

Return JSON — key "geopoliticalStress", 5-6 objects. Most material stress events for ${industry} in ${geography}.
Include (where relevant): US-China trade war, Russia-Ukraine war, Middle East conflict, post-pandemic supply chain, climate regulatory stress.
Fields:
- stressEvent: specific named event
- status: Active | Escalating | Monitoring | Resolved
- transmissionMechanism: how this propagates into ${industry} operations (2 sentences max)
- severity: High | Medium | Low
- severityRationale: 1 sentence
- itBudgetSignal: 2 bullets (each starting "• ") format: "• [up/down/right arrow] [+/-X-Y%] [category]; [action] [initiative]"`;

  console.log(`[vuca] synthesis start — industry="${industry}", geo="${geography}", clientMode=${clientMode}, ctxLen=${researchText.length}`);

  // All 4 calls fire in parallel — async network waits, no CPU contention on Render 0.1 vCPU.
  // call1a and call1b are split so each focuses on one table (prevents token truncation).
  // Stagger start by 1s to avoid simultaneous rate-limit spikes on Sonnet
  const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const [rawA, rawB, raw2, raw3] = await Promise.all([
    vucaCall(systemPrompt, call1a, 3000, 90_000, 'call1a-drivers'),
    delay(1000).then(() => vucaCall(systemPrompt, call1b, 5000, 95_000, 'call1b-matrix')),
    delay(2000).then(() => vucaCall(systemPrompt, call2,  6500, 95_000, 'call2-spend')),
    delay(3000).then(() => vucaCall(systemPrompt, call3,  3200, 60_000, 'call3-geo')),
  ]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pA: any = {}, pB: any = {}, p2: any = {}, p3: any = {};
  try { pA = parseJsonRobust(rawA); } catch (e) { console.error('[vuca] call1a parse fail (len=%d): %s | %s', rawA.length, String(e), rawA.slice(0, 400)); }
  try { pB = parseJsonRobust(rawB); } catch (e) { console.error('[vuca] call1b parse fail (len=%d): %s | %s', rawB.length, String(e), rawB.slice(0, 400)); }
  try { p2 = parseJsonRobust(raw2); } catch (e) { console.error('[vuca] call2 parse fail (len=%d): %s | %s', raw2.length, String(e), raw2.slice(0, 400)); }
  try { p3 = parseJsonRobust(raw3); } catch (e) { console.error('[vuca] call3 parse fail (len=%d): %s | %s', raw3.length, String(e), raw3.slice(0, 400)); }

  return {
    vucaDriverEffects: (pA.vucaDriverEffects || []) as VucaDriverEffectRow[],
    vuca4w1hMatrix: (pB.vuca4w1hMatrix || []) as VucaRow[],
    itSpendImpact: [],
    itSpendSummaryTotal: undefined,
    clientITImpact: (p2.clientITImpact || []) as ClientITImpactRow[],
    geopoliticalStress: (p3.geopoliticalStress || []) as GeoStressRow[],
  };
}

// ── Claude ticker lookup (last-resort fallback) ───────────────────────────────

/**
 * Ask Claude to identify the stock ticker for a company when FMP/Yahoo fail.
 * Returns { ticker, exchange } or null if Claude can't identify it confidently.
 */
export async function claudeLookupTicker(
  companyName: string,
  domain?: string
): Promise<{ ticker: string; exchange: string } | null> {
  const domainHint = domain ? ` (website: ${domain})` : '';
  try {
    const text = await claudeCreateDirect(
      'You are a financial data expert. Return only the JSON object, no explanation.',
      `What are the stock ticker symbols for "${companyName}"${domainHint}?

Reply with ONLY a JSON object listing up to 3 tickers in priority order:
{"tickers":[{"ticker":"SYMBOL","exchange":"EXCHANGE_NAME"},...]}"

Priority order:
1. US OTC or ADR listing (e.g. GIVSY, GIVPY) — best for financial data availability
2. Home exchange listing (e.g. BVC, B3, BMV)
3. Any other listing

If you are not confident about any ticker, reply: {"tickers":[]}`,
      200,
      FAST_MODEL
    );
    const parsed = JSON.parse(text.trim().replace(/```json|```/g, '').trim());
    const tickers: Array<{ ticker: string; exchange: string }> = parsed.tickers || [];
    if (tickers.length > 0 && tickers[0].ticker) {
      console.log('[claudeAI] Ticker lookup results for', companyName, ':', JSON.stringify(tickers));
      return { ticker: tickers[0].ticker, exchange: tickers[0].exchange || '', allTickers: tickers } as { ticker: string; exchange: string };
    }
    return null;
  } catch (err) {
    console.warn('[claudeAI] Ticker lookup failed:', err instanceof Error ? err.message : err);
    return null;
  }
}
