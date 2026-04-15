import fetch from 'node-fetch';
import { Competitor } from '../types';

const BASE_URL = 'https://api.parallel.ai';
const TASK_POLL_INTERVAL_MS = 4000;
const TASK_TIMEOUT_MS = 90000;  // 90 seconds — fail fast to free memory
const MAX_RETRIES = 0;          // no retry — saves memory on Render free tier

// ── node-fetch v2 compatible timeout helper ────────────────────────────────────
// AbortSignal.timeout() is Node 17.3+ / native fetch only — not supported by
// node-fetch v2.  Use a manual AbortController + setTimeout instead.
function fetchWithTimeout(
  url: string,
  options: import('node-fetch').RequestInit,
  timeoutMs: number
): Promise<import('node-fetch').Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return fetch(url, { ...options, signal: controller.signal as any }).finally(() => clearTimeout(timer));
}

function headers() {
  return {
    'Content-Type': 'application/json',
    'x-api-key': process.env.PARALLEL_API_KEY || '',
  };
}

async function createTask(input: string, processor: 'base' | 'ultra' = 'base'): Promise<string> {
  // 15 s — this is just a lightweight POST to enqueue the task
  const res = await fetchWithTimeout(`${BASE_URL}/v1/tasks/runs`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ input, processor }),
  }, 15_000);

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Parallel.AI task creation failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as { run_id: string };
  return data.run_id;
}

// The status endpoint: GET /v1/tasks/runs/{run_id}
// The result endpoint:  GET /v1/tasks/runs/{run_id}/result
// Output lives at: result.output.content.output (string)
async function pollTask(runId: string): Promise<string> {
  const deadline = Date.now() + TASK_TIMEOUT_MS;

  while (Date.now() < deadline) {
    await sleep(TASK_POLL_INTERVAL_MS);

    // Check status first (lightweight) — 20 s per poll call
    const statusRes = await fetchWithTimeout(
      `${BASE_URL}/v1/tasks/runs/${runId}`,
      { headers: headers() },
      20_000
    );

    if (!statusRes.ok) {
      throw new Error(`Parallel.AI poll failed (${statusRes.status})`);
    }

    const statusData = (await statusRes.json()) as { status: string; is_active: boolean };

    if (statusData.status === 'failed') {
      throw new Error('Parallel.AI task failed');
    }

    if (statusData.status === 'completed' || !statusData.is_active) {
      // Fetch the actual result from the /result endpoint — 30 s (result payload can be large)
      const resultRes = await fetchWithTimeout(
        `${BASE_URL}/v1/tasks/runs/${runId}/result`,
        { headers: headers() },
        30_000
      );

      if (!resultRes.ok) {
        throw new Error(`Parallel.AI result fetch failed (${resultRes.status})`);
      }

      const resultData = (await resultRes.json()) as {
        output?: { content?: { output?: string } | string };
      };

      // Extract text: output.content.output (string) or output.content (string)
      const content = resultData?.output?.content;
      const text =
        (typeof content === 'object' && content !== null ? content.output : undefined) ||
        (typeof content === 'string' ? content : '') ||
        '';

      // Hard cap raw response to 25KB to prevent OOM on Render free (512MB)
      return text.length > 25_000 ? text.slice(0, 25_000) + '\n[truncated]' : text;
    }
  }

  throw new Error('Parallel.AI task timed out after 5 minutes');
}

async function runResearch(query: string, processor: 'base' | 'ultra' = 'base'): Promise<string> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const runId = await createTask(query, processor);
      return await pollTask(runId);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const isTimeout = lastError.message.includes('timed out');
      if (isTimeout && attempt < MAX_RETRIES) {
        console.warn(`[parallelAI] Attempt ${attempt + 1} timed out — retrying...`);
        continue;
      }
      throw lastError;
    }
  }
  throw lastError!;
}


// ── Competitor Discovery ─────────────────────────────────────────────────────

export async function discoverCompetitors(
  targetCompany: string,
  industryContext?: string
): Promise<Competitor[]> {
  const industryLine = industryContext
    ? `in the ${industryContext} industry`
    : `(first determine the primary industry/sector that "${targetCompany}" operates in, then identify competitors within that space)`;

  const query = `
Research and identify the top 8-10 direct competitors of "${targetCompany}" ${industryLine}.

For each competitor provide:
1. Company name (exact legal or commonly known name)
2. One-sentence business description
3. Headquarters country/city
4. Estimated annual revenue (USD)
5. Approximate employee count
6. Why they are a direct competitor to ${targetCompany} (relevance score 1-10)

Format your response as a JSON array like this:
[
  {
    "name": "Company Name",
    "description": "What they do",
    "headquarters": "City, Country",
    "estimatedRevenue": "$X billion",
    "employees": "~X,000",
    "relevanceScore": 8
  }
]

Only include direct competitors — companies competing for the same customers, contracts, or market segments as ${targetCompany}. Prioritize companies with publicly available technology/digital strategy information.
`.trim();

  const raw = await runResearch(query, 'base');
  return parseCompetitors(raw);
}

