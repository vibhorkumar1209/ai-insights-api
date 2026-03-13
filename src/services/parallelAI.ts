import fetch from 'node-fetch';
import { Competitor } from '../types';

const BASE_URL = 'https://api.parallel.ai';
const TASK_POLL_INTERVAL_MS = 4000;
const TASK_TIMEOUT_MS = 180000; // 3 minutes — base processor typically 30-90s, allow headroom

function headers() {
  return {
    'Content-Type': 'application/json',
    'x-api-key': process.env.PARALLEL_API_KEY || '',
  };
}

async function createTask(input: string, processor: 'base' | 'ultra' = 'base'): Promise<string> {
  const res = await fetch(`${BASE_URL}/v1/tasks/runs`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ input, processor }),
  });

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

    // Check status first (lightweight)
    const statusRes = await fetch(`${BASE_URL}/v1/tasks/runs/${runId}`, {
      headers: headers(),
    });

    if (!statusRes.ok) {
      throw new Error(`Parallel.AI poll failed (${statusRes.status})`);
    }

    const statusData = (await statusRes.json()) as { status: string; is_active: boolean };

    if (statusData.status === 'failed') {
      throw new Error('Parallel.AI task failed');
    }

    if (statusData.status === 'completed' || !statusData.is_active) {
      // Fetch the actual result from the /result endpoint
      const resultRes = await fetch(`${BASE_URL}/v1/tasks/runs/${runId}/result`, {
        headers: headers(),
      });

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

      return text;
    }
  }

  throw new Error('Parallel.AI task timed out after 3 minutes');
}

async function runResearch(query: string, processor: 'base' | 'ultra' = 'base'): Promise<string> {
  const runId = await createTask(query, processor);
  return pollTask(runId);
}


// ── Competitor Discovery ─────────────────────────────────────────────────────

export async function discoverCompetitors(
  targetCompany: string,
  industryContext: string
): Promise<Competitor[]> {
  const query = `
Research and identify the top 8-10 direct competitors of "${targetCompany}" in the ${industryContext} industry.

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
  industryContext: string
): Promise<string> {
  const query = `
Conduct detailed research on "${companyName}" for a competitive benchmarking analysis against "${targetCompany}" in the ${industryContext} sector.

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
  industryContext: string
): Promise<Record<string, string>> {
  const results: Record<string, string> = {};

  // Run all research tasks in parallel (max 5 companies)
  const tasks = companies.slice(0, 5).map(async (company) => {
    const research = await researchCompany(company, targetCompany, industryContext);
    results[company] = research;
  });

  await Promise.all(tasks);
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
