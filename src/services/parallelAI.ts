import fetch from 'node-fetch';
import { Readable } from 'stream';
import { Competitor } from '@ai-insights/types';
import { formatRevenueUSD } from './yahooFinance';

// Returns a natural-language recency instruction to prepend to every research
// query/prompt sent to a search or research engine (Parallel.AI, Gemini grounded
// search), so the engine prioritizes the most current window before falling
// back to older data. Window: Jan 1 of last calendar year through today.
// Kept local to this file (rather than imported from claudeAI.ts's
// getRecencyDirective, which governs the Claude synthesis stage) to avoid a
// circular import — this only needs minimal date logic.
export function getSearchRecencyInstruction(): string {
  const now = new Date();
  const currentYear = now.getFullYear();
  const todayLabel = now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const windowStart = `January 1, ${currentYear - 1}`;
  return `RECENCY PRIORITY: Today's date is ${todayLabel}. First search for and prioritize information, data, events, and examples from ${windowStart} through today (${todayLabel}). Only if insufficient recent information is found, expand the search to the past 2-3 years. Always prefer the most recent verifiable data.\n\n`;
}

// Dynamic "last year-this year" label (e.g. "2025-2026") for inline use in query
// text that used to hardcode a fixed year range like "2024-2025" — those went
// stale the moment the calendar rolled over, silently undermining recency.
function currentYearRangeLabel(): string {
  const year = new Date().getFullYear();
  return `${year - 1}-${year}`;
}

// A strong, leading identity-anchor paragraph for search prompts, built around
// the company's domain when one is supplied. Prior versions of the Firmographic
// search queries only appended a weak parenthetical like `"Croma" (croma.com)`
// after the company name — easy for the model/search engine to treat as an
// afterthought rather than a hard identity constraint. That let "Croma" (the
// Tata-owned Indian electronics retailer) resolve to the unrelated "Croma
// Security Solutions Group plc" (a UK firm) in the Yahoo/Google Finance path;
// the same weak-hint pattern in the Gemini search prompts risked the identical
// failure mode there too, since a plain "(domain)" suffix carries no explicit
// instruction to verify identity or reject a same-named but different company.
// Mirrors the identityAnchor pattern already used in researchCompanyOverview.
function buildDomainIdentityAnchor(companyName: string, domain?: string): string {
  return domain
    ? `COMPANY TO RESEARCH: "${companyName}", operating at the domain ${domain}. This domain is the definitive identifier — company names are frequently shared by multiple unrelated businesses (e.g. a search for "Croma" could surface either the Tata-owned Indian electronics retailer at croma.com or an unrelated company that happens to share the name). Before reporting any figure or fact, confirm you are researching the specific company that operates at ${domain}. If search results surface a different company with the same or a similar name that does NOT operate at ${domain}, discard those results entirely and do not use them — even if that other company's data is more prominent or easier to find.\n\n`
    : `COMPANY TO RESEARCH: "${companyName}" (no domain provided). Company names are frequently shared by multiple unrelated businesses — if this name is ambiguous, prioritize the most prominent/likely company matching any other context given, but do not silently blend data from a differently-named or clearly distinct company.\n\n`;
}

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
${getSearchRecencyInstruction()}Research and identify the top 10 key players (major companies) in the "${industry}" industry.

Focus on companies that are:
- Market leaders by revenue or market share
- Well-known and established in the industry
- Actively operating and relevant as of ${new Date().getFullYear()}

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
${getSearchRecencyInstruction()}Research and identify the top 10 emerging and strategic technologies in the "${industry}" industry as of ${new Date().getFullYear()}.

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
${getSearchRecencyInstruction()}Research and identify the top 10 major segments or subsectors within the "${industry}" industry as of ${new Date().getFullYear()}.

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
${getSearchRecencyInstruction()}Research and identify the top 8-10 direct competitors of "${targetCompany}" ${industryLine}.

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
${getSearchRecencyInstruction()}Conduct detailed research on "${companyName}" for a competitive benchmarking analysis against "${targetCompany}" ${sectorLine}.

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

// ── Google Custom Search JSON API — fallback when Parallel.AI comes up short ──
// A distinct third search backend (separate from Gemini's built-in Google
// Search grounding tool) for cases where Parallel.AI's crawl-based research
// returns thin or empty results for a specific query — most likely for a
// company's careers portal or LinkedIn Jobs page specifically, since those
// are often JS-rendered/paginated in ways a general crawl can miss. Requires
// GOOGLE_API_KEY + GOOGLE_CSE_ID (a Programmable Search Engine ID) to be set;
// no-ops with a warning (same pattern as the Gemini key check below) if
// either is absent, so this stays inert until credentials are configured
// rather than breaking the module.
const GOOGLE_CSE_TIMEOUT_MS = 20_000;

async function runGoogleCustomSearch(query: string): Promise<string> {
  const apiKey = process.env.GOOGLE_API_KEY;
  const cseId = process.env.GOOGLE_CSE_ID;
  if (!apiKey || !cseId) {
    console.warn('GOOGLE_API_KEY/GOOGLE_CSE_ID not set — skipping Google Custom Search fallback');
    return '';
  }

  try {
    const url = `https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${cseId}&q=${encodeURIComponent(query)}&num=10`;
    const res = await fetchWithTimeout(url, {}, GOOGLE_CSE_TIMEOUT_MS);
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.warn(`Google Custom Search failed: ${res.status} — ${errText.slice(0, 200)}`);
      return '';
    }
    const data = await res.json() as { items?: Array<{ title?: string; link?: string; snippet?: string }> };
    const items = data.items || [];
    if (items.length === 0) return '';
    return items
      .map((item) => `${item.title || 'Untitled'}\n${item.snippet || ''}\nURL: ${item.link || ''}`)
      .join('\n\n');
  } catch (err) {
    console.warn('Google Custom Search error:', err instanceof Error ? err.message : err);
    return '';
  }
}

/**
 * Runs a Parallel.AI query, and if the result looks too thin to be useful
 * (empty, or under a length threshold — a rough proxy for "the crawl didn't
 * find the actual page"), falls back to a Google Custom Search query for the
 * same information. Used for IT Jobs' careers-portal and LinkedIn-jobs
 * queries specifically, where Parallel.AI's general-purpose crawl is most
 * likely to come up short on a JS-heavy or paginated jobs listing page.
 */
async function runResearchWithGoogleFallback(query: string, minUsefulLength = 200): Promise<string> {
  const primary = await runResearch(query, 'base').catch(() => '');
  if (primary && primary.trim().length >= minUsefulLength) return primary;
  const fallback = await runGoogleCustomSearch(query).catch(() => '');
  if (!fallback) return primary; // keep whatever thin result Parallel.AI gave, if any
  return primary
    ? `${primary}\n\n[Supplemented via Google Custom Search — Parallel.AI result was insufficient]\n${fallback}`
    : `[Via Google Custom Search — Parallel.AI returned no result]\n${fallback}`;
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
        // temperature: 0 — these lookups (revenue figures, firmographic facts,
        // spend estimates) are meant to be factual extraction, not creative
        // generation. Without this, Gemini's default sampling temperature made
        // the same company query return a different figure/ticker/source on
        // different calls — the root cause of "different users get different
        // results for the same company" in the Firmographic module.
        generationConfig: { temperature: 0 },
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
  latestRevenueRaw?: number;   // raw numeric amount, in native currency units
  revenueYear: string;
  currency?: string;
  yoyGrowth?: number;
  previousRevenue?: string;
  previousRevenueRaw?: number; // raw numeric amount, in native currency units
  previousYear?: string;
  source?: string;             // publication / filing cited
}