function parseCompetitors(raw: string): Competitor[] {
  try {
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (Array.isArray(parsed)) {
        return parsed.filter((c) => c.name && c.description).slice(0, 10);
      }
    }
  } catch {
    // fall through to manual parse
  }

  // Fallback: extract names from plain text
  const lines = raw.split('\n').filter((l) => l.trim());
  const competitors: Competitor[] = [];
  let current: Partial<Competitor> | null = null;

  for (const line of lines) {
    const nameMatch = line.match(/^\d+[.)]\s+(.+?)(?:\s[-–]\s|$)/);
    if (nameMatch) {
      if (current?.name) competitors.push(current as Competitor);
      current = { name: nameMatch[1].trim(), description: '', relevanceScore: 7 };
    } else if (current && line.length > 20) {
      current.description = current.description
        ? current.description
        : line.trim().replace(/^[-–•]\s*/, '');
    }
  }
  if (current?.name) competitors.push(current as Competitor);

  return competitors.slice(0, 10);
}

// ── Company Profile Research ─────────────────────────────────────────────────

export async function researchCompany(
  companyName: string,
  targetCompany: string,
  industryContext?: string
): Promise<string> {
  const sectorLine = industryContext
    ? `in the ${industryContext} sector`
    : '(determine the relevant industry sector from the companies involved)';
  const query = `
Conduct detailed research on "${companyName}" for a competitive benchmarking analysis against "${targetCompany}" ${sectorLine}.

Research and report on the following dimensions. For each, cite the specific source (press release, annual report, earnings call, job postings, news article):

1. ERP & Core IT Stack
   - Which ERP system(s) do they use? (SAP, Oracle, Microsoft, custom?)
   - Cloud vs. on-premise? Any recent migrations?
   - Key technology partners

2. Digital Commerce & Customer Platform
   - Do they have ecommerce or self-service portal capabilities?
   - Any marketplace or B2B digital ordering?
   - Customer-facing digital products

3. AI / ML & Automation Investments
   - Named AI initiatives or vendor partnerships (Microsoft, Salesforce, etc.)
   - Deployed automation tools (RPA, intelligent document processing, etc.)
   - AI hiring signals from job postings

4. Estimated Annual IT Spend
   - IT spend as % of revenue (use Gartner/IDC benchmarks for the sector if not disclosed)
   - Any disclosed technology investments, CAPEX for digital transformation
   - Note if spend was suppressed (restructuring, bankruptcy) or elevated (post-IPO, digital transformation)

5. Stated IT Priority / Focus Area
   - What technology themes dominate their public messaging?
   - CEO/CIO public statements on tech priorities
   - Recent conference presentations

6. Financial Overview
   - Revenue (most recent year)
   - Employee count
   - Recent major events (acquisitions, restructuring, new contracts)

Cite every claim with a source. State "Not publicly disclosed" for any unavailable information.
`.trim();

  return runResearch(query, 'base');
}

// ── Parallel company research ────────────────────────────────────────────────

export async function researchAllCompanies(
  companies: string[],
  targetCompany: string,
  industryContext?: string
): Promise<Record<string, string>> {
  const results: Record<string, string> = {};

  // Sequential (not parallel) to stay within Render free 512MB RAM limit
  for (const company of companies.slice(0, 5)) {
    results[company] = await researchCompany(company, targetCompany, industryContext);
  }
  return results;
}

// ── Themes Research ───────────────────────────────────────────────────────────

export async function researchCompanyThemes(
  companyName: string,
  themeType: 'business' | 'technology' | 'sustainability'
): Promise<string> {
  const queries: Record<string, string> = {
    business: `
Research the strategic business priorities and growth initiatives of "${companyName}" for 2024-2025.

Report on the following areas, citing specific sources (annual reports, earnings calls, investor days, press releases, news):
1. Revenue growth strategy and key markets or geographies being pursued
2. M&A, strategic partnerships and alliance activity
3. Major operational transformation or restructuring programmes
4. Customer experience, go-to-market and commercial model changes
5. Workforce strategy, talent priorities and organisational changes
6. Risk management, regulatory or compliance focus areas
7. Capital allocation and investment priorities
8. Key executive statements on strategic direction (CEO/CFO/COO)

State "Not publicly disclosed" for anything unavailable. Cite every factual claim.
`.trim(),

    technology: `
Research the technology strategy and digital transformation priorities of "${companyName}" for 2024-2025.

Report on the following areas, citing specific sources (annual reports, CIO interviews, conference presentations, job postings, vendor press releases):
1. Digital transformation programmes and key initiatives underway
2. Cloud strategy — providers (AWS/Azure/GCP), workloads migrated, multi-cloud approach
3. AI and ML investments — named platforms, vendors, use cases deployed or in development
4. Data and analytics — data platform strategy, BI tools, data governance
5. Cybersecurity — key investments, frameworks, recent incidents or certifications
6. Core systems modernisation — ERP, CRM, SCM upgrades or migrations
7. Automation — RPA, intelligent document processing, workflow automation deployments
8. Technology hiring signals — job postings that reveal planned technology investments

State "Not publicly disclosed" for anything unavailable. Cite every factual claim.
`.trim(),

    sustainability: `
Research the sustainability, ESG and environmental strategy of "${companyName}" for 2024-2025.

Report on the following areas, citing specific sources (sustainability reports, ESG disclosures, press releases, CDP submissions, news):
1. Net Zero and carbon reduction targets — scope 1/2/3, timelines, progress to date
2. Renewable energy commitments and actual percentage of renewables used
3. Supply chain sustainability — supplier standards, traceability, responsible sourcing
4. ESG reporting frameworks adopted (GRI, SASB, TCFD, ISSB, CDP)
5. Circular economy, waste reduction and product lifecycle initiatives
6. Social impact programmes — DEI commitments, community investment, labour standards
7. Water and resource management — targets, reduction programmes
8. Governance — board oversight of ESG, executive pay linked to ESG metrics

State "Not publicly disclosed" for anything unavailable. Cite every factual claim.
`.trim(),
  };

  try {
    return await runResearch(queries[themeType], 'base');
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Research failed';
    return `Research unavailable for ${companyName}: ${msg}`;
  }
}

