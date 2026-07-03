import fetch from 'node-fetch';
import { Readable } from 'stream';
import { Competitor } from '@ai-insights/types';

const BASE_URL = 'https://api.parallel.ai';
const TASK_POLL_INTERVAL_MS = 4000;
const TASK_TIMEOUT_MS = 90000;  // 90 seconds — Render Pro has more headroom
const MAX_RETRIES = 1;          // 1 retry — Render Pro can afford it

// ── node-fetch v2 compatible timeout helper ────────────────────────────────────
// AbortSignal.timeout() is Node 17.3+ / native fetch only — not supported by
// node-fetch v2.  Use a manual AbortController + setTimeout instead.
// Read response body up to maxBytes — stops streaming early to avoid massive RAM spikes.
// Parallel.AI raw responses can be 50-100 MB; we only need the first ~300 KB to parse the JSON wrapper.
async function readBodyLimited(res: import('node-fetch').Response, maxBytes = 300_000, timeoutMs = 25_000): Promise<string> {
  const body = res.body;
  if (!body) return '';

  // Race body reading against a hard timeout — stalled streams hang forever otherwise
  return new Promise<string>((resolve) => {
    const timer = setTimeout(() => {
      try { (body as unknown as { destroy?: () => void }).destroy?.(); } catch { /* ignore */ }
      resolve('');
    }, timeoutMs);

    const chunks: Buffer[] = [];
    let total = 0;

    (body as unknown as Readable)
      .on('data', (raw: unknown) => {
        const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
        const remaining = maxBytes - total;
        if (chunk.length >= remaining) {
          chunks.push(chunk.slice(0, remaining));
          total = maxBytes;
          clearTimeout(timer);
          try { (body as unknown as { destroy?: () => void }).destroy?.(); } catch { /* ignore */ }
          resolve(Buffer.concat(chunks, maxBytes).toString('utf-8'));
        } else {
          chunks.push(chunk);
          total += chunk.length;
        }
      })
      .on('end', () => {
        clearTimeout(timer);
        resolve(Buffer.concat(chunks, total).toString('utf-8'));
      })
      .on('error', () => {
        clearTimeout(timer);
        resolve(Buffer.concat(chunks, total).toString('utf-8'));
      });
  });
}

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

      // Read at most 300 KB — Parallel.AI responses can be 50-100 MB raw.
      // Allocating the full body before truncation was OOM-crashing the 512MB container.
      const rawText = await readBodyLimited(resultRes);
      let resultData: { output?: { content?: { output?: string } | string } };
      try {
        resultData = JSON.parse(rawText);
      } catch {
        // Body was truncated mid-JSON — extract text via regex fallback
        const m = rawText.match(/"output"\s*:\s*"((?:[^"\\]|\\.)*)"/);
        const extracted = m ? m[1].replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\\\/g, '\\') : '';
        return extracted.slice(0, 25_000);
      }

      const content = resultData?.output?.content;
      const text =
        (typeof content === 'object' && content !== null ? content.output : undefined) ||
        (typeof content === 'string' ? content : '') ||
        '';

      return text.length > 25_000 ? text.slice(0, 25_000) + '\n[truncated]' : text;
    }
  }

  throw new Error('Parallel.AI task timed out after 5 minutes');
}