function buildRevenuePrompt(companyName: string, domain: string | undefined, isPublic: boolean | undefined, simplified: boolean): string {
  const identityAnchor = buildDomainIdentityAnchor(companyName, domain);
  const scopeHint = isPublic === false
    ? 'This is a privately-held company — look for news coverage, funding announcements, industry reports, or press releases that cite a revenue figure.'
    : 'This is a publicly-traded company — look for its latest annual revenue as reported in its financial statements (10-K / annual report), Yahoo Finance, or Google Finance.';

  // Ask for the raw native-currency number rather than trusting the model to do
  // USD conversion/formatting itself — that step is done deterministically in
  // code afterwards via formatRevenueUSD(), since LLM-formatted USD figures were
  // observed to skip conversion entirely (e.g. returning "₹9.0 Lakh" unconverted).
  const rawAmountRule = `RAW AMOUNT RULE (critical — apply to latestRevenueRaw AND previousRevenueRaw):
- These must be the PLAIN NUMBER in the company's NATIVE reporting currency's base unit (e.g. dollars, rupees, euros) — NOT abbreviated, NOT in millions/billions/lakhs/crore, and NOT converted to USD.
- Example: if revenue is "₹9 Lakh", latestRevenueRaw is 900000 (not 9, not "9L"). If revenue is "$485 million", latestRevenueRaw is 485000000.
- latestRevenue/previousRevenue (the display strings) can be a human-readable figure in the native currency for reference, but latestRevenueRaw/previousRevenueRaw MUST be the precise unabbreviated number.`;

  if (simplified) {
    // Fallback prompt: fewer constraints, in case the structured version made the
    // model over-cautious about qualifying as a "credible" search result. Keeps
    // the identity anchor regardless — a looser prompt is exactly where a wrong-
    // company match is most likely to slip through unchallenged.
    return `${getSearchRecencyInstruction()}${identityAnchor}What was ${companyName}'s latest reported annual revenue? ${scopeHint}

${rawAmountRule}

Reply with ONLY this JSON object, nothing else: {"latestRevenue": "<human-readable figure in native currency>", "latestRevenueRaw": <plain unabbreviated number in native currency, per the rule above>, "revenueYear": "<fiscal year label>", "currency": "<3-letter ISO code of the company's NATIVE reporting currency>", "yoyGrowth": <number or null>, "previousRevenue": "<prior year figure in native currency, or null>", "previousRevenueRaw": <plain unabbreviated number or null>, "previousYear": "<prior fiscal year label or null>", "source": "<where this came from>"}`;
  }

  return `${getSearchRecencyInstruction()}${identityAnchor}Using Google Search, find the latest annual revenue for "${companyName}".

${scopeHint}

${rawAmountRule}

Return ONLY a JSON object (no markdown, no explanation) with this exact shape:
{
  "latestRevenue": "human-readable figure in the company's native currency, e.g. ₹9 Lakh or $485 million",
  "latestRevenueRaw": <plain unabbreviated number in native currency, per the RAW AMOUNT RULE above>,
  "revenueYear": "fiscal year label, e.g. FY2025 or 2025",
  "currency": "3-letter ISO code of the company's NATIVE reporting currency, e.g. INR",
  "yoyGrowth": <number, year-over-year growth percent, or null if unknown>,
  "previousRevenue": "prior year figure in native currency, or null",
  "previousRevenueRaw": <plain unabbreviated number in native currency, or null>,
  "previousYear": "prior fiscal year label, or null",
  "source": "the publication, filing, or site the figure came from"
}

If you cannot find a credible, sourced revenue figure, return exactly: {"latestRevenue": null}`;
}

// Parses a human-readable revenue string (e.g. "₹9.0 Lakh", "$485 million",
// "₹4,020 Cr", "€11.6B") into a plain unabbreviated number, for cases where
// the model didn't supply the requested raw numeric field directly.
const CJK_MAGNITUDE_UNITS: Record<string, number> = {
  // 万/萬 = 10^4, 億/亿 = 10^8, 兆 = 10^12 (Japanese/Chinese)
  '万': 1e4, '萬': 1e4, '億': 1e8, '亿': 1e8, '兆': 1e12,
};

const ASCII_MAGNITUDE_UNITS: Record<string, number> = {
  lakh: 1e5, lac: 1e5,
  crore: 1e7, cr: 1e7,
  thousand: 1e3, k: 1e3,
  million: 1e6, mn: 1e6, m: 1e6,
  billion: 1e9, bn: 1e9, b: 1e9,
  // Compound Indian magnitude phrases (order as commonly written)
  'lakh crore': 1e12, 'lac crore': 1e12,
  'thousand crore': 1e10,
};

function parseNativeRevenueString(value: string | null | undefined): number | null {
  if (!value) return null;
  const cleaned = value.replace(/[,₹$€£¥]/g, '').trim();

  // CJK magnitude units are a single specific character immediately after
  // the number, often directly abutting a currency-name character with no
  // separator (e.g. "50兆円" = 50 trillion yen, where 円 means "yen"). Match
  // only the known magnitude character itself — a greedy run of any CJK
  // character would glom the trailing currency word into the "unit" too
  // ("兆円"), which matches nothing and silently parses as unit-less.
  const cjkMatch = cleaned.match(/(-?\d+(?:\.\d+)?)\s*([万萬億亿兆])/);
  if (cjkMatch) {
    const num = parseFloat(cjkMatch[1]);
    if (!isNaN(num)) return num * CJK_MAGNITUDE_UNITS[cjkMatch[2]];
  }

  // ASCII/romanized units — capture up to two words so compound Indian
  // magnitude phrases ("Lakh Crore" = 1e5 * 1e7 = 1e12, common for
  // large-conglomerate revenue like Mahindra Group's ~₹2 Lakh Crore) are
  // read as a single unit instead of only the first word — previously
  // "₹2 Lakh Crore" silently dropped "Crore" entirely and parsed as literal
  // 2 Lakh (1e5), producing a revenue figure ~1e7x too small ("$2K" instead
  // of "$23.8B").
  const match = cleaned.match(/(-?\d+(?:\.\d+)?)\s*([a-zA-Z]+(?:\s+[a-zA-Z]+)?)?/);
  if (!match) return null;
  const num = parseFloat(match[1]);
  if (isNaN(num)) return null;
  const rawUnit = (match[2] || '').toLowerCase().trim();
  // Try the full two-word capture first (handles compound phrases), then
  // fall back to just its first word (handles the common single-unit case,
  // where the regex may have opportunistically captured a trailing
  // unrelated word like "annually").
  const mult = ASCII_MAGNITUDE_UNITS[rawUnit] ?? ASCII_MAGNITUDE_UNITS[rawUnit.split(/\s+/)[0] || ''] ?? 1;
  return num * mult;
}