// ── Challenges & Growth Research ─────────────────────────────────────────────

export async function researchCompanyChallengesGrowth(
  companyName: string
): Promise<string> {
  const query = `
Research the major challenges and key growth opportunities facing "${companyName}" in 2024-2025.

For EACH of the following dimensions, provide specific evidence-based findings — cite earnings calls, analyst reports, news articles, regulatory filings, or industry data:

1. MACROECONOMICS — How do interest rates, inflation, currency movements, GDP trends, and geopolitical factors affect ${companyName}'s business? What macro tailwinds or headwinds are most material?

2. SUPPLY CHAIN & OPERATIONS — What are the key supply constraints, sourcing risks, logistics challenges, or input cost pressures? Where are the operational vulnerabilities and efficiency opportunities?

3. DEMAND & CUSTOMER — What demand trends (volume, mix, geography) are emerging? Are there shifts in customer behaviour, market saturation, or penetration opportunities?

4. REGULATORY & COMPLIANCE — What regulations are pending or recently enacted that create compliance cost or risk? What policy changes (tariffs, ESG mandates, sector-specific rules) are material?

5. PRICING & MARGIN — What are the key pressures on pricing power and gross margin? Where can ${companyName} improve pricing, product mix, or cost efficiency?

6. COMPETITION — Who are the most threatening competitors and why? What market share shifts or new entrant threats are most significant? Where does ${companyName} have competitive moat?

7. TECHNOLOGY & INNOVATION — What technology disruptions threaten the current business model? Where is digital investment creating growth? What AI or automation opportunities exist?

8. TALENT & WORKFORCE — What are the key hiring challenges, skills gaps, or labour cost pressures? Where is talent a competitive advantage or risk?

Cite specific data points, names, and sources throughout. State "Not publicly disclosed" where information is unavailable.
`.trim();

  try {
    return await runResearch(query, 'base');
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Research failed';
    return `Research unavailable for ${companyName}: ${msg}`;
  }
}

// ── Public Company: Full Financial Profile + Public/Private Detection ─────────
// Single comprehensive query — replaces separate ticker-detection + segment calls.
// Returns raw research text that Claude will parse into structured arrays + insights.

export async function researchPublicCompanyFinancials(
  companyName: string,
  domain?: string
): Promise<string> {
  const domainNote = domain ? ` (website: ${domain})` : '';
  const query = `
Research the complete financial profile for "${companyName}"${domainNote} covering all recent fiscal years available (target FY2020–FY2024 where data exists).

SECTION 1 — LISTING STATUS
- Is "${companyName}" publicly traded on a stock exchange, or is it privately held?
- If PUBLIC: state the exact stock ticker symbol, exchange name (NYSE / NASDAQ / LSE / NSE / etc.), and current market capitalisation.
- If PRIVATE: state the ownership structure (PE-backed, VC-backed, founder-owned, bootstrapped, etc.).
- Confirm the listing status by checking investor relations pages, exchange filings, or financial data providers.

SECTION 2 — REVENUE HISTORY (last 3–5 fiscal years)
For EACH year: Fiscal Year label (e.g. FY2023), Total Annual Revenue in USD, Year-over-Year growth %.
Source: annual report, 10-K, earnings release, investor presentation.

SECTION 3 — MARGIN HISTORY (last 3–5 fiscal years)
For EACH year: Fiscal Year, Gross Margin %, Operating Margin %, Net Margin %.

SECTION 4 — INCOME STATEMENT (most recent full fiscal year)
Revenue, Cost of Revenue, Gross Profit, R&D Expenses, SG&A Expenses, Total Operating Expenses, Operating Income (EBIT), Interest Expense, Income Before Tax, Income Tax Expense, Net Income.
Provide both USD amount and % of revenue for key line items.

SECTION 5 — BALANCE SHEET (most recent fiscal year-end)
Cash & Equivalents, Short-term Investments, Accounts Receivable, Inventory, Total Current Assets, Property/Plant/Equipment (net), Total Assets, Accounts Payable, Short-term Debt, Total Current Liabilities, Long-term Debt, Total Liabilities, Total Stockholder Equity.

SECTION 6 — CASH FLOW STATEMENT (most recent full fiscal year)
Net Income, Depreciation & Amortisation, Total Cash from Operating Activities, Capital Expenditures, Total Cash from Investing Activities, Dividends Paid, Net Borrowings, Stock Repurchases, Total Cash from Financing Activities, Net Change in Cash.

SECTION 7 — REVENUE BY BUSINESS SEGMENT (most recent fiscal year)
If the company reports segment data: list each segment/division, its revenue, % of total revenue, and YoY growth if disclosed. If no segment breakdown exists, state "Not disclosed".

SECTION 8 — REVENUE BY GEOGRAPHY / REGION (most recent fiscal year)
List each major region (e.g. Americas, EMEA, APAC, or country-level): revenue, % of total, YoY growth if disclosed. If not disclosed, state so.

SECTION 9 — KEY FINANCIAL METRICS
Latest EPS (basic and diluted), Free Cash Flow, Return on Equity, Debt-to-Equity ratio, Dividend yield (if any).

Cite every figure with: source document name, reporting period, and any currency conversion applied.
For non-US companies, state original currency amounts and USD equivalent using the prevailing exchange rate.
`.trim();

  try {
    return await runResearch(query, 'base');
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Research failed';
    return `Research unavailable for ${companyName}: ${msg}`;
  }
}