/** Public single-query wrapper used by consultingIntelligenceService */
export async function runResearchQuery(query: string): Promise<string> {
  return runResearch(query, 'base');
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

export async function discoverTopPlayersByIndustry(industry: string): Promise<Competitor[]> {
  const query = `
Research and identify the top 10 key players (major companies) in the "${industry}" industry.

Focus on companies that are:
- Market leaders by revenue or market share
- Well-known and established in the industry
- Actively operating and relevant as of 2025

For each company provide:
1. Company name (exact legal or commonly known name)
2. Headquarters location (City, Country)
3. Estimated annual revenue (USD) — most recent available
4. Relevance/Leadership score (1-10, where 10 is top market leader)

Format your response as a JSON array:
[
  {
    "name": "Company Name",
    "headquarters": "City, Country",
    "estimatedRevenue": "$X billion",
    "relevanceScore": 10
  }
]

Return ONLY the JSON array, no additional text. Ensure 10 companies are returned.
`.trim();

  const raw = await runResearch(query, 'base');
  return parseTopPlayers(raw);
}

export async function discoverEmergingTechnologiesByIndustry(industry: string): Promise<Array<{ name: string; category: string; maturityLevel: string }>> {
  const query = `
Research and identify the top 10 emerging and strategic technologies in the "${industry}" industry as of 2025.

For each technology provide:
1. Technology name
2. Category/domain (e.g., "Artificial Intelligence", "Infrastructure", "Security")
3. Current maturity level: "emerging", "growth", or "mainstream"

Include both cutting-edge technologies just entering the market AND mature technologies becoming strategic. Prioritize technologies that are:
- Actively being adopted by leading companies
- Creating competitive advantage
- Likely to disrupt the industry

Format as JSON array:
[
  {
    "name": "Technology Name",
    "category": "Category",
    "maturityLevel": "growth"
  }
]

Return ONLY the JSON array. Ensure 10 technologies are returned.
`.trim();

  const raw = await runResearch(query, 'base');
  return parseEmergingTechs(raw);
}

function parseEmergingTechs(raw: string): Array<{ name: string; category: string; maturityLevel: string }> {
  try {
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (Array.isArray(parsed)) {
        return parsed
          .filter((t) => t.name && t.category)
          .map((t) => ({
            name: t.name,
            category: t.category,
            maturityLevel: t.maturityLevel || 'growth',
          }))
          .slice(0, 10);
      }
    }
  } catch (e) {
    console.error('[parallelAI] Tech parse error:', e);
  }
  return [];
}

export async function discoverIndustrySegmentsByIndustry(industry: string): Promise<string[]> {
  const query = `
Research and identify the top 10 major segments or subsectors within the "${industry}" industry as of 2025.

Segments should represent distinct business areas, customer types, or value chains within the industry. Examples:
- For banking: Retail Banking, Corporate Banking, Investment Banking, Wealth Management, etc.
- For automotive: Electric Vehicles, Autonomous Driving, Manufacturing, Supply Chain, etc.

For each segment provide the name only.

Format as JSON array:
[
  "Segment Name 1",
  "Segment Name 2"
]

Return ONLY the JSON array. Ensure 10 segments are returned.
`.trim();

  const raw = await runResearch(query, 'base');
  return parseSegments(raw);
}

function parseSegments(raw: string): string[] {
  try {
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (Array.isArray(parsed)) {
        return parsed
          .filter((s) => typeof s === 'string' && s.trim().length > 0)
          .map((s) => s.trim())
          .slice(0, 10);
      }
    }
  } catch (e) {
    console.error('[parallelAI] Segment parse error:', e);
  }
  return [];
}

function parseTopPlayers(raw: string): Competitor[] {
  try {
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (Array.isArray(parsed)) {
        return parsed
          .filter((c) => c.name && c.headquarters)
          .map((c) => ({
            name: c.name,
            headquarters: c.headquarters,
            estimatedRevenue: c.estimatedRevenue || 'N/A',
            relevanceScore: c.relevanceScore || 8,
            description: `Leading player in the industry`,
          }))
          .slice(0, 10);
      }
    }
  } catch (e) {
    console.error('[parallelAI] JSON parse error:', e);
  }
  return [];
}

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

// ── Gemini Google Search grounding — vendor ↔ target relationship ────────────

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const GEMINI_SEARCH_MODEL = 'gemini-2.5-flash';
const GEMINI_TIMEOUT_MS = 45_000;

interface GeminiGroundingSource {
  title: string;
  uri: string;
}