// Formats a raw USD amount as "$X,XXXM" — always in millions (per the Spend
// module's display rule), never switching to Billions like formatRevenueUSD.
function formatUSDMillion(raw: number): string {
  const sign = raw < 0 ? '-' : '';
  const millions = Math.abs(raw) / 1e6;
  return `${sign}$${millions.toLocaleString(undefined, { maximumFractionDigits: 1 })}M`;
}

// Currencies that use the lakh/crore (or equivalent regional) numbering
// system, where large company-scale figures are conventionally stated with
// a magnitude unit (Lakh/Crore) rather than as a bare number.
const LAKH_CRORE_CURRENCIES = new Set(['INR', 'NPR', 'PKR', 'BDT', 'LKR']);

/**
 * Flags a parsed native-currency amount as implausible for a real company's
 * annual revenue. Real companies researched via this lookup virtually always
 * report at least several lakh in revenue — a raw value under that threshold
 * almost always means the model stated a bare number without its magnitude
 * unit (e.g. "₹9,971" meant "₹9,971 Crore" — Indian financial tables often
 * state the unit once in a header rather than repeating it per value, and
 * the model dropped that context when quoting the figure). No string parser
 * can recover a magnitude that was never actually stated, so this must be
 * caught as a validity check rather than a parsing fix — the fix for
 * genuinely malformed strings (missing "Crore" suffix, CJK units, etc.) was
 * already made in parseNativeRevenueString; this catches the case where the
 * unit was never present in the source text at all (e.g. Taj Hotels
 * resolving to "$120" instead of ~$1.2B).
 */
function isImplausibleNativeAmount(raw: number, currency: string): boolean {
  if (!LAKH_CRORE_CURRENCIES.has(currency.toUpperCase())) return false;
  return Math.abs(raw) > 0 && Math.abs(raw) < 1e6; // < 10 Lakh
}

function parseGeminiJson<T>(text: string): Partial<T> | null {
  // Strip markdown code fences if present
  const cleaned = text.replace(/```(?:json)?\s*/gi, '').replace(/```\s*$/gm, '').trim();

  // Try direct parse first
  try {
    return JSON.parse(cleaned);
  } catch { /* fall through to regex extraction */ }

  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  try {
    return JSON.parse(jsonMatch[0]);
  } catch {
    return null;
  }
}

export async function geminiRevenueLookup(
  companyName: string,
  domain?: string,
  isPublic?: boolean
): Promise<GeminiRevenueResult | null> {
  for (const simplified of [false, true]) {
    const prompt = buildRevenuePrompt(companyName, domain, isPublic, simplified);
    try {
      const { text } = await runGeminiGroundedSearch(prompt);
      if (!text) {
        console.warn(`[gemini] Revenue lookup for ${companyName} (simplified=${simplified}) returned empty text`);
        continue;
      }

      const parsed = parseGeminiJson<GeminiRevenueResult>(text);
      if (!parsed) {
        console.warn(`[gemini] Revenue lookup for ${companyName} (simplified=${simplified}) — unparseable response: ${text.slice(0, 200)}`);
        continue;
      }
      if (!parsed.latestRevenue) {
        console.warn(`[gemini] Revenue lookup for ${companyName} (simplified=${simplified}) — no revenue found in response`);
        continue;
      }

      // Deterministically reformat to USD per the Firmographic module rule
      // (USD Millions unless >= $1B, native-currency figure in brackets) rather
      // than trusting the model's own USD conversion — it was observed to
      // sometimes skip conversion entirely and return the native figure as-is.
      // Prefer parsing the human-readable string (e.g. "₹1,98,639 Cr") over the
      // model-computed latestRevenueRaw field — stating a figure it already read
      // is far more reliable for an LLM than doing the raw multiplication itself;
      // large Indian-numbering conversions (lakh/crore) were observed to come back
      // off by 10x-1000x when trusting the raw field. Only fall back to the raw
      // field if the string doesn't parse.
      const currency = parsed.currency || 'USD';
      let latestRaw = parseNativeRevenueString(parsed.latestRevenue) ?? (typeof parsed.latestRevenueRaw === 'number' ? parsed.latestRevenueRaw : null);
      let previousRaw = parseNativeRevenueString(parsed.previousRevenue) ?? (typeof parsed.previousRevenueRaw === 'number' ? parsed.previousRevenueRaw : null);

      // Both the string parse AND the model's own raw field can independently
      // land on the same implausibly-small number when the model omits the
      // magnitude unit entirely (see isImplausibleNativeAmount) — discard and
      // retry with the alternate prompt rather than confidently displaying a
      // figure known to be wrong (e.g. "$120" for a hotel chain).
      if (latestRaw != null && isImplausibleNativeAmount(latestRaw, currency)) {
        console.warn(`[gemini] Revenue lookup for ${companyName} (simplified=${simplified}) — implausible raw amount ${latestRaw} ${currency} (likely missing magnitude unit like Crore/Lakh), discarding`);
        latestRaw = null;
      }
      if (previousRaw != null && isImplausibleNativeAmount(previousRaw, currency)) {
        previousRaw = null;
      }
      if (latestRaw == null) {
        continue;
      }

      const latestRevenue = formatRevenueUSD(latestRaw, currency);
      const previousRevenue = previousRaw != null ? formatRevenueUSD(previousRaw, currency) : parsed.previousRevenue || undefined;

      // Compute YoY ourselves from the raw figures above rather than trusting the
      // model's own percentage — same reasoning as the USD reformat above: LLM
      // arithmetic on financial figures is unreliable, and we already have the
      // two numbers needed to compute it exactly. Only fall back to the model's
      // stated yoyGrowth if one of the raw figures didn't parse.
      const computedYoy = latestRaw != null && previousRaw != null && previousRaw !== 0
        ? ((latestRaw - previousRaw) / Math.abs(previousRaw)) * 100
        : undefined;
      const yoyGrowth = computedYoy != null
        ? parseFloat(computedYoy.toFixed(1))
        : (typeof parsed.yoyGrowth === 'number' ? parsed.yoyGrowth : undefined);

      return {
        latestRevenue,
        latestRevenueRaw: latestRaw ?? undefined,
        revenueYear: parsed.revenueYear || '',
        currency: parsed.currency || undefined,
        yoyGrowth,
        previousRevenue,
        previousRevenueRaw: previousRaw ?? undefined,
        previousYear: parsed.previousYear || undefined,
        source: parsed.source || undefined,
      };
    } catch (err) {
      console.warn(`[gemini] Revenue lookup failed for ${companyName} (simplified=${simplified}):`, err instanceof Error ? err.message : err);
    }
  }

  return null;
}