// ── Financial Segment & Geo Research (legacy — kept for backwards compat) ─────

export async function researchFinancialSegments(
  companyName: string,
  ticker?: string
): Promise<string> {
  const tickerNote = ticker ? ` (ticker: ${ticker})` : '';
  const query = `
Research the revenue breakdown by business segment/product line AND by geography/region for "${companyName}"${tickerNote} for the most recent fiscal year (FY2023 or FY2024).

1. REVENUE BY SEGMENT / PRODUCT LINE
   - List each major business segment or product line
   - Revenue amount and percentage of total revenue for each
   - Year-over-year growth for each segment if disclosed
   - Source: annual report, 10-K, earnings call, investor presentation

2. REVENUE BY GEOGRAPHY / REGION
   - List each major geographic region (Americas, EMEA, APAC, or country-level if disclosed)
   - Revenue amount and percentage of total revenue for each region
   - Growth rate by region if disclosed
   - Source: annual report, 10-K, earnings call, investor presentation

3. KEY OBSERVATIONS
   - Which segment or region is growing fastest?
   - Any significant mix shifts underway?
   - Any segments being divested, restructured, or exited?

Cite all figures with the source document name and year. State "Not disclosed" for unavailable data.
`.trim();

  try {
    return await runResearch(query, 'base');
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Research failed';
    return `Research unavailable for ${companyName}: ${msg}`;
  }
}

// ── Private Company Research ──────────────────────────────────────────────────

export async function researchPrivateCompany(
  companyName: string,
  domain?: string
): Promise<string> {
  const domainNote = domain ? ` (domain: ${domain})` : '';
  const query = `
Research the financial profile and business intelligence for private company "${companyName}"${domainNote}.

Gather data from Crunchbase, Tracxn, Pitchbook references, LinkedIn, news articles, and press releases:

1. ESTIMATED REVENUE
   - Most recent revenue estimate or ARR (Annual Recurring Revenue for SaaS companies)
   - Revenue range if exact figure is unavailable
   - Source and year of estimate

2. REVENUE GROWTH
   - Estimated year-over-year revenue growth rate
   - Revenue trajectory (accelerating, stable, declining)
   - Key growth drivers

3. PROFITABILITY
   - Estimated EBITDA margin, net margin, or operating margin
   - Whether company is profitable or burning cash
   - Any disclosed profitability milestones

4. FUNDING & VALUATION
   - Funding stage (Seed, Series A/B/C/D, Pre-IPO, PE-backed, bootstrapped)
   - Total funding raised and most recent round amount
   - Most recent valuation (if disclosed)
   - Key investors

5. BUSINESS OVERVIEW
   - Headcount estimate (from LinkedIn or reports)
   - Primary markets and geographies served
   - Business model (SaaS, services, product, marketplace, etc.)
   - Recent major news (acquisitions, partnerships, leadership changes)

Cite all sources with dates. State "Not publicly disclosed" where data is unavailable.
`.trim();

  try {
    return await runResearch(query, 'base');
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Research failed';
    return `Research unavailable for ${companyName}: ${msg}`;
  }
}

// ── Sales Play Context Research ────────────────────────────────────────────────
// Comprehensive competitive intelligence gathering for a sales play.
// Covers: target account landscape, competitor weaknesses, your company's strengths.