async function runGeminiGroundedSearch(prompt: string): Promise<{ text: string; sources: GeminiGroundingSource[] }> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn('GEMINI_API_KEY not set — skipping Gemini grounded search');
    return { text: '', sources: [] };
  }

  const res = await fetchWithTimeout(
    `${GEMINI_BASE}/models/${GEMINI_SEARCH_MODEL}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        tools: [{ google_search: {} }],
      }),
    },
    GEMINI_TIMEOUT_MS
  );

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    console.warn(`Gemini search failed: ${res.status} — ${errText.slice(0, 200)}`);
    return { text: '', sources: [] };
  }

  const bodyText = await readBodyLimited(res, 300_000, 20_000);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let data: any;
  try {
    data = JSON.parse(bodyText);
  } catch {
    return { text: '', sources: [] };
  }

  const candidate = data?.candidates?.[0];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const text = ((candidate?.content?.parts || []) as any[]).map((p) => p.text || '').join('').trim();
  const chunks = candidate?.groundingMetadata?.groundingChunks || [];
  const sources: GeminiGroundingSource[] = (chunks as Record<string, unknown>[])
    .map((c) => c.web as Record<string, unknown> | undefined)
    .filter((w): w is Record<string, unknown> => !!w?.uri)
    .map((w) => ({ title: String(w.title || w.uri), uri: String(w.uri) }));

  return { text, sources };
}

// ── Gemini url_context — fetch a company's own webpage directly ──────────────

async function fetchCompanyWebpage(domain: string): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn('GEMINI_API_KEY not set — skipping company webpage fetch');
    return '';
  }

  const url = domain.startsWith('http') ? domain : `https://${domain}`;
  const prompt = `Fetch the page at ${url} (and its "About Us" / "Who We Are" page if linked from it) and summarize, in your own words, what the company does: its products/services, business lines, target customers, and scale. Use only what is actually on the page — do not add outside knowledge.`;

  try {
    const res = await fetchWithTimeout(
      `${GEMINI_BASE}/models/${GEMINI_SEARCH_MODEL}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          tools: [{ url_context: {} }],
        }),
      },
      GEMINI_TIMEOUT_MS
    );

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.warn(`Gemini url_context fetch failed: ${res.status} — ${errText.slice(0, 200)}`);
      return '';
    }

    const bodyText = await readBodyLimited(res, 300_000, 20_000);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let data: any;
    try {
      data = JSON.parse(bodyText);
    } catch {
      return '';
    }

    const candidate = data?.candidates?.[0];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const text = ((candidate?.content?.parts || []) as any[]).map((p) => p.text || '').join('').trim();
    return text;
  } catch (err) {
    console.warn('Gemini url_context fetch threw:', err);
    return '';
  }
}

// ── Gemini Google Search grounding — company revenue lookup ──────────────────

export interface GeminiRevenueResult {
  latestRevenue: string;       // formatted, e.g. "$94.83B"
  revenueYear: string;
  currency?: string;
  yoyGrowth?: number;
  previousRevenue?: string;
  previousYear?: string;
  source?: string;             // publication / filing cited
}

export async function geminiRevenueLookup(
  companyName: string,
  domain?: string,
  isPublic?: boolean
): Promise<GeminiRevenueResult | null> {
  const domainHint = domain ? ` (${domain})` : '';
  const scopeHint = isPublic === false
    ? 'This is a PRIVATE company — search news, funding announcements, industry reports, and press coverage for credible revenue estimates.'
    : 'Search Google Finance, Yahoo Finance, the company\'s investor relations page, and its most recent annual report / 10-K filing.';

  const prompt = `Using Google Search, find the latest annual revenue for "${companyName}"${domainHint}.

${scopeHint}

Return ONLY a JSON object (no markdown, no explanation) with this exact shape:
{
  "latestRevenue": "formatted figure with currency symbol, e.g. $94.83B or ₹1,20,000 Cr",
  "revenueYear": "fiscal year label, e.g. FY2025 or 2025",
  "currency": "3-letter ISO code, e.g. USD",
  "yoyGrowth": <number, year-over-year growth percent, or null if unknown>,
  "previousRevenue": "prior year formatted figure, or null",
  "previousYear": "prior fiscal year label, or null",
  "source": "the publication, filing, or site the figure came from"
}

If you cannot find a credible, sourced revenue figure, return exactly: {"latestRevenue": null}`;

  try {
    const { text } = await runGeminiGroundedSearch(prompt);
    if (!text) return null;

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]) as Partial<GeminiRevenueResult>;
    if (!parsed.latestRevenue) return null;

    return {
      latestRevenue: parsed.latestRevenue,
      revenueYear: parsed.revenueYear || '',
      currency: parsed.currency || undefined,
      yoyGrowth: typeof parsed.yoyGrowth === 'number' ? parsed.yoyGrowth : undefined,
      previousRevenue: parsed.previousRevenue || undefined,
      previousYear: parsed.previousYear || undefined,
      source: parsed.source || undefined,
    };
  } catch (err) {
    console.warn(`[gemini] Revenue lookup failed for ${companyName}:`, err instanceof Error ? err.message : err);
    return null;
  }
}

// ── Vendor ↔ Target existing relationship research ───────────────────────────

export async function researchVendorRelationship(
  targetCompany: string,
  vendorName: string,
  industryContext?: string
): Promise<string> {
  const sectorLine = industryContext ? ` in the ${industryContext} sector` : '';

  const prompt = `Using Google Search, determine whether "${vendorName}" already has an existing business relationship, deployment, or implementation at "${targetCompany}"${sectorLine}.

Look for case studies, partnership announcements, press releases, customer references, or deployment evidence.

Summarize what you find in 3-5 sentences, citing specifics (dates, project names, sources) where available. If you find no evidence of an existing relationship, say so explicitly — do not guess or fabricate.`;

  try {
    const { text, sources } = await runGeminiGroundedSearch(prompt);
    if (!text) {
      // Fallback to Parallel.AI if Gemini unavailable or returned nothing
      const fallbackQuery = `"${vendorName}" "${targetCompany}" existing deployment implementation partnership case study${sectorLine}`.trim();
      return runResearch(fallbackQuery, 'base');
    }
    const sourceLines = sources
      .slice(0, 8)
      .map((s, i) => `${i + 1}. ${s.title}\n   ${s.uri}`)
      .join('\n');
    return `Gemini Google Search grounding for "${vendorName}" + "${targetCompany}":\n\n${text}${sourceLines ? `\n\nSOURCES:\n${sourceLines}` : ''}`;
  } catch (err) {
    console.warn('Gemini vendor relationship search failed:', err);
    const fallbackQuery = `"${vendorName}" "${targetCompany}" existing deployment implementation partnership case study${sectorLine}`.trim();
    return runResearch(fallbackQuery, 'base');
  }
}

// ── Parallel company research ────────────────────────────────────────────────

export async function researchAllCompanies(
  companies: string[],
  targetCompany: string,
  industryContext?: string
): Promise<Record<string, string>> {
  const results: Record<string, string> = {};

  const entries = await Promise.all(
    companies.slice(0, 5).map(async (company) => {
      const text = await researchCompany(company, targetCompany, industryContext).catch((e) => {
        console.warn(`[parallelAI] researchAllCompanies failed for ${company}:`, e.message);
        return `Research unavailable for ${company}`;
      });
      return [company, text] as const;
    })
  );
  for (const [company, text] of entries) results[company] = text;
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
  companyName: string,
  domain?: string
): Promise<string> {
  const domainLine = domain
    ? `IMPORTANT: The company is identified by its website domain "${domain}". Research ONLY this specific company — do NOT confuse it with other companies that share a similar name. Start your research from ${domain}.`
    : '';
  const query = `
Research the major challenges and key growth opportunities facing "${companyName}"${domain ? ` (website: ${domain})` : ''} in 2024-2025.

${domainLine}

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


// ── Public Company Segment & Geographic Revenue Research ────────────────────
// Called when FMP has no segment/geo data (common for non-US listed companies)

export async function researchCompanySegments(
  companyName: string,
  ticker: string,
  currency: string
): Promise<string> {
  const query = `
Research the latest annual revenue breakdown for "${companyName}" (ticker: ${ticker}, reporting currency: ${currency}).

Find and report:
1. REVENUE BY BUSINESS SEGMENT — list each segment with:
   - Segment name (official name from annual report)
   - Revenue amount in ${currency}
   - % of total revenue
   - YoY growth %
   Source: most recent annual report or investor presentation

2. REVENUE BY GEOGRAPHY — list each region/country with:
   - Region name
   - Revenue amount in ${currency}
   - % of total revenue
   - YoY growth %
   Source: most recent annual report or investor presentation

Use the company's official annual report, earnings release, or investor day presentation as the primary source.
State the fiscal year this data is from.
Do NOT invent or estimate figures — only report what is officially disclosed.
`.trim();

  return runResearch(query, 'base');
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

// ── Business Segments Research ───────────────────────────────────────────────

export async function researchBusinessSegments(
  companyName: string,
  domain?: string
): Promise<string> {
  const domainNote = domain ? ` (website: ${domain})` : '';
  const query = `
Research the business segments and corporate structure of "${companyName}"${domainNote}.

Report on the following using annual reports, 10-K filings, investor presentations, and press releases:

1. BUSINESS SEGMENTS
   - Official segment names as reported in annual filings
   - Revenue contribution per segment (% of total or absolute)
   - What each segment sells, to whom, and in which geographies
   - Source (e.g., "10-K 2024", "Investor Day 2025")

2. RECENT STRATEGIC EVOLUTION
   - Major acquisitions, divestitures, or new business launches (last 5 years)
   - Any segment reorganisations, rebrands, or portfolio reshaping
   - Strategic pivots or business model changes

3. COMPETITIVE POSITION PER SEGMENT
   - Key competitors for each major segment
   - Any segment where the company is a market leader or follower

Cite every claim with a source and year. State "Not publicly disclosed" where data is unavailable.
`.trim();

  try {
    return await runResearch(query, 'base');
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Research failed';
    return `Research unavailable for ${companyName}: ${msg}`;
  }
}

// ── Business Description Research ────────────────────────────────────────────

export async function researchCompanyOverview(
  companyName: string,
  domain?: string
): Promise<string> {
  const domainNote = domain ? ` (website: ${domain})` : '';
  const query = `
Research factual, current company-overview data for "${companyName}"${domainNote}.

Report on the following, citing the source and year for each fact:

1. CORE BUSINESS — what the company actually sells, to whom (industries/customer types), and how it makes money. Name ALL primary lines of business or service lines exactly as the company itself names them (e.g. for a professional services firm, list every line such as audit/assurance, tax, and advisory — do not omit any).

2. INDUSTRY AND MARKETS — primary industry classification and the main countries/regions where it operates or generates revenue.

3. SCALE — most recent disclosed figures: annual revenue, employee/headcount count, number of countries/offices, founding year if notable.

4. COMPETITIVE POSITION — 1-2 named direct competitors and how this company is differentiated from them (avoid vague claims; cite something concrete like market share, ranking, or a named capability).

Do NOT include marketing taglines, mission statements, or "purpose" slogans (e.g. avoid phrasing like "build trust in society" or "solve important problems") — only verifiable operating facts. State "Not publicly disclosed" for anything unavailable. Cite every numeric claim with a source and year.
`.trim();

  const [parallelResult, webpageResult] = await Promise.allSettled([
    runResearch(query, 'base'),
    domain ? fetchCompanyWebpage(domain) : Promise.resolve(''),
  ]);

  const parallelText = parallelResult.status === 'fulfilled' ? parallelResult.value : '';
  const webpageText = webpageResult.status === 'fulfilled' ? webpageResult.value : '';

  if (!parallelText && !webpageText) {
    const reason = parallelResult.status === 'rejected'
      ? (parallelResult.reason instanceof Error ? parallelResult.reason.message : 'Research failed')
      : 'No data found';
    return `Research unavailable for ${companyName}: ${reason}`;
  }

  return [
    webpageText ? `=== Company's own website (${domain}) ===\n${webpageText}` : '',
    parallelText ? `=== Web research ===\n${parallelText}` : '',
  ].filter(Boolean).join('\n\n');
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
B2B sales intelligence brief — be concise, bullet points only, max 800 words total.

Context: ${yourCompany} selling to ${targetAccount} (${targetIndustry}), displacing ${competitorName}.
${prioritySection}
${solutionSection}

A) ${targetAccount}: Current tech stack, top 3 digital initiatives, key IT decision-makers, known pain points.
${!hasPriorities ? `Also list DISCOVERED STRATEGIC PRIORITIES (4-5 items, labeled exactly that way).` : ''}

B) ${competitorName} weaknesses in ${targetIndustry}: Product gaps, G2/Gartner complaints, pricing issues, failed deals.

C) ${yourCompany} strengths: ${!hasSolutions ? `DISCOVERED SOLUTION AREAS (labeled exactly that way), then:` : ''} 2-3 case studies in ${targetIndustry} with outcomes, key tech differentiators vs ${competitorName}, relevant partnerships.

Be specific and evidence-based. Skip anything not publicly documented.
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
  const domainLine = domain
    ? `IMPORTANT: The company is identified by its website domain "${domain}". Research ONLY this specific company — do NOT confuse it with other companies that share a similar name. Start your research from ${domain}.`
    : '';
  const query = `
Research the key senior executives of "${companyName}"${domain ? ` (website: ${domain})` : ''} and their publicly expressed business priorities, strategic focus areas, and thought leadership.

${domainLine}

Your goal is to identify 10-15 insights that a B2B sales team can use to tailor their pitch to specific executives based on their stated priorities.

SOURCES TO RESEARCH (check ALL of these):
1. Company website (${domain || 'company website'}) — leadership page, blog posts, press releases, investor presentations
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
  const limited = queries.slice(0, 4);
  const settled = await Promise.allSettled(limited.map((q) => runResearch(q, 'base')));
  const results = settled.map((r, idx) => {
    if (r.status === 'fulfilled') {
      onQueryDone?.(idx + 1, limited.length);
      return r.value;
    }
    const msg = r.reason instanceof Error ? r.reason.message : 'Research failed';
    console.warn(`[parallelAI] Industry report query ${idx + 1} failed: ${msg}`);
    onQueryDone?.(idx + 1, limited.length);
    return `Research unavailable for query ${idx + 1}: ${msg}`;
  });
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
  productContext?: string,
  companyName?: string,
  companyDomain?: string,
  focusTech?: string,
  otherContext?: string
): Promise<string> {
  const productLine = productContext
    ? `\nPRODUCT/SERVICE CONTEXT:\n${productContext.slice(0, 3000)}`
    : '';

  const frameworkInstructions: Record<string, string> = {
    'BCG Matrix': `Analyse the ${industryOrSegment} industry using the BCG Growth-Share Matrix. Identify products/segments/business units that fall into: Stars (high growth, high share), Cash Cows (low growth, high share), Question Marks (high growth, low share), Dogs (low growth, low share). Provide market growth rates and relative market share data for each.`,
    'SWOT': `Conduct a comprehensive SWOT analysis for operating in the ${industryOrSegment} industry. Identify internal Strengths and Weaknesses, and external Opportunities and Threats. For each item, provide specific evidence, data points, and strategic implications.`,
    'Porters Five Forces': `Analyse the ${industryOrSegment} industry using Porter's Five Forces: (1) Competitive Rivalry — number of competitors, market concentration, differentiation; (2) Threat of New Entrants — barriers to entry, capital requirements, regulation; (3) Threat of Substitutes — alternative solutions, switching costs; (4) Bargaining Power of Customers — customer concentration, price sensitivity; (5) Bargaining Power of Suppliers — supplier concentration, input criticality. Rate each force as High/Medium/Low with evidence.`,
    'Ansoff Matrix': `Analyse growth strategies for the ${industryOrSegment} industry using the Ansoff Matrix: (1) Market Penetration — existing products in existing markets; (2) Market Development — existing products in new markets; (3) Product Development — new products in existing markets; (4) Diversification — new products in new markets. Provide specific strategies, examples, and risk assessments for each quadrant.`,
    '4P and 7P Marketing Mix': `Analyse the ${industryOrSegment} industry using the 4P and 7P Marketing Mix: Product, Price, Place, Promotion (core 4Ps) and People, Process, Physical Evidence (extended 7Ps). For each P, provide current industry practices, best-in-class examples, emerging trends, and strategic recommendations.`,
    'AIDA': `Analyse how companies in the ${industryOrSegment} industry can apply the AIDA model: Attention (awareness strategies), Interest (engagement tactics), Desire (value proposition building), Action (conversion optimization). Provide channel-specific strategies, metrics, and best practices for each stage.`,
    'PESTEL': `Conduct a PESTEL analysis of the ${industryOrSegment} industry: Political (regulations, trade policies, government stability), Economic (GDP growth, inflation, exchange rates, industry spending), Social (demographics, cultural trends, workforce shifts), Technological (emerging tech, R&D investment, digital transformation), Environmental (sustainability mandates, climate impact, ESG requirements), Legal (compliance frameworks, IP, data privacy). Cite specific regulations, data points, and trends.`,
    'North Star': `Identify the North Star metric and framework for the ${industryOrSegment} industry. Analyse: the primary value metric that drives long-term success, leading indicators that predict growth, input metrics that teams can directly influence, and how top companies in this industry define and track their North Star. Provide specific metrics, benchmarks, and case studies.`,
    'Flywheel Model': `Design a Flywheel growth model for the ${industryOrSegment} industry. Identify: the core flywheel loop (what creates momentum), key stages/components, how each stage reinforces the next, friction points that slow the flywheel, and strategies to reduce friction and increase momentum. Provide examples from successful companies in this industry.`,
    'Blue Ocean': `Apply Blue Ocean Strategy to the ${industryOrSegment} industry. Analyse: (1) Eliminate — which factors the industry takes for granted should be eliminated; (2) Reduce — which factors should be reduced well below industry standard; (3) Raise — which factors should be raised well above industry standard; (4) Create — which factors should be created that the industry has never offered. Identify uncontested market spaces and value innovation opportunities.`,
    '7S Framework': `Analyse the ${industryOrSegment} industry using McKinsey's 7S Framework: Strategy (competitive positioning), Structure (organizational models), Systems (processes and workflows), Shared Values (culture and mission), Style (leadership approaches), Staff (talent and capabilities), Skills (core competencies). Assess alignment between elements and identify gaps.`,
    'GE-McKinsey Matrix': `Analyse segments within the ${industryOrSegment} industry using the GE-McKinsey 9-Box Matrix. Evaluate each segment on: Industry Attractiveness (market size, growth rate, profitability, competition intensity) and Competitive Strength (market share, brand strength, technology position, margins). Classify segments as Invest and Grow, Hold and Selective, or Harvest and Divest.`,
    'Eisenhower Matrix': `Apply the Eisenhower Priority Matrix to strategic initiatives in the ${industryOrSegment} industry. Classify key strategic actions into: (1) Urgent and Important — do immediately; (2) Important but Not Urgent — schedule and plan; (3) Urgent but Not Important — delegate and automate; (4) Neither — eliminate. Provide specific actionable initiatives for each quadrant.`,
  };

  const frameworkInstruction = frameworkInstructions[framework] || `Analyse the ${industryOrSegment} industry using the ${framework} framework. Provide comprehensive analysis with specific data points, examples, and strategic implications.`;

  const companyLine   = companyName   ? `\nCOMPANY: ${companyName}` : '';
  const domainLine    = companyDomain ? `\nCOMPANY WEBSITE: ${companyDomain}` : '';
  const techLine      = focusTech     ? `\nFOCUS TECHNOLOGY: ${focusTech}` : '';
  const otherLine     = otherContext  ? `\nADDITIONAL CONTEXT: ${otherContext.slice(0, 2000)}` : '';
  const companyFocus  = companyName
    ? `Focus the analysis specifically on how ${companyName} can apply this framework, using the company's known positioning and offerings.`
    : '';
  const techFocus     = focusTech
    ? `Give particular emphasis to ${focusTech} technology and its strategic implications within each dimension.`
    : '';

  const query = `
You are a seasoned McKinsey senior partner conducting a strategic analysis for a Fortune 500 client.${productLine}${companyLine}${domainLine}${techLine}${otherLine}

INDUSTRY: ${industryOrSegment}
FRAMEWORK: ${framework}
${companyFocus ? `\n${companyFocus}` : ''}${techFocus ? `\n${techFocus}` : ''}

${frameworkInstruction}

FOR EVERY ELEMENT/DIMENSION:
- Provide specific data points, percentages, and market figures
- Name real companies and examples${companyName ? ` — include ${companyName} where relevant` : ''}
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

// ── Consulting Intelligence: Discovery + Per-firm Deep Research ───────────────

/**
 * Broad discovery query — finds which firms have published thought leadership
 * on the topic. Returns raw text listing firms, reports, themes.
 */
/**
 * Returns 4 rich topic-focused research blobs covering different firm clusters.
 * Topic-centric queries perform far better in Parallel.AI than firm-centric ones.
 */
export async function researchConsultingTLTopicBatches(
  topic: string,
  geography: string
): Promise<Array<{ label: string; rawText: string }>> {
  const queries = [
    {
      label: 'strategy-consulting',
      query: `What are the latest strategic insights, frameworks, and reports on "${topic}" in ${geography} from McKinsey, BCG, Bain, Accenture, Oliver Wyman, Kearney, Roland Berger? Include report titles, key findings, statistics, market outlook, strategic recommendations, executive quotes, and URLs from 2022-2025.`,
    },
    {
      label: 'big4-advisory',
      query: `What are Deloitte, PwC, EY, KPMG, IBM Consulting, and Capgemini saying about "${topic}" in ${geography}? Include their published reports, white papers, industry outlooks, transformation studies, digital surveys, and key data points from 2022-2025.`,
    },
    {
      label: 'tech-analysts',
      query: `What are Gartner, Forrester, IDC, Everest Group, HFS Research, and ISG saying about "${topic}" in ${geography}? Include analyst predictions, market forecasts, hype cycles, Wave reports, technology assessments, adoption statistics, and vendor positioning from 2022-2025.`,
    },
    {
      label: 'market-research',
      query: `What are the latest market size, investment trends, startup activity, and economic research findings on "${topic}" in ${geography}? Include reports from CB Insights, PitchBook, World Economic Forum, Oxford Economics, MIT Sloan, HBR, S&P Global — key statistics, growth rates, investment volumes, and strategic outlooks from 2022-2025.`,
    },
  ];

  const results = await Promise.all(
    queries.map(async ({ label, query }) => {
      try {
        const rawText = await runResearch(query, 'base');
        return { label, rawText: rawText.slice(0, 15000) };
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Research failed';
        return { label, rawText: `Research batch "${label}" failed: ${msg}` };
      }
    })
  );

  return results;
}

// ── Objection Handling Research ───────────────────────────────────────────────

export async function researchObjectionHandling(
  yourCompany: string,
  competitorName: string,
  targetAccount: string,
  targetIndustry: string,
  isIncumbent: boolean,
  competitorWeaknesses?: string
): Promise<string> {
  const incumbentLine = isIncumbent
    ? `CRITICAL: ${competitorName} is already DEPLOYED at ${targetAccount}. Focus heavily on switching cost drivers, migration complexity, and political/contractual lock-in risks.`
    : `${competitorName} is being evaluated against ${yourCompany} (not yet deployed).`;

  const weaknessLine = competitorWeaknesses?.trim()
    ? `Known ${competitorName} weaknesses: ${competitorWeaknesses}`
    : '';

  const query = `
B2B competitive intelligence for objection handling — bullet points only, max 900 words.

Context: ${yourCompany} displacing ${competitorName} at ${targetAccount} (${targetIndustry}).
${incumbentLine}
${weaknessLine}

A) ${competitorName} weaknesses in ${targetIndustry}: G2/Gartner reviews, Glassdoor R&D red flags, pricing complaints, support issues, product gaps, failed deals or public criticism.

B) ${yourCompany} vs ${competitorName} head-to-head: Key differentiators, areas where ${yourCompany} wins on capability, TCO, support, industry fit. Include any analyst rankings.

C) ${targetAccount} context: Known vendor relationships, IT budget signals, digital transformation priorities, risk appetite, key decision-maker profiles.

D) Common objections heard in ${targetIndustry} displacement deals and what rebuttals work.

${isIncumbent ? `E) Incumbent displacement specifics: switching cost estimates, migration success stories from ${targetIndustry}, contractual flexibility signals, change-management playbooks that worked.` : ''}

Be specific, cite sources where possible, skip anything unverified.
`.trim();

  try {
    return await runResearch(query, 'base');
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Research failed';
    return `Research unavailable (${yourCompany} vs ${competitorName} at ${targetAccount}): ${msg}`;
  }
}