// ── Gemini Google Search grounding — company firmographic profile ────────────

export interface GeminiFirmographicResult {
  foundedYear?: string;
  headquartersCity?: string;
  headquartersState?: string;
  headquartersCountry?: string;
  employeeRange?: string;
  website?: string;
  linkedinUrl?: string;
  source?: string;
}

function buildFirmographicPrompt(companyName: string, domain: string | undefined, simplified: boolean): string {
  const identityAnchor = buildDomainIdentityAnchor(companyName, domain);

  if (simplified) {
    return `${getSearchRecencyInstruction()}${identityAnchor}Look up basic company profile facts for ${companyName}: founding year, headquarters location, employee count, official website, and LinkedIn company page URL.

Reply with ONLY this JSON object, nothing else: {"foundedYear": "<year or null>", "headquartersCity": "<city or null>", "headquartersState": "<state/province or null>", "headquartersCountry": "<country or null>", "employeeRange": "<range or null>", "website": "<url or null>", "linkedinUrl": "<url or null>", "source": "<where this came from>"}`;
  }

  return `${getSearchRecencyInstruction()}${identityAnchor}Using Google Search, find firmographic profile information for "${companyName}".

Look for:
1. Founded year — the year the company was established
2. Headquarters location — city, state/province, and country
3. Employee count — as a range (e.g. "1,001-5,000" or "10,001+") from LinkedIn or the company's own disclosures
4. Official company website URL
5. LinkedIn company page URL (must be a real linkedin.com/company/... URL, not a guess)

Return ONLY a JSON object (no markdown, no explanation) with this exact shape:
{
  "foundedYear": "year, e.g. 1981",
  "headquartersCity": "city name",
  "headquartersState": "state or province, or null if not applicable",
  "headquartersCountry": "country name",
  "employeeRange": "range, e.g. 10,001+",
  "website": "https://...",
  "linkedinUrl": "https://www.linkedin.com/company/...",
  "source": "the publication or site the profile came from"
}

Use null for any field you cannot verify — do not guess or fabricate. If you cannot find the LinkedIn URL with confidence, set "linkedinUrl" to null rather than inventing one.`;
}

export async function geminiFirmographicLookup(
  companyName: string,
  domain?: string
): Promise<GeminiFirmographicResult | null> {
  for (const simplified of [false, true]) {
    const prompt = buildFirmographicPrompt(companyName, domain, simplified);
    try {
      const { text } = await runGeminiGroundedSearch(prompt);
      if (!text) {
        console.warn(`[gemini] Firmographic lookup for ${companyName} (simplified=${simplified}) returned empty text`);
        continue;
      }

      const parsed = parseGeminiJson<GeminiFirmographicResult>(text);
      if (!parsed) {
        console.warn(`[gemini] Firmographic lookup for ${companyName} (simplified=${simplified}) — unparseable response: ${text.slice(0, 200)}`);
        continue;
      }

      // Consider it a success if we got at least one useful field
      const hasAnyField = !!(parsed.foundedYear || parsed.headquartersCity || parsed.employeeRange || parsed.website || parsed.linkedinUrl);
      if (!hasAnyField) {
        console.warn(`[gemini] Firmographic lookup for ${companyName} (simplified=${simplified}) — no fields found`);
        continue;
      }

      return {
        foundedYear: parsed.foundedYear || undefined,
        headquartersCity: parsed.headquartersCity || undefined,
        headquartersState: parsed.headquartersState || undefined,
        headquartersCountry: parsed.headquartersCountry || undefined,
        employeeRange: parsed.employeeRange || undefined,
        website: parsed.website || undefined,
        linkedinUrl: parsed.linkedinUrl || undefined,
        source: parsed.source || undefined,
      };
    } catch (err) {
      console.warn(`[gemini] Firmographic lookup failed for ${companyName} (simplified=${simplified}):`, err instanceof Error ? err.message : err);
    }
  }

  return null;
}

// ── Spend Module — IT / R&D / AI spend research ───────────────────────────────

export interface GeminiSpendLineResult {
  found: boolean;
  value?: string;
  valueRaw?: number;   // plain unabbreviated USD amount (e.g. 19800000000 for $19.8B) — see RAW AMOUNT RULE
  fiscalYear?: string;
  sourceType?: string;
  sourceContext?: string;
}

export interface GeminiSpendResult {
  itSpend: GeminiSpendLineResult;
  rdSpend: GeminiSpendLineResult;
  aiSpend: GeminiSpendLineResult;
}

function buildSpendPrompt(companyName: string, domainHint: string, geoHint: string, industry?: string, revenueUsdMillion?: number): string {
  const identityLine = domainHint || geoHint || industry || revenueUsdMillion != null
    ? `\nCOMPANY IDENTITY: "${companyName}"${domainHint}${geoHint}${industry ? `, operating in the ${industry} industry` : ''}${revenueUsdMillion != null ? ` with annual revenue of approximately $${revenueUsdMillion.toLocaleString()}M` : ''}. Company names are frequently shared by unrelated businesses — verify you are researching the specific company matching this domain/geography/industry/revenue scale before reporting any figure, not a similarly-named company elsewhere. If the company you find has a materially different revenue or industry than stated here, flag that discrepancy in the sourceContext rather than silently reporting mismatched data.\n`
    : '';
  return `${getSearchRecencyInstruction()}You are an expert financial analyst and corporate intelligence researcher. Using Google Search, extract three specific metrics for "${companyName}"${domainHint}${geoHint} for the most recent fiscal year: IT Spend/Budget, R&D Spend/Budget, and AI Spend/Budget.
${identityLine}

CRITICAL CONSTRAINT: You must only report a value if it is explicitly published by the company itself or by a top-tier analyst firm. Do NOT estimate, guess, or extrapolate.

PERMITTED SOURCES:
- Official company disclosures (Annual Reports/10-K, Investor Relations presentations, earnings call transcripts, or senior executive interviews).
- Top-tier analyst firms (e.g., Gartner, IDC, Forrester, Everest Group).

DATA CATEGORIES:
- IT Spend/Budget: Total annual corporate spend on information technology, software, cloud infrastructure, and digital systems.
- R&D Spend/Budget: Total annual expense allocated to Research, Development, and Product Engineering.
- AI Spend/Budget: The specific subset of budget allocated to Artificial Intelligence, Machine Learning, or generative AI initiatives.

RAW AMOUNT RULE (critical — applies whenever found=true): "valueRaw" must be the PLAIN UNABBREVIATED number in US Dollars (not millions, not billions, not any other currency). Example: if IT spend is "$19.8 billion", valueRaw is 19800000000. If a company reports in a non-USD currency, convert to USD at a recent exchange rate before setting valueRaw. "value" can be a human-readable figure for reference (in the currency you found it in), but valueRaw must always be the precise USD number.

Return ONLY a JSON object (no markdown, no explanation) with this exact shape:
{
  "itSpend": { "found": true|false, "value": "<human-readable figure with currency and fiscal year, e.g. '$19.8 billion for FY2026', or omit if not found>", "valueRaw": <plain unabbreviated USD number per the rule above, or omit if not found>, "fiscalYear": "<e.g. FY2026, or omit if not found>", "sourceType": "<'Company Disclosure' OR the exact analyst firm name, or omit if not found>", "sourceContext": "<if found: a 1-2 sentence description or quote of how/where it was reported, proving validity. If NOT found: a brief explanation of how the company bundles this cost under standard accounting, e.g. 'The company does not break out IT spend as a separate line item; it is bundled inside Selling, General, and Administrative (SG&A) expenses.'>" },
  "rdSpend": { same shape as itSpend, for R&D Spend/Budget },
  "aiSpend": { same shape as itSpend, for AI Spend/Budget }
}

If a category is not explicitly reported by a permitted source, set "found": false, omit "value"/"valueRaw"/"fiscalYear"/"sourceType", and use "sourceContext" to explain the accounting treatment. Do NOT fabricate a value under any circumstances.`;
}