export async function researchSalesPlayContext(
  yourCompany: string,
  competitorName: string,
  targetAccount: string,
  targetIndustry: string,
  strategicPriorities?: string[],
  solutionAreas?: string
): Promise<string> {
  const hasPriorities = strategicPriorities && strategicPriorities.length > 0;
  const hasSolutions  = solutionAreas && solutionAreas.trim().length > 0;

  const prioritySection = hasPriorities
    ? `- Target Account's Strategic Priorities (user-supplied):\n${strategicPriorities!.map((p, i) => `${i + 1}. ${p}`).join('\n')}`
    : `- Target Account's Strategic Priorities: NOT PROVIDED — you MUST discover and list 4–5 top strategic IT/digital priorities for ${targetAccount} in SECTION A item 6.`;

  const solutionSection = hasSolutions
    ? `- Selling Company's Key Solution Areas (user-supplied): ${solutionAreas}`
    : `- Selling Company's Key Solution Areas: NOT PROVIDED — you MUST identify and list ${yourCompany}'s key solution portfolio for ${targetIndustry} in SECTION C item 1.`;

  const query = `
Research competitive intelligence for a B2B sales engagement with the following context:
- Selling Company: "${yourCompany}"
- Competitor: "${competitorName}"
- Target Account: "${targetAccount}" (${targetIndustry} industry)
${prioritySection}
${solutionSection}

SECTION A — TARGET ACCOUNT: "${targetAccount}"
1. Technology investments and IT vendor ecosystem: What ERP, CRM, cloud, and AI platforms does ${targetAccount} currently use or has publicly announced plans to adopt?
2. Strategic digital initiatives: What digital transformation, cloud migration, AI adoption, or operational programmes has ${targetAccount} publicly announced (press releases, annual reports, earnings calls)?
3. Known pain points and challenges: What operational, technology, or competitive challenges is ${targetAccount} known to face in the ${targetIndustry} industry?
4. Key technology decision-makers: Who are the CIO, CTO, CDO, or SVP of Digital/IT at ${targetAccount} if publicly documented?
5. Recent technology news: Any significant IT vendor changes, RFPs, or transformation programme announcements in the last 2 years?
${!hasPriorities ? `6. STRATEGIC PRIORITIES DISCOVERY (REQUIRED): Based on ${targetAccount}'s public statements, annual reports, investor presentations, and ${targetIndustry} industry context — identify and list their top 4–5 strategic IT and digital transformation priorities. Format as:
DISCOVERED STRATEGIC PRIORITIES:
1. [Priority name]: [1-sentence explanation]
2. [Priority name]: [1-sentence explanation]
...` : ''}

SECTION B — COMPETITOR: "${competitorName}" in ${targetIndustry}
1. Product gaps and limitations: What specific product features, capabilities, or industry-specific functionality does ${competitorName} lack compared to market expectations in ${targetIndustry}?
2. Customer reviews and complaints: What recurring weaknesses appear in G2, Gartner Peer Insights, TrustRadius, or Forrester Wave reviews of ${competitorName} in ${targetIndustry}?
3. Pricing and commercial issues: What are the known pricing model concerns, licence costs, implementation overruns, or total-cost-of-ownership issues with ${competitorName}?
4. Analyst findings: What have Gartner, Forrester, IDC, or Everest Group flagged as weaknesses or cautions for ${competitorName}?
5. Failed deployments or contract losses: Are there any public cases of ${competitorName} losing contracts, failed implementations, or customer churn in ${targetIndustry}?
6. Support and services quality: What do customers say about ${competitorName}'s post-sale support, implementation quality, or customer success?

SECTION C — "${yourCompany}" STRENGTHS in ${targetIndustry}
1. ${!hasSolutions ? `SOLUTION AREAS DISCOVERY (REQUIRED): Identify and list ${yourCompany}'s key solutions, products, and service areas relevant to ${targetIndustry}. Format as:
DISCOVERED SOLUTION AREAS:
- [Solution/Product Name]: [1-sentence description]
- [Solution/Product Name]: [1-sentence description]
...
Then continue with:` : ''} Industry-specific solutions: What solutions does ${yourCompany} offer specifically for the ${targetIndustry} sector?
2. Published case studies and win stories: What documented client successes does ${yourCompany} have in ${targetIndustry}? Include client names, business challenges, solutions deployed, and measurable outcomes.
3. Technology differentiation: What proprietary technology, AI/ML capabilities, cloud platforms, or patents does ${yourCompany} hold that are relevant to ${targetAccount}'s priorities?
4. Partner ecosystem: What technology partnerships (e.g., Microsoft, AWS, SAP, Salesforce) and SI/advisory partnerships does ${yourCompany} have that are relevant to ${targetIndustry}?
5. Industry recognition: What Gartner Magic Quadrant positions, Forrester Wave rankings, or industry awards has ${yourCompany} received relevant to ${targetIndustry}?
6. Competitive wins: Are there any known instances of ${yourCompany} displacing ${competitorName} or winning against them in ${targetIndustry}?

Provide specific, evidence-based data wherever available. Quote analyst reports and reviews directly where possible. Clearly state when information is not publicly available rather than speculating.
`.trim();

  try {
    return await runResearch(query, 'base');
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Research failed';
    return `Research unavailable for sales play (${yourCompany} vs ${competitorName} at ${targetAccount}): ${msg}`;
  }
}

// ── Key Prospective Buyers Research ──────────────────────────────────────────
// Deep research on senior executives' public statements, interviews, posts,
// annual reports, LinkedIn activity, press releases, YouTube appearances,
// and X/Twitter commentary to surface business focus areas for pitching.

