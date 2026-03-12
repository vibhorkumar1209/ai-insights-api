import Anthropic from '@anthropic-ai/sdk';
import { BenchmarkInput, BenchmarkDimension, GapAnalysisRow } from '../types';

// Returns true when a research string contains no real data
function isEmptyResearch(text: string): boolean {
  return !text || text.startsWith('Research unavailable') || text.trim().length < 50;
}

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Token budget for Hobby plan friendliness
const MAX_INPUT_TOKENS = 80000;
const MAX_OUTPUT_TOKENS = 4096;
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

// ── Benchmarking Table Synthesis ─────────────────────────────────────────────

export async function synthesizeBenchmarkingTable(
  input: BenchmarkInput,
  companyResearch: Record<string, string>
): Promise<BenchmarkDimension[]> {
  const safeResearch = truncateResearch(companyResearch);
  const peerNames = input.selectedCompetitors.join(', ');

  // Flag companies with missing research so the prompt can instruct Claude to use training data
  const missingResearch = Object.entries(safeResearch)
    .filter(([, text]) => isEmptyResearch(text))
    .map(([company]) => company);

  const systemPrompt = `You are a senior B2B sales intelligence analyst. You produce precise, evidence-based competitive analysis.
- Where provided research data exists, cite it specifically (systems, vendors, percentages).
- Where research data is missing or sparse for a company, draw on your training knowledge to fill in what is publicly known — label it "(est.)" or "(based on public sources)".
- Never leave a cell empty — always provide a meaningful best-known answer.
- Output ONLY valid JSON. No markdown, no explanation outside the JSON.`;

  const userPrompt = `Synthesize the following research into a structured peer benchmarking table comparing "${input.targetCompany}" against its peers: ${peerNames}.

The selling organization is "${input.userOrganization}". Industry: ${input.industryContext}.
${input.focusAreas ? `Focus areas: ${input.focusAreas}` : ''}
${missingResearch.length > 0 ? `\nNOTE: Research data was unavailable for: ${missingResearch.join(', ')}. Use your training knowledge for these companies.` : ''}

RESEARCH DATA:
${Object.entries(safeResearch)
  .map(([company, research]) => `\n### ${company}\n${isEmptyResearch(research) ? `[No live research — use training knowledge for ${company}]` : research}`)
  .join('\n\n---\n')}

Return a JSON array of benchmarking dimensions. Use EXACTLY this structure:
[
  {
    "dimension": "ERP & Core IT Stack",
    "targetCompany": { "value": "concise summary", "notes": "optional detail or source" },
    "peers": {
      "Competitor1": { "value": "concise summary", "notes": "optional detail or source" },
      "Competitor2": { "value": "concise summary", "notes": "optional detail or source" }
    }
  }
]

Cover ALL 5 dimensions:
1. ERP & Core IT Stack
2. Digital Commerce & Customer Platform
3. AI / ML & Automation Investments
4. Estimated Annual IT Spend
5. Stated IT Priority / Focus Area
${input.focusAreas ? `6. ${input.focusAreas}` : ''}

Keep each value to 1-2 sentences. Be specific — name systems, vendors, percentages where available.`;

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
  const jsonMatch = raw.match(/\[[\s\S]*\]/);
  if (!jsonMatch) throw new Error('Claude did not return valid JSON for benchmarking table');

  const parsed = JSON.parse(jsonMatch[0]);
  if (!Array.isArray(parsed)) throw new Error('Expected array from Claude for benchmarking table');

  return parsed.filter((row) => row.dimension && row.targetCompany && row.peers);
}

// ── Gap Analysis Synthesis ───────────────────────────────────────────────────

export async function synthesizeGapAnalysis(
  input: BenchmarkInput,
  companyResearch: Record<string, string>,
  benchmarkingTable: BenchmarkDimension[]
): Promise<GapAnalysisRow[]> {
  const safeResearch = truncateResearch(companyResearch, 40000);
  const peerNames = input.selectedCompetitors.join(', ');

  const missingResearch2 = Object.entries(safeResearch)
    .filter(([, text]) => isEmptyResearch(text))
    .map(([company]) => company);

  const systemPrompt = `You are a senior B2B sales intelligence analyst. You produce gap analyses that directly enable enterprise sales conversations.
The gap analysis MUST:
- Draw primarily from the benchmarking table already compiled.
- Where research data is missing for a company, use the benchmarking table and your training knowledge.
- Map specific product solutions (not generic capabilities) to each gap.
- Include realistic proof points or industry benchmarks.
- Never leave a field empty — always provide a substantive answer.
Output ONLY valid JSON. No markdown, no explanation outside the JSON.`;

  const userPrompt = `Create a gap analysis and opportunity map for "${input.targetCompany}" vs peers: ${peerNames}.

Selling organization: "${input.userOrganization}"
${input.solutionPortfolio ? `Solution portfolio to map against gaps: ${input.solutionPortfolio}` : ''}
Industry: ${input.industryContext}
${missingResearch2.length > 0 ? `\nNOTE: Live research unavailable for: ${missingResearch2.join(', ')}. Use training knowledge as needed.` : ''}

BENCHMARKING TABLE (primary source — use this first):
${JSON.stringify(benchmarkingTable, null, 2)}

SUPPLEMENTARY RESEARCH DATA:
${Object.entries(safeResearch)
  .map(([company, research]) => `\n### ${company}\n${isEmptyResearch(research) ? `[No live research — use training knowledge for ${company}]` : research.slice(0, 8000)}`)
  .join('\n\n---\n')}

Return a JSON array of gap analysis rows. Use EXACTLY this structure:
[
  {
    "capability": "Capability area name",
    "peersBestPractice": "What the leading peer is doing (name the peer)",
    "targetStatus": "Where ${input.targetCompany} stands today",
    "gapLevel": "RED",
    "gapDetail": "Specific gap or strength explanation",
    "solutionFit": "Specific ${input.userOrganization} product that addresses this gap",
    "proofPoint": "Verified client result, case study metric, or analyst recognition"
  }
]

Gap levels:
- "GREEN" = ${input.targetCompany} leads or is comparable to peers
- "AMBER" = Partial gap, some foundation exists
- "RED" = Critical gap — ${input.targetCompany} materially lags all peers

Cover 6 capability areas:
1. ERP / Core Data Infrastructure
2. Digital Commerce & Customer Experience
3. AI / ML & Intelligent Automation
4. Contract & Process Automation
5. Supply Chain / Operational Execution
6. Scale & Investment Capacity

For each solutionFit, map a specific product from "${input.userOrganization}". If solution portfolio is not provided, use generic capability descriptions.`;

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
  const jsonMatch = raw.match(/\[[\s\S]*\]/);
  if (!jsonMatch) throw new Error('Claude did not return valid JSON for gap analysis');

  const parsed = JSON.parse(jsonMatch[0]);
  if (!Array.isArray(parsed)) throw new Error('Expected array from Claude for gap analysis');

  return parsed.filter((row) => row.capability && row.gapLevel);
}