export async function geminiSpendLookup(
  companyName: string,
  domain?: string,
  geography?: string,
  industry?: string,
  revenueUsdMillion?: number
): Promise<GeminiSpendResult | null> {
  const domainHint = domain ? ` (${domain})` : '';
  const geoHint = geography ? `, headquartered in ${geography}` : '';
  const prompt = buildSpendPrompt(companyName, domainHint, geoHint, industry, revenueUsdMillion);

  try {
    const { text } = await runGeminiGroundedSearch(prompt);
    if (!text) {
      console.warn(`[gemini] Spend lookup for ${companyName} returned empty text`);
      return null;
    }

    const parsed = parseGeminiJson<GeminiSpendResult>(text);
    if (!parsed || !parsed.itSpend || !parsed.rdSpend || !parsed.aiSpend) {
      console.warn(`[gemini] Spend lookup for ${companyName} — unparseable or incomplete response: ${text.slice(0, 200)}`);
      return null;
    }

    // Deterministically reformat each found value to USD Million/Billion — same
    // pattern as Firmographic revenue: prefer parsing the human-readable string
    // over trusting the model's own raw-number arithmetic, since large-figure
    // conversions were observed to be unreliable when trusted directly.
    const normalize = (line: GeminiSpendLineResult): SpendLineItemInternal => {
      if (!line.found) {
        return { found: false, sourceContext: line.sourceContext };
      }
      const raw = parseNativeRevenueString(line.value) ?? (typeof line.valueRaw === 'number' ? line.valueRaw : null);
      return {
        found: true,
        value: raw != null ? formatUSDMillion(raw) : line.value,
        valueRaw: raw ?? undefined,
        fiscalYear: line.fiscalYear,
        sourceType: line.sourceType,
        sourceContext: line.sourceContext,
      };
    };

    return {
      itSpend: normalize(parsed.itSpend),
      rdSpend: normalize(parsed.rdSpend),
      aiSpend: normalize(parsed.aiSpend),
    };
  } catch (err) {
    console.warn(`[gemini] Spend lookup failed for ${companyName}:`, err instanceof Error ? err.message : err);
    return null;
  }
}

interface SpendLineItemInternal {
  found: boolean;
  value?: string;
  valueRaw?: number;
  fiscalYear?: string;
  sourceType?: string;
  sourceContext?: string;
}

// ── Vendor ↔ Target existing relationship research ───────────────────────────