export async function researchKeyBuyers(
  companyName: string,
  domain?: string
): Promise<string> {
  const domainNote = domain ? ` (website: ${domain})` : '';
  const query = `
Research the key senior executives of "${companyName}"${domainNote} and their publicly expressed business priorities, strategic focus areas, and thought leadership.

Your goal is to identify 10-15 insights that a B2B sales team can use to tailor their pitch to specific executives based on their stated priorities.

SOURCES TO RESEARCH (check ALL of these):
1. Company website — leadership page, blog posts, press releases, investor presentations
2. LinkedIn — executive profiles, posts, articles, and activity (CEO, CFO, CTO, CIO, CDO, CMO, COO, SVPs, VPs)
3. Annual reports and quarterly earnings call transcripts — executive commentary
4. Press releases and media interviews — quotes from executives on strategy
5. Conference keynotes and panel appearances — executive presentations (Gartner, CES, Davos, industry events)
6. YouTube — executive interviews, company channel keynotes, fireside chats
7. X (Twitter) — executive posts and commentary on business topics
8. Podcasts — executive guest appearances
9. Testimonials and customer events — executive statements about partnerships or technology

FOR EACH INSIGHT FOUND, provide:
1. EXECUTIVE: Full name, exact job title, and department/function (e.g. "Jane Smith, Chief Technology Officer, Technology")
2. THEME: The strategic business focus area the executive is discussing (e.g. "AI-driven Supply Chain Optimisation", "Cloud-first Digital Transformation", "Sustainability & ESG Reporting")
3. REFERENCE: The EVENT or OCCASION where the executive made this statement (e.g. "Annual General Meeting 2024", "Investor Day Keynote, Nov 2024", "World Economic Forum Panel, Jan 2025", "Q3 FY2025 Earnings Call", "NASSCOM Technology Leadership Forum 2024", "Banking Technology Summit, Feb 2025"). This should be the event/forum/occasion — NOT the publication or website.
4. EXCERPT: The most relevant direct quote from the executive if available, OR a close paraphrase of their key statement. Prefer direct quotes in quotation marks.

IMPORTANT RULES:
- Focus on C-suite and SVP/VP level executives — the decision-makers
- Each insight should surface a different business focus area or angle
- Prioritise recent statements (2024-2025)
- Include the executive's EXACT title as listed on LinkedIn or the company website
- If a direct quote is available, use it verbatim in quotation marks
- Cover a diverse range of themes: technology, operations, growth, sustainability, talent, M&A, innovation, customer experience, cost optimisation, etc.
- If multiple executives speak to the same theme, include both — this shows organisational alignment

Format your response as structured text with clear sections per insight so it can be parsed into a table.
`.trim();

  try {
    return await runResearch(query, 'base');
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Research failed';
    return `Research unavailable for ${companyName}: ${msg}`;
  }
}

// ── Industry Trends Research ─────────────────────────────────────────────────
// Research both business and technology trends affecting an industry segment.

export async function researchIndustryTrends(
  industrySegment: string,
  geography: string = 'Global'
): Promise<string> {
  const isGlobal = !geography || geography === 'Global';

  const geographyExamplesLine = isGlobal
    ? '- Give concrete examples from MULTIPLE GLOBAL REGIONS (Americas, EMEA, APAC)'
    : `- Focus ALL examples specifically on the ${geography} region/market\n- Provide examples from companies, regulations, and market dynamics within ${geography}\n- Include region-specific data points, analyst reports, and regulatory context for ${geography}`;

  const geographyContext = isGlobal
    ? ''
    : `\n\nGEOGRAPHIC FOCUS: ${geography}\nAll trends, data, and examples should be specifically relevant to the ${geography} market. Discuss how global trends manifest specifically in ${geography}.`;

  const query = `
Research the major Business Trends and Technology Trends shaping the "${industrySegment}" industry in 2024-2025.${geographyContext}

PART A — BUSINESS TRENDS
Research trends across ALL of the following dimensions. For each, provide specific data, named examples, and evidence:

1. MACROECONOMY — How do interest rates, inflation, GDP growth, currency shifts, trade policies, and geopolitical tensions affect the ${industrySegment} industry? What macro tailwinds and headwinds are most material?

2. DEMAND — What are the key shifts in demand patterns? Are there new customer segments, geographic markets, or use cases driving growth? What is the growth trajectory of the industry?

3. SUPPLY — What supply-side dynamics are changing? Raw material availability, manufacturing capacity, supply chain restructuring, nearshoring/reshoring trends, logistics evolution?

4. CUSTOMER — How are customer expectations and behaviours changing? What do customers now demand in terms of experience, sustainability, personalisation, and digital engagement?

5. COMPETITION — How is the competitive landscape evolving? New entrants, consolidation via M&A, platform plays, ecosystem strategies, cross-industry disruption?

6. REGULATORY — What regulations are pending or recently enacted? ESG mandates, data privacy, AI governance, trade barriers, sector-specific compliance requirements?

7. PRICING — What pricing model shifts are underway? Subscription vs. one-time, value-based pricing, dynamic pricing, margin compression or expansion trends?

8. OTHER KEY ISSUES — Any other significant business trends not covered above: workforce changes, sustainability pressures, geopolitical supply chain risks, new business models, etc.

PART B — TECHNOLOGY TRENDS
Research BOTH emerging and traditional technology trends:

1. EMERGING TECHNOLOGY TRENDS — Generative AI, AI/ML at scale, edge computing, digital twins, quantum computing readiness, blockchain/Web3, spatial computing, autonomous systems, biotech convergence — whichever are most relevant to ${industrySegment}.

2. TRADITIONAL TECHNOLOGY TRENDS — Cloud migration (multi-cloud, hybrid), ERP modernisation, cybersecurity evolution, data platform consolidation, IoT/IIoT maturity, RPA/intelligent automation scaling, legacy system decommissioning — whichever are most relevant to ${industrySegment}.

FOR EVERY TREND:
- Name the trend clearly
- Describe its impact on the ${industrySegment} industry
- Provide a detailed description with specific data points
${geographyExamplesLine}
- Cite sources: analyst reports (Gartner, Forrester, McKinsey, IDC), industry publications, company announcements, regulatory filings

Provide specific, evidence-based findings. Cite every claim with a source. State "Not publicly disclosed" where data is unavailable.
`.trim();

  try {
    return await runResearch(query, 'base');
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Research failed';
    return `Research unavailable for ${industrySegment} industry trends: ${msg}`;
  }
}

// ── Industry Report Research ────────────────────────────────────────────────
// Runs up to 4 research queries concurrently for a comprehensive industry report.

export async function researchIndustryReport(
  queries: string[],
  onQueryDone?: (completedIdx: number, total: number) => void
): Promise<string[]> {
  // 2 queries max, sequential — keeps peak RSS well under 512 MB
  const limited = queries.slice(0, 2);
  const results: string[] = [];
  for (const [idx, query] of limited.entries()) {
    try {
      results.push(await runResearch(query, 'base'));
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Research failed';
      console.warn(`[parallelAI] Industry report query ${idx + 1} failed: ${msg}`);
      results.push(`Research unavailable for query ${idx + 1}: ${msg}`);
    }
    onQueryDone?.(idx + 1, limited.length);
  }
  return results;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── High Growth Niche Industry Research ──────────────────────────────────────

export async function researchNicheIndustries(
  input: {
    industryVertical: string;
    subSegmentOrTheme?: string;
    geography: string;
    minimumCAGR: string;
    outputMode: string;
    numberOfTopics: number;
    segmentationDepth: string;
    additionalContext?: string;
  }
): Promise<string> {
  const modeLabel =
    input.outputMode === 'white_space' ? 'white-space'
    : input.outputMode === 'bestseller' ? 'bestseller'
    : 'white-space AND bestseller';

  const depthNote = input.segmentationDepth === 'deep'
    ? 'Also include application layer and buyer type as segmentation axes.'
    : '';

  const themeLine = input.subSegmentOrTheme
    ? `\nSub-segment or theme focus: ${input.subSegmentOrTheme}`
    : '';

  const contextLine = input.additionalContext
    ? `\nAdditional context (regulatory signals, M&A, tariffs, emerging tech angles):\n${input.additionalContext.slice(0, 5000)}`
    : '';

  const query = `
You are a senior market intelligence strategist specializing in syndicated research report topic identification, with deep expertise in how firms like MarketsandMarkets, GlobalData, Grand View Research, Global Market Insights, Market Research Future, Wise Guy Reports, IMARC, and Research&Markets select and validate niche high-growth topics.

INDUSTRY VERTICAL: ${input.industryVertical}${themeLine}
GEOGRAPHY FOCUS: ${input.geography}
MINIMUM CAGR THRESHOLD: ≥${input.minimumCAGR}%
OUTPUT MODE: ${modeLabel}
NUMBER OF TOPICS: ${input.numberOfTopics}${contextLine}

Identify ${input.numberOfTopics} ${modeLabel} report topics passing ALL THREE filters:

FILTER 1 — SPECIFICITY: Narrow enough that a buyer would pay $3,000–$5,000 for a standalone report. Generic parent-level topics fail. Must be specific product + specific application + geographic qualifier.

FILTER 2 — GROWTH SIGNAL: Structural CAGR ≥${input.minimumCAGR}% driven by ≥2 megatrends (AI/digitization, decarbonization, demographic shift, reshoring, regulatory tailwinds, platform convergence).

FILTER 3 — SEGMENTABILITY: Segmentable along ≥3 axes (technology type, region, end-use, company type, price tier, etc.). ${depthNote}

For white-space topics: NO major research platform has a standalone report yet, OR coverage is 3+ years old. Justify why this gap exists.
For bestseller topics: mirror highest-selling reports — specific product + specific application + geographic qualifier + near-future forecast window (2025–2032 or similar).

FOR EACH TOPIC provide:
- A specific report title (in the style of MarketsandMarkets / Grand View Research report names)
- Whether it is "white_space" or "bestseller"
- Estimated CAGR range (e.g. "18–22%")
- Base market size estimate (e.g. "$2.4B (2024)")
- White space score (1–10, where 10 = completely uncovered)
- Competition level: none/low/moderate/high
- Primary growth driver: one sentence naming the specific megatrend(s)
- Segmentation axes: 3–5 specific axes
- Verdict: "strong buy", "pursue", or "monitor"
- Rationale: 2 sentences max explaining why this topic qualifies

Cite research platform coverage gaps, analyst reports, and industry data wherever possible. Be extremely specific — avoid generic market names.
`.trim();

  try {
    return await runResearch(query, 'base');
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Research failed';
    return `Research unavailable for niche industry topics: ${msg}`;
  }
}

// ── Marketing Strategy Framework Research ────────────────────────────────────

export async function researchMarketingStrategy(
  industryOrSegment: string,
  framework: string,
  productContext?: string
): Promise<string> {
  const productLine = productContext
    ? `\nPRODUCT/SERVICE CONTEXT:\n${productContext.slice(0, 3000)}`
    : '';

  const frameworkInstructions: Record<string, string> = {
    'BCG Matrix': `Analyse the ${industryOrSegment} industry using the BCG Growth-Share Matrix. Identify products/segments/business units that fall into: Stars (high growth, high share), Cash Cows (low growth, high share), Question Marks (high growth, low share), Dogs (low growth, low share). Provide market growth rates and relative market share data for each.`,
    'SWOT': `Conduct a comprehensive SWOT analysis for operating in the ${industryOrSegment} industry. Identify internal Strengths and Weaknesses, and external Opportunities and Threats. For each item, provide specific evidence, data points, and strategic implications.`,
    'Porters Five Forces': `Analyse the ${industryOrSegment} industry using Porter's Five Forces: (1) Competitive Rivalry — number of competitors, market concentration, differentiation; (2) Threat of New Entrants — barriers to entry, capital requirements, regulation; (3) Threat of Substitutes — alternative solutions, switching costs; (4) Bargaining Power of Buyers — buyer concentration, price sensitivity; (5) Bargaining Power of Suppliers — supplier concentration, input criticality. Rate each force as High/Medium/Low with evidence.`,
    'Ansoff Matrix': `Analyse growth strategies for the ${industryOrSegment} industry using the Ansoff Matrix: (1) Market Penetration — existing products in existing markets; (2) Market Development — existing products in new markets; (3) Product Development — new products in existing markets; (4) Diversification — new products in new markets. Provide specific strategies, examples, and risk assessments for each quadrant.`,
    '4P/7P Marketing Mix': `Analyse the ${industryOrSegment} industry using the 7P Marketing Mix: Product, Price, Place, Promotion, People, Process, Physical Evidence. For each P, provide current industry practices, best-in-class examples, emerging trends, and strategic recommendations.`,
    'AIDA': `Analyse how companies in the ${industryOrSegment} industry can apply the AIDA model: Attention (awareness strategies), Interest (engagement tactics), Desire (value proposition building), Action (conversion optimization). Provide channel-specific strategies, metrics, and best practices for each stage.`,
    'PESTEL': `Conduct a PESTEL analysis of the ${industryOrSegment} industry: Political (regulations, trade policies, government stability), Economic (GDP growth, inflation, exchange rates, industry spending), Social (demographics, cultural trends, workforce shifts), Technological (emerging tech, R&D investment, digital transformation), Environmental (sustainability mandates, climate impact, ESG requirements), Legal (compliance frameworks, IP, data privacy). Cite specific regulations, data points, and trends.`,
    'North Star': `Identify the North Star metric and framework for the ${industryOrSegment} industry. Analyse: the primary value metric that drives long-term success, leading indicators that predict growth, input metrics that teams can directly influence, and how top companies in this industry define and track their North Star. Provide specific metrics, benchmarks, and case studies.`,
    'Flywheel Model': `Design a Flywheel growth model for the ${industryOrSegment} industry. Identify: the core flywheel loop (what creates momentum), key stages/components, how each stage reinforces the next, friction points that slow the flywheel, and strategies to reduce friction and increase momentum. Provide examples from successful companies in this industry.`,
    'Blue Ocean': `Apply Blue Ocean Strategy to the ${industryOrSegment} industry. Analyse: (1) Eliminate — which factors the industry takes for granted should be eliminated; (2) Reduce — which factors should be reduced well below industry standard; (3) Raise — which factors should be raised well above industry standard; (4) Create — which factors should be created that the industry has never offered. Identify uncontested market spaces and value innovation opportunities.`,
    '7S Framework': `Analyse the ${industryOrSegment} industry using McKinsey's 7S Framework: Strategy (competitive positioning), Structure (organizational models), Systems (processes and workflows), Shared Values (culture and mission), Style (leadership approaches), Staff (talent and capabilities), Skills (core competencies). Assess alignment between elements and identify gaps.`,
    'GE-McKinsey Matrix': `Analyse segments within the ${industryOrSegment} industry using the GE-McKinsey 9-Box Matrix. Evaluate each segment on: Industry Attractiveness (market size, growth rate, profitability, competition intensity) and Competitive Strength (market share, brand strength, technology position, margins). Classify segments as Invest/Grow, Hold/Selective, or Harvest/Divest.`,
    'Eisenhower Matrix': `Apply the Eisenhower Priority Matrix to strategic initiatives in the ${industryOrSegment} industry. Classify key strategic actions into: (1) Urgent & Important — do immediately; (2) Important but Not Urgent — schedule/plan; (3) Urgent but Not Important — delegate/automate; (4) Neither — eliminate. Provide specific actionable initiatives for each quadrant.`,
  };

  const frameworkInstruction = frameworkInstructions[framework] || `Analyse the ${industryOrSegment} industry using the ${framework} framework. Provide comprehensive analysis with specific data points, examples, and strategic implications.`;

  const query = `
You are a seasoned McKinsey senior partner conducting a strategic analysis for a Fortune 500 client.${productLine}

INDUSTRY: ${industryOrSegment}
FRAMEWORK: ${framework}

${frameworkInstruction}

FOR EVERY ELEMENT/DIMENSION:
- Provide specific data points, percentages, and market figures
- Name real companies and examples
- Cite analyst reports and industry sources (Gartner, McKinsey, BCG, Bain, Forrester, IDC)
- Rate strategic importance/priority: High/Medium/Low
- Include strategic implications and actionable recommendations

Be thorough, data-driven, and consultancy-grade in your analysis. Avoid generic statements — every insight should be specific and actionable.
`.trim();

  try {
    return await runResearch(query, 'base');
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Research failed';
    return `Research unavailable for ${framework} analysis of ${industryOrSegment}: ${msg}`;
  }
}