export async function researchVendorRelationship(
  targetCompany: string,
  vendorName: string,
  industryContext?: string
): Promise<string> {
  const sectorLine = industryContext ? ` in the ${industryContext} sector` : '';

  const prompt = `${getSearchRecencyInstruction()}Using Google Search, determine whether "${vendorName}" already has an existing business relationship, deployment, or implementation at "${targetCompany}"${sectorLine}.

Look for case studies, partnership announcements, press releases, customer references, or deployment evidence.

Summarize what you find in 3-5 sentences, citing specifics (dates, project names, sources) where available. If you find no evidence of an existing relationship, say so explicitly — do not guess or fabricate.`;

  try {
    const { text, sources } = await runGeminiGroundedSearch(prompt);
    if (!text) {
      // Fallback to Parallel.AI if Gemini unavailable or returned nothing
      const fallbackQuery = `${getSearchRecencyInstruction()}"${vendorName}" "${targetCompany}" existing deployment implementation partnership case study${sectorLine}`.trim();
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
${getSearchRecencyInstruction()}Research the strategic business priorities and growth initiatives of "${companyName}" for ${currentYearRangeLabel()}.

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
${getSearchRecencyInstruction()}Research the technology strategy and digital transformation priorities of "${companyName}" for ${currentYearRangeLabel()}.

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
${getSearchRecencyInstruction()}Research the sustainability, ESG and environmental strategy of "${companyName}" for ${currentYearRangeLabel()}.

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
${getSearchRecencyInstruction()}Research the major challenges and key growth opportunities facing "${companyName}"${domain ? ` (website: ${domain})` : ''} in ${currentYearRangeLabel()}.

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
${getSearchRecencyInstruction()}Research the latest annual revenue breakdown for "${companyName}" (ticker: ${ticker}, reporting currency: ${currency}).

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
  const identityAnchor = domain
    ? `COMPANY TO RESEARCH: "${companyName}", operating at the domain ${domain}. This domain is the definitive identifier — company names are frequently shared by multiple unrelated businesses, so before gathering any data, confirm you are researching the company that operates at ${domain} specifically. If search results surface a different company with the same or a similar name that does NOT operate at ${domain}, discard those results entirely and do not use them.\n\n`
    : `COMPANY TO RESEARCH: "${companyName}" (no domain provided — if this name is ambiguous or shared by multiple companies, state that explicitly rather than blending data from unrelated companies).\n\n`;
  const domainNote = domain ? ` (domain: ${domain})` : '';
  const query = `
${getSearchRecencyInstruction()}${identityAnchor}Research the financial profile and business intelligence for private company "${companyName}"${domainNote}.

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
${getSearchRecencyInstruction()}Research the business segments and corporate structure of "${companyName}"${domainNote}.

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
  const identityAnchor = domain
    ? `COMPANY TO RESEARCH: "${companyName}", operating at the domain ${domain}. This domain is the definitive identifier — company names are frequently shared by multiple unrelated businesses, so before gathering any data, confirm you are researching the company that operates at ${domain} specifically. If search results surface a different company with the same or a similar name that does NOT operate at ${domain}, discard those results entirely and do not use them.\n\n`
    : `COMPANY TO RESEARCH: "${companyName}" (no domain provided — if this name is ambiguous or shared by multiple companies, state that explicitly rather than blending data from unrelated companies).\n\n`;
  const domainNote = domain ? ` (website: ${domain})` : '';
  const query = `
${getSearchRecencyInstruction()}${identityAnchor}Research factual, current company-overview data for "${companyName}"${domainNote}.

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

// ── GCC Sales Play Research ──────────────────────────────────────────────────
// GCC Sales Play's synthesis stage (claudeAI.ts synthesizeGccSalesPlayChunk)
// previously had NO live search grounding at all — it called Claude directly
// on training knowledge only, with no google_search/Parallel.AI research step
// feeding it. That meant it could never surface anything genuinely recent
// (a leadership appointment, a new facility, a contract win) unless it
// happened to be in the model's training data — no amount of prompt wording
// about "temporal relevance" or "0-3 year sourcing window" can manufacture a
// fact the model was never trained on. This runs three targeted parallel
// research queries up front and feeds the combined results into every
// synthesis chunk as grounded RESEARCH DATA, the same pattern every other
// research-backed module in this app already uses.
export async function researchGccSalesPlay(input: {
  targetCompany: string;
  targetGeoRegion: string;
  coreIndustrySegment: string;
}): Promise<string> {
  const { targetCompany, targetGeoRegion, coreIndustrySegment } = input;

  // Parallel.AI queries — broad multi-source research crawls.
  const parallelQueries: { label: string; query: string }[] = [
    {
      label: 'GCC/GDC Facility Footprint & Structure',
      query: `${getSearchRecencyInstruction()}Research "${targetCompany}"'s Global Capability Center (GCC) or Global Delivery Center (GDC) facility footprint in ${targetGeoRegion}: which cities have confirmed captive delivery/technology/shared-services centers, approximate headcount per city, which functional domains and project lines (engineering, F&A, customer support, HR, procurement) are staffed at each site, and the legal entity names operating each facility. Cite the publication date and source for every fact found.`,
    },
    {
      label: 'Leadership & Organizational Changes',
      query: `${getSearchRecencyInstruction()}Research recent leadership and organizational changes at "${targetCompany}"'s Global Capability Center (GCC) or Global Delivery Center (GDC) operations in ${targetGeoRegion}. Specifically look for: new executive appointments or hires (CEO, CFO, COO, CTO, CISO, or country/site head roles) at the local GCC entity, leadership departures, org-structure or reporting-line changes, and any named executives currently running the local operation. Cite the publication date and source for every fact found.`,
    },
    {
      label: 'Expansion Signals & Facility Activity',
      query: `${getSearchRecencyInstruction()}Research recent expansion signals for "${targetCompany}" in ${targetGeoRegion} relevant to its Global Capability Center (GCC) or Global Delivery Center (GDC) footprint: new facility openings or expansions, headcount growth announcements, landmark contract wins, capital investment or real estate commitments, acquisitions or divestments touching the region, and government/regulatory empanelments. Cite the publication date and source for every fact found.`,
    },
    {
      label: 'Recent Corporate Developments',
      query: `${getSearchRecencyInstruction()}Research the most recent corporate developments for "${targetCompany}" relevant to its ${coreIndustrySegment} business and overall strategy: recent earnings results, major restructuring, technology or AI strategy announcements, and any developments materially affecting its ${targetGeoRegion} operations. Cite the publication date and source for every fact found.`,
    },
    {
      label: 'Technology Stack & Infrastructure',
      query: `${getSearchRecencyInstruction()}Research "${targetCompany}"'s core technology stack and infrastructure, especially as deployed or developed at its ${targetGeoRegion} Global Capability Center (GCC)/Global Delivery Center (GDC): cloud platforms in use, legacy systems being modernized, AI/ML platforms and tooling, application architecture, and cybersecurity/compliance frameworks. Cite the publication date and source for every fact found.`,
    },
  ];

  // Gemini Google Search grounding — a second, independent live-search
  // engine, run in parallel with Parallel.AI so the research base draws
  // from two distinct grounded-search sources rather than one.
  const geminiQueries: { label: string; query: string }[] = [
    {
      label: 'Gemini — C-Suite & Named Executives',
      query: `${getSearchRecencyInstruction()}Using Google Search, find the current named executives running "${targetCompany}"'s Global Capability Center (GCC) or Global Delivery Center (GDC) operations in ${targetGeoRegion} — CEO, CFO, COO, CTO, CISO, and business-unit leads based locally. For each, give their title, reporting line, functional scope, and the date/source of the most recent confirmation of their role. Prioritize the most recent appointments and organizational changes.`,
    },
    {
      label: 'Gemini — Consulting/Advisory Firm Relationship',
      query: `${getSearchRecencyInstruction()}Using Google Search, find any documented relationship between "${targetCompany}" and major consulting/advisory firms (Deloitte, Accenture, EY, KPMG, PwC, McKinsey, BCG) involving its ${targetGeoRegion} operations — compliance advisory, transformation projects, consortium work, or go-to-market partnerships. Cite the publication date and source for every fact found.`,
    },
  ];

  const [parallelSettled, geminiSettled] = await Promise.all([
    Promise.allSettled(parallelQueries.map((q) => runResearch(q.query, 'base'))),
    Promise.allSettled(geminiQueries.map((q) => runGeminiGroundedSearch(q.query).then((r) => r.text))),
  ]);

  const blocks: string[] = [];
  parallelSettled.forEach((r, idx) => {
    if (r.status === 'fulfilled' && r.value) blocks.push(`=== [Parallel.AI] ${parallelQueries[idx].label} ===\n${r.value}`);
    else console.warn(`[parallelAI] GCC Sales Play Parallel.AI query "${parallelQueries[idx].label}" failed:`, r.status === 'rejected' ? r.reason : 'No data');
  });
  geminiSettled.forEach((r, idx) => {
    if (r.status === 'fulfilled' && r.value) blocks.push(`=== [Gemini] ${geminiQueries[idx].label} ===\n${r.value}`);
    else console.warn(`[parallelAI] GCC Sales Play Gemini query "${geminiQueries[idx].label}" failed:`, r.status === 'rejected' ? r.reason : 'No data');
  });

  return blocks.join('\n\n');
}

// ── Industry Outsourcing Report Research ──────────────────────────────────────
// Same gap as GCC Sales Play had: synthesizeOutsourcingReportChunk called
// Claude directly on training knowledge only, with no live search step at
// all. Runs 7 queries across two independent search engines (5 Parallel.AI +
// 2 Gemini) up front, fed into all 4 synthesis chunks as grounded research —
// same architecture as researchGccSalesPlay above.
export async function researchOutsourcingReport(input: {
  vendorName: string;
  targetIndustry: string;
  geoFocus: string;
  focusTech: string;
  focusSegment: string;
}): Promise<string> {
  const { vendorName, targetIndustry, geoFocus, focusTech, focusSegment } = input;

  const parallelQueries: { label: string; query: string }[] = [
    {
      label: 'Vendor Positioning & Portfolio',
      query: `${getSearchRecencyInstruction()}Research "${vendorName}"'s current product/service portfolio, technology partnerships, and go-to-market positioning relevant to "${focusTech}" and the "${targetIndustry}" industry. Include named alliances, platform integrations, and how the company markets itself in this space. Cite the publication date and source for every fact found.`,
    },
    {
      label: 'Industry Outsourcing Deals & Contracts',
      query: `${getSearchRecencyInstruction()}Research major outsourcing contracts, managed-services deals, and IT/digital transformation engagements (TCV over $25M where disclosed) signed in the "${targetIndustry}" industry, especially involving "${focusSegment}" and "${focusTech}". For each, give the customer, vendor, announcement date, deal description, and contract value if disclosed. Cite the publication date and source for every fact found.`,
    },
    {
      label: 'Competitor Benchmarking',
      query: `${getSearchRecencyInstruction()}Research the top competitors to "${vendorName}" competing for "${targetIndustry}" outsourcing and technology services budgets, particularly around "${focusTech}". For each competitor, give their core strengths, notable recent wins or losses, and how they position against "${vendorName}". Cite the publication date and source for every fact found.`,
    },
    {
      label: 'Key Customer Accounts',
      query: `${getSearchRecencyInstruction()}Research named enterprise accounts in the "${targetIndustry}" industry, prioritizing "${focusSegment}", that have publicly disclosed outsourcing relationships, technology suppliers, or digital transformation initiatives relevant to "${focusTech}". Cite the publication date and source for every fact found.`,
    },
    {
      label: 'Regional Market Dynamics & M&A Activity',
      query: `${getSearchRecencyInstruction()}Research recent business trends, technology trends, regulatory drivers/barriers, and M&A/consolidation activity (mergers, acquisitions, joint ventures, partnerships) in the "${targetIndustry}" industry's technology/outsourcing supplier ecosystem, focused on "${geoFocus}". Cite the publication date and source for every fact found.`,
    },
  ];

  const geminiQueries: { label: string; query: string }[] = [
    {
      label: 'Gemini — Emerging Outsourcing Trends',
      query: `${getSearchRecencyInstruction()}Using Google Search, find the most recent emerging outsourcing and technology-delivery trends affecting the "${targetIndustry}" industry, especially around "${focusTech}". Include named examples of companies adopting these trends and the source/date for each.`,
    },
    {
      label: 'Gemini — Vendor Competitive Capability',
      query: `${getSearchRecencyInstruction()}Using Google Search, find recent (last 3 years) evidence of "${vendorName}"'s capability and track record delivering "${focusTech}"-related services within the "${targetIndustry}" industry — named case studies, press releases, analyst commentary, or customer references. Cite the publication date and source for every fact found.`,
    },
  ];

  const [parallelSettled, geminiSettled] = await Promise.all([
    Promise.allSettled(parallelQueries.map((q) => runResearch(q.query, 'base'))),
    Promise.allSettled(geminiQueries.map((q) => runGeminiGroundedSearch(q.query).then((r) => r.text))),
  ]);

  const blocks: string[] = [];
  parallelSettled.forEach((r, idx) => {
    if (r.status === 'fulfilled' && r.value) blocks.push(`=== [Parallel.AI] ${parallelQueries[idx].label} ===\n${r.value}`);
    else console.warn(`[parallelAI] Outsourcing Report Parallel.AI query "${parallelQueries[idx].label}" failed:`, r.status === 'rejected' ? r.reason : 'No data');
  });
  geminiSettled.forEach((r, idx) => {
    if (r.status === 'fulfilled' && r.value) blocks.push(`=== [Gemini] ${geminiQueries[idx].label} ===\n${r.value}`);
    else console.warn(`[parallelAI] Outsourcing Report Gemini query "${geminiQueries[idx].label}" failed:`, r.status === 'rejected' ? r.reason : 'No data');
  });

  return blocks.join('\n\n');
}

// ── IT Jobs Research ──────────────────────────────────────────────────────────
// OSINT-style crawl of a company's Careers Portal and LinkedIn Jobs page for
// open IT/Software Engineering roles posted in the last 6 months, balanced
// across AMER/APAC/EMEA. Same dual-engine (Gemini + Parallel.AI) architecture
// as researchGccSalesPlay/researchOutsourcingReport — research runs once and
// feeds all 3 region-specific synthesis chunks.
export async function researchItJobs(input: { companyName: string; companyDomain: string; linkedinHandle?: string }): Promise<string> {
  const { companyName, companyDomain, linkedinHandle } = input;
  const identityAnchor = `COMPANY: "${companyName}", operating at the domain ${companyDomain}. This domain is the definitive identifier — confirm every role you report belongs to this specific company's own careers portal or LinkedIn company page, not a similarly-named company.\n\n`;

  // A supplied LinkedIn handle (e.g. "stripe" from linkedin.com/company/stripe)
  // lets the LinkedIn Jobs query target the exact page directly instead of
  // asking the research engine to first guess the handle from the company
  // name — the same kind of precision win the domain anchor already gives
  // the careers-portal query.
  const linkedinJobsUrl = linkedinHandle
    ? `https://www.linkedin.com/company/${linkedinHandle}/jobs/`
    : undefined;
  const linkedinTarget = linkedinJobsUrl
    ? `"${companyName}"'s LinkedIn company jobs page at ${linkedinJobsUrl} specifically`
    : `"${companyName}"'s LinkedIn company jobs page (linkedin.com/company/.../jobs/ — identify the correct company handle first)`;

  // Careers-portal and LinkedIn-jobs queries specifically use the Google
  // Custom Search fallback (see runResearchWithGoogleFallback) since these
  // are the two queries most likely to hit a JS-rendered/paginated page that
  // a general Parallel.AI crawl can come up short on — the region and
  // specialized-domain queries below are broader web research, less tied to
  // one specific page, so they stay on plain Parallel.AI.
  const careersPortalQuery = `${getSearchRecencyInstruction()}${identityAnchor}Research open IT and Software Engineering job postings on "${companyName}"'s official careers portal (likely at or linked from ${companyDomain}). For each role found, extract: exact job title, posting or last-modified date, office location (city, state/province, country), required technical skills/tech stack, and a brief description of the role's focus. Prioritize roles in Core Software Engineering, Cloud & Infrastructure Architecture, Cyber Security/DevSecOps, Data Analytics/AI/ML, and Technical Program Management. Include the exact URL for each listing.`;
  const linkedinJobsQuery = `${getSearchRecencyInstruction()}${identityAnchor}Research open IT and Software Engineering job postings on ${linkedinTarget}. For each role found, extract: exact job title, posting or last-refreshed date, office location (city, state/province, country), required technical skills/tech stack, and a brief description of the role's focus. Prioritize roles in Core Software Engineering, Cloud & Infrastructure Architecture, Cyber Security/DevSecOps, Data Analytics/AI/ML, and Technical Program Management. Include the exact LinkedIn job posting URL for each listing.`;

  const fallbackBackedQueries: { label: string; query: string }[] = [
    { label: 'Careers Portal — IT/Software Engineering Openings', query: careersPortalQuery },
    { label: 'LinkedIn Jobs — IT/Software Engineering Openings', query: linkedinJobsQuery },
  ];

  const parallelOnlyQueries: { label: string; query: string }[] = [
    {
      label: 'AMER Region IT Roles',
      query: `${getSearchRecencyInstruction()}${identityAnchor}Research open IT/Software Engineering job postings at "${companyName}" specifically located in the Americas (AMER) region — United States, Canada, Mexico, Brazil, or other American countries. Include exact posting dates, city/state, required tech skills, and the source URL (careers portal or LinkedIn jobs page) for each listing.`,
    },
    {
      label: 'APAC Region IT Roles',
      query: `${getSearchRecencyInstruction()}${identityAnchor}Research open IT/Software Engineering job postings at "${companyName}" specifically located in the Asia-Pacific (APAC) region — India, Singapore, Japan, Australia, China, or other APAC countries. Include exact posting dates, city/state, required tech skills, and the source URL (careers portal or LinkedIn jobs page) for each listing.`,
    },
    {
      label: 'EMEA Region IT Roles',
      query: `${getSearchRecencyInstruction()}${identityAnchor}Research open IT/Software Engineering job postings at "${companyName}" specifically located in the Europe, Middle East, or Africa (EMEA) region — UK, Germany, France, UAE, South Africa, or other EMEA countries. Include exact posting dates, city/state, required tech skills, and the source URL (careers portal or LinkedIn jobs page) for each listing.`,
    },
  ];

  const geminiQueries: { label: string; query: string }[] = [
    {
      label: 'Gemini — Cyber Security/DevSecOps and Data/AI/ML Roles',
      query: `${getSearchRecencyInstruction()}${identityAnchor}Using Google Search, find open Cyber Security, DevSecOps, Data Analytics, and AI/ML engineering job postings at "${companyName}" (careers portal or LinkedIn jobs page), posted within the last 6 months. Include exact posting dates, office locations (city, state/province, country), required tech skills, and the exact source URL for each listing.`,
    },
    {
      label: 'Gemini — Cloud Infrastructure and Technical Program Management Roles',
      query: `${getSearchRecencyInstruction()}${identityAnchor}Using Google Search, find open Cloud & Infrastructure Architecture and Technical Program Management job postings at "${companyName}" (careers portal or LinkedIn jobs page), posted within the last 6 months. Include exact posting dates, office locations (city, state/province, country), required tech skills, and the exact source URL for each listing.`,
    },
  ];

  const [fallbackSettled, parallelOnlySettled, geminiSettled] = await Promise.all([
    Promise.allSettled(fallbackBackedQueries.map((q) => runResearchWithGoogleFallback(q.query))),
    Promise.allSettled(parallelOnlyQueries.map((q) => runResearch(q.query, 'base'))),
    Promise.allSettled(geminiQueries.map((q) => runGeminiGroundedSearch(q.query).then((r) => r.text))),
  ]);

  const blocks: string[] = [];
  fallbackSettled.forEach((r, idx) => {
    if (r.status === 'fulfilled' && r.value) blocks.push(`=== [Parallel.AI + Google fallback] ${fallbackBackedQueries[idx].label} ===\n${r.value}`);
    else console.warn(`[parallelAI] IT Jobs query "${fallbackBackedQueries[idx].label}" failed:`, r.status === 'rejected' ? r.reason : 'No data');
  });
  parallelOnlySettled.forEach((r, idx) => {
    if (r.status === 'fulfilled' && r.value) blocks.push(`=== [Parallel.AI] ${parallelOnlyQueries[idx].label} ===\n${r.value}`);
    else console.warn(`[parallelAI] IT Jobs Parallel.AI query "${parallelOnlyQueries[idx].label}" failed:`, r.status === 'rejected' ? r.reason : 'No data');
  });
  geminiSettled.forEach((r, idx) => {
    if (r.status === 'fulfilled' && r.value) blocks.push(`=== [Gemini] ${geminiQueries[idx].label} ===\n${r.value}`);
    else console.warn(`[parallelAI] IT Jobs Gemini query "${geminiQueries[idx].label}" failed:`, r.status === 'rejected' ? r.reason : 'No data');
  });

  return blocks.join('\n\n');
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
${getSearchRecencyInstruction()}B2B sales intelligence brief — be concise, bullet points only, max 800 words total.

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
${getSearchRecencyInstruction()}Research the key senior executives of "${companyName}"${domain ? ` (website: ${domain})` : ''} and their publicly expressed business priorities, strategic focus areas, and thought leadership.

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
- Prioritise recent statements (${currentYearRangeLabel()})
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
${getSearchRecencyInstruction()}Research the major Business Trends and Technology Trends shaping the "${industrySegment}" industry in ${currentYearRangeLabel()}.${geographyContext}

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
  // The queries themselves come from Claude's scope-extraction step (see
  // extractScopeWithWizard in claudeAI.ts) and do not carry any recency
  // instruction of their own, so prepend it here before dispatching to the
  // research engine — same treatment as every other query built in this file.
  const settled = await Promise.allSettled(
    limited.map((q) => runResearch(`${getSearchRecencyInstruction()}${q}`, 'base'))
  );
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
${getSearchRecencyInstruction()}You are a senior market intelligence strategist specializing in syndicated research report topic identification, with deep expertise in how firms like MarketsandMarkets, GlobalData, Grand View Research, Global Market Insights, Market Research Future, Wise Guy Reports, IMARC, and Research&Markets select and validate niche high-growth topics.

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
${getSearchRecencyInstruction()}You are a seasoned McKinsey senior partner conducting a strategic analysis for a Fortune 500 client.${productLine}${companyLine}${domainLine}${techLine}${otherLine}

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
      query: `${getSearchRecencyInstruction()}What are the latest strategic insights, frameworks, and reports on "${topic}" in ${geography} from McKinsey, BCG, Bain, Accenture, Oliver Wyman, Kearney, Roland Berger? Include report titles, key findings, statistics, market outlook, strategic recommendations, executive quotes, and URLs from 2022-2025.`,
    },
    {
      label: 'big4-advisory',
      query: `${getSearchRecencyInstruction()}What are Deloitte, PwC, EY, KPMG, IBM Consulting, and Capgemini saying about "${topic}" in ${geography}? Include their published reports, white papers, industry outlooks, transformation studies, digital surveys, and key data points from 2022-2025.`,
    },
    {
      label: 'tech-analysts',
      query: `${getSearchRecencyInstruction()}What are Gartner, Forrester, IDC, Everest Group, HFS Research, and ISG saying about "${topic}" in ${geography}? Include analyst predictions, market forecasts, hype cycles, Wave reports, technology assessments, adoption statistics, and vendor positioning from 2022-2025.`,
    },
    {
      label: 'market-research',
      query: `${getSearchRecencyInstruction()}What are the latest market size, investment trends, startup activity, and economic research findings on "${topic}" in ${geography}? Include reports from CB Insights, PitchBook, World Economic Forum, Oxford Economics, MIT Sloan, HBR, S&P Global — key statistics, growth rates, investment volumes, and strategic outlooks from 2022-2025.`,
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
${getSearchRecencyInstruction()}B2B competitive intelligence for objection handling — bullet points only, max 900 words.

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
