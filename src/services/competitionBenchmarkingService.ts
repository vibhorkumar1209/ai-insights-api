import { v4 as uuidv4 } from 'uuid';
import {
  CompetitionBenchmarkingInput, CompetitionBenchmarkingResult,
  CompetitorSelection, ResearchDossier, EntityResearch, ResearchCategory,
  FinancialsFact, LeadershipFact, ProductNameFact, MarketShareFact, TechProofPointFact,
  BenchmarkingSection,
} from '@ai-insights/types';
import { runGeminiGroundedJSON } from './parallelAI';
import { claudeCreateDirect } from './claudeAI';

// Two model providers used deliberately, not interchangeably: Gemini's
// google_search grounding tool does every fact lookup (it returns verified,
// dated, sourced answers in one call — exactly what this report type needs);
// Claude does the writing/structuring, working ONLY from what Gemini already
// verified. Claude must never originate a fact on its own — see the shared
// system prompt below.
const SYNTHESIS_MODEL = 'claude-sonnet-4-6'; // matches this codebase's standard model everywhere else

// ── In-memory job store — same pattern as every other module in this app ────

const jobs = new Map<string, CompetitionBenchmarkingResult>();
const JOB_TTL_MS = 2 * 60 * 60 * 1000;

setInterval(() => {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs.entries()) {
    if (new Date(job.createdAt).getTime() < cutoff) jobs.delete(id);
  }
}, 30 * 60 * 1000);

type SSECallback = (event: string, data: unknown) => void;
const subscribers = new Map<string, SSECallback[]>();

export function subscribeToJob(jobId: string, cb: SSECallback): void {
  const list = subscribers.get(jobId) || [];
  list.push(cb);
  subscribers.set(jobId, list);
}

export function unsubscribeFromJob(jobId: string, cb: SSECallback): void {
  const list = (subscribers.get(jobId) || []).filter((c) => c !== cb);
  if (list.length > 0) subscribers.set(jobId, list);
  else subscribers.delete(jobId);
}

function emit(jobId: string, event: string, data: unknown): void {
  (subscribers.get(jobId) || []).forEach((cb) => cb(event, data));
}

function update(jobId: string, patch: Partial<CompetitionBenchmarkingResult>): CompetitionBenchmarkingResult {
  const current = jobs.get(jobId)!;
  const updated = { ...current, ...patch };
  jobs.set(jobId, updated);
  return updated;
}

export function createCompetitionBenchmarkingJob(input: CompetitionBenchmarkingInput): string {
  const jobId = uuidv4();
  jobs.set(jobId, {
    jobId,
    status: 'pending',
    progress: 0,
    input,
    createdAt: new Date().toISOString(),
  });
  return jobId;
}

export function getCompetitionBenchmarkingJob(jobId: string): CompetitionBenchmarkingResult | undefined {
  return jobs.get(jobId);
}

// ── Bounded concurrency — up to 30 Gemini calls fan out per report, capped
// at 6 concurrent per the spec's 5-8 recommendation ───────────────────────

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function withRetry<T>(fn: () => Promise<T>, attempts = 2): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 1000 * 2 ** i)); // exponential backoff
    }
  }
  throw lastErr;
}

// ── Step A: competitor selection (only if the user didn't supply a list) ────

async function selectCompetitors(input: CompetitionBenchmarkingInput): Promise<CompetitorSelection | null> {
  const prompt = `You are a market-intelligence researcher. Using current, credible sources (analyst firms such as Synergy Research, Gartner, IDC, ISG, Forrester, or reputable trade press aggregating the same), identify the 5 largest named competitors to "${input.userFirm}" in the following market:

Market: ${input.userDomain}
${input.focusSegment ? `Focus segment: ${input.focusSegment}\n` : ''}${input.geoFocus ? `Geography: ${input.geoFocus}\n` : ''}
Exclude ${input.userFirm} itself. Prefer a competitor set that is genuinely comparable in business model and customer segment, not simply the largest companies in an adjacent market.

Return strict JSON:
{
  "competitors": [{ "name": string, "rationale": string }],
  "rankingSource": string,
  "rankingSourceUrl": string,
  "rankingPeriod": string,
  "asOf": string
}
Return exactly 5 competitors. Return ONLY the JSON object, no markdown fencing.`;

  const result = await withRetry(() => runGeminiGroundedJSON<CompetitorSelection>(prompt, 'selectCompetitors'));
  if (!result?.competitors || result.competitors.length === 0) return null;
  return {
    competitors: result.competitors.slice(0, 5),
    rankingSource: result.rankingSource || 'Not specified by source',
    rankingSourceUrl: result.rankingSourceUrl || '',
    rankingPeriod: result.rankingPeriod || 'Not specified',
    asOf: result.asOf || new Date().toISOString(),
  };
}

// ── Step B: research fan-out ─────────────────────────────────────────────────

const CATEGORY_INSTRUCTIONS: Record<ResearchCategory, string> = {
  financials: `Find the two most recently reported full fiscal years of revenue for the relevant business line (whole-company if no segment focus was given below; segment-specific otherwise). For each year return fiscalYearEnd (date), revenue (formatted string with currency), yoyGrowth (percent, if determinable), and the source. Return JSON: {"financials": [{"fiscalYearEnd": string, "revenue": string, "yoyGrowth": number|null, "verified": true, "source": string}]}`,
  leadership: `Find the current CEO (name, title, and the date you verified this). If a second role is clearly relevant to a delivery-heavy business, include it too. If a leadership change happened within roughly the last 18 months, explicitly state who preceded the current person and when the change occurred. Return JSON: {"leadership": [{"name": string, "title": string, "verifiedDate": string, "verified": true, "source": string, "changeFlag": {"changedFrom": string, "changedTo": string, "date": string} | null}]}`,
  productNames: `Find any named, currently-active proprietary platform or brand relevant to the technology focus given below (or, if none given, to general AI/technology positioning). If none can be confirmed, return an empty array — do not guess a name. Return JSON: {"productNames": [{"name": string, "description": string, "verified": true, "source": string}]}`,
  marketShare: `Find the current market-share percentage and trend for this company in the market described below, with source and period. Return JSON: {"marketShare": {"sharePct": string, "trend": string, "period": string, "verified": true, "source": string}}`,
  techProofPoint: `Find one concrete, dated, named proof point (a launch, partnership, case study, or analyst citation) specific to the technology focus given below. Return JSON: {"techProofPoint": {"description": string, "date": string, "verified": true, "source": string}}`,
};

function buildResearchPrompt(entityName: string, category: ResearchCategory, input: CompetitionBenchmarkingInput): string {
  return `You are a market-intelligence researcher verifying facts for a competitive benchmarking report. Research ONLY the following, using live web search — do not rely on prior knowledge without confirming it against current sources.

Company: ${entityName}
Category: ${category}
Context: this company is being benchmarked in the "${input.userDomain}" market${input.focusSegment ? ` with a focus on "${input.focusSegment}"` : ''}.
${category === 'techProofPoint' || category === 'productNames' ? `Technology focus: ${input.focusTech || 'Agentic AI / Applied AI'}\n` : ''}
${CATEGORY_INSTRUCTIONS[category]}

Rules:
- Every fact must be labeled "verified": true only if you found it in a current, credible source this call — never state a fact you could not confirm.
- If a leadership or brand-name change happened recently, state what changed, from what, to what, and the date/period of the change.
- Cite the source for every fact (publication name or URL).
Return ONLY the JSON object, no markdown fencing, no explanation.`;
}

function isStaleVerification(dateStr: string | undefined): boolean {
  if (!dateStr) return true;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return true;
  return Date.now() - d.getTime() > 30 * 24 * 60 * 60 * 1000; // ~30 days
}

async function researchEntity(entityName: string, input: CompetitionBenchmarkingInput): Promise<EntityResearch> {
  const categories: ResearchCategory[] = input.focusTech
    ? ['financials', 'leadership', 'productNames', 'marketShare', 'techProofPoint']
    : ['financials', 'leadership', 'productNames', 'marketShare'];

  const unverifiedCategories: ResearchCategory[] = [];
  const result: EntityResearch = {
    entityName, financials: [], leadership: [], productNames: [], unverifiedCategories,
  };

  await mapWithConcurrency(categories, categories.length, async (category) => {
    const prompt = buildResearchPrompt(entityName, category, input);
    const source = `researchEntity.${category}`;

    let parsed = await withRetry(() => runGeminiGroundedJSON<Record<string, unknown>>(prompt, source)).catch(() => null);

    // Programmatic QA: a leadership fact with a stale/missing verifiedDate
    // gets one extra re-run before being accepted as unverified — a single
    // stale fact shouldn't cost the whole category.
    if (category === 'leadership' && parsed?.leadership) {
      const arr = parsed.leadership as LeadershipFact[];
      if (arr.some((l) => isStaleVerification(l.verifiedDate))) {
        const retried = await runGeminiGroundedJSON<Record<string, unknown>>(prompt, `${source}.staleRetry`).catch(() => null);
        if (retried?.leadership) parsed = retried;
      }
    }

    switch (category) {
      case 'financials': {
        const arr = (parsed?.financials as FinancialsFact[] | undefined) || [];
        const clean = arr.filter((f) => !!f.source); // no source → cannot trust, drop rather than silently keep unmarked
        if (clean.length === 0) unverifiedCategories.push('financials');
        result.financials = clean;
        break;
      }
      case 'leadership': {
        const arr = (parsed?.leadership as LeadershipFact[] | undefined) || [];
        if (arr.length === 0) unverifiedCategories.push('leadership');
        result.leadership = arr;
        break;
      }
      case 'productNames': {
        const arr = (parsed?.productNames as ProductNameFact[] | undefined) || [];
        result.productNames = arr; // an empty array here is a valid, honest result — not a failure
        break;
      }
      case 'marketShare': {
        const fact = parsed?.marketShare as MarketShareFact | undefined;
        if (!fact) unverifiedCategories.push('marketShare');
        result.marketShare = fact;
        break;
      }
      case 'techProofPoint': {
        const fact = parsed?.techProofPoint as TechProofPointFact | undefined;
        if (!fact) unverifiedCategories.push('techProofPoint');
        result.techProofPoint = fact;
        break;
      }
    }
  });

  return result;
}

async function buildResearchDossier(
  entities: string[],
  input: CompetitionBenchmarkingInput,
  onProgress: (done: number, total: number) => void
): Promise<ResearchDossier> {
  let done = 0;
  const results = await mapWithConcurrency(entities, 6, async (entityName) => {
    const r = await researchEntity(entityName, input);
    done++;
    onProgress(done, entities.length);
    return r;
  });
  return { entities: results, generatedAt: new Date().toISOString() };
}

// ── Step C: synthesis (Claude) — one call per section ────────────────────────

const SYNTHESIS_SYSTEM_PROMPT = `You are a senior analyst at RefractOne Market Intelligence Practice, writing one section of a competitive benchmarking report. You will be given a research dossier (facts already verified via live web search, each labeled verified or unverified with a source) and must write ONLY from that dossier — never introduce a fact, name, figure, or brand that is not present in the dossier. If the dossier lacks something the section would normally cover, say so explicitly in the prose rather than inferring or estimating.

Formatting rules:
- Every financial figure must retain its Verified/Approx. label and source basis when it appears in table form.
- Any leadership change flagged in the dossier must be stated explicitly in prose (who succeeded whom, when) — never silently show only the current name.
- Any unverified product/brand name must be described generically instead of named, or explicitly flagged as unverified if a name is essential to include.
- Write in RefractOne's house analytical voice: direct, evidence-led, willing to name a specific competitive exposure or risk rather than staying generic.
Return strict JSON matching the schema in the user message. Return ONLY the JSON object, no markdown fencing.`;

interface SectionSpec {
  name: string;
  requirements: string;
  relevantCategories: ResearchCategory[] | 'all';
}

function sectionSpecs(input: CompetitionBenchmarkingInput, competitorCount: number): SectionSpec[] {
  const techLabel = input.focusTech || 'Agentic AI / Applied AI';
  return [
    {
      name: 'Executive Summary',
      requirements: `A 3-5 paragraph synthesis of the competitive landscape for ${input.userFirm}: where it stands relative to the named competitors, the single most important competitive exposure or opportunity, and the headline verified financial/market-share comparison. No new facts — synthesize what's in the dossier.`,
      relevantCategories: 'all',
    },
    {
      name: 'Market Sizing & Competitive Landscape',
      requirements: `Describe the size and shape of the "${input.userDomain}" market${input.focusSegment ? ` (focused on ${input.focusSegment})` : ''}, using the marketShare facts in the dossier. Note explicitly wherever a company's market-share figure is unverified rather than omitting the row.`,
      relevantCategories: ['marketShare'],
    },
    {
      name: 'Organization-Level Benchmarking',
      requirements: `Produce ONE table comparing ${input.userFirm} and every named competitor (exactly ${1 + competitorCount} rows including ${input.userFirm}) on: latest reported revenue (with fiscal year and Verified/Approx. label), YoY growth, and current CEO. Every cell must trace to a dossier fact — if a company's revenue or CEO is missing from the dossier, the cell must read "Not independently verified", never blank and never guessed.`,
      relevantCategories: ['financials', 'leadership'],
    },
    {
      name: 'Leadership Comparison',
      requirements: `Discuss the leadership of ${input.userFirm} versus each competitor. Explicitly call out any leadership change flagged in the dossier (who succeeded whom, and when) as a distinct point — this is exactly the kind of fact a client would want surfaced, not buried in a table cell.`,
      relevantCategories: ['leadership'],
    },
    {
      name: 'Practice/Capability Deep Dive',
      requirements: `Discuss each company's named platforms/brands from the dossier's productNames facts${input.focusSegment ? `, in the context of the "${input.focusSegment}" focus segment` : ''}. Where a company has no verified product name, say so explicitly rather than describing a generic capability as if it were named.`,
      relevantCategories: ['productNames'],
    },
    {
      name: 'Commercial & Pricing Models',
      requirements: `Discuss commercial/pricing positioning ONLY to the extent the dossier's financials and productNames facts support inference (e.g. revenue scale implying enterprise vs. mid-market focus). If the dossier has no pricing-relevant facts, state plainly that pricing/commercial model data was not independently verified for this report and should not be inferred.`,
      relevantCategories: ['financials', 'productNames'],
    },
    {
      name: `${techLabel} Competitive Maturity`,
      requirements: `Compare ${input.userFirm} and its competitors on ${techLabel} maturity, using the dossier's techProofPoint and productNames facts. Every claim must trace to a specific, dated proof point in the dossier — no general "X is investing in AI" statements without the specific evidence behind them.`,
      relevantCategories: ['techProofPoint', 'productNames'],
    },
    {
      name: 'Geographic & Vertical Concentration',
      requirements: `Discuss geographic and vertical concentration${input.geoFocus ? `, with particular attention to ${input.geoFocus}` : ''}, using whatever geographic signal is present in the dossier's facts (e.g. HQ location implied by sources, or explicit geographic detail in financials/marketShare facts). State explicitly where geographic data was not independently verified rather than inferring it.`,
      relevantCategories: 'all',
    },
    {
      name: 'Strategic Recommendations',
      requirements: `Give 3-5 specific, evidence-led recommendations for ${input.userFirm} based only on the competitive gaps and exposures surfaced elsewhere in the dossier. Each recommendation must reference the specific dossier fact that motivates it.`,
      relevantCategories: 'all',
    },
    {
      name: 'Methodology & Verification Note',
      requirements: `A short closing note (2-3 paragraphs) explaining how this report was researched (live web search via Gemini grounding, verified fact-by-fact) and written (Claude synthesis from the verified dossier only). State the total count of verified vs. unverified facts used in this report, and recommend human review of any unverified item before the report is used externally.`,
      relevantCategories: 'all',
    },
  ];
}

function dossierSlice(dossier: ResearchDossier, categories: ResearchCategory[] | 'all'): Record<string, unknown> {
  if (categories === 'all') return dossier as unknown as Record<string, unknown>;
  return {
    entities: dossier.entities.map((e) => {
      const slice: Record<string, unknown> = { entityName: e.entityName };
      for (const c of categories) slice[c] = e[c];
      return slice;
    }),
  };
}

async function synthesizeSection(
  spec: SectionSpec,
  dossier: ResearchDossier,
  input: CompetitionBenchmarkingInput
): Promise<BenchmarkingSection> {
  const userPrompt = `Section: ${spec.name}
Section requirements: ${spec.requirements}

Research dossier (JSON): ${JSON.stringify(dossierSlice(dossier, spec.relevantCategories))}

Client inputs: userFirm=${input.userFirm}, userDomain=${input.userDomain}, focusSegment=${input.focusSegment || 'none'}, focusTech=${input.focusTech || 'none'}, geoFocus=${input.geoFocus || 'none'}, additionalContext=${input.additionalContext || 'none'}

Return JSON matching this schema:
{
  "heading": string,
  "paragraphs": string[],
  "tables": [{ "headers": string[], "rows": string[][], "columnWidthHint": "narrow" | "even" | "wide-last-column" }],
  "footnote": string | null,
  "flags": string[]
}`;

  const raw = await withRetry(() => claudeCreateDirect(SYNTHESIS_SYSTEM_PROMPT, userPrompt, 3000, SYNTHESIS_MODEL, 90_000, 0.1, `synthesizeSection.${spec.name}`));
  const match = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim().match(/\{[\s\S]*\}/);
  if (!match) {
    return { heading: spec.name, paragraphs: [], tables: [], flags: [`Section "${spec.name}" failed to generate — not included in this report. Retry recommended.`] };
  }
  try {
    const parsed = JSON.parse(match[0]);
    return {
      heading: parsed.heading || spec.name,
      paragraphs: Array.isArray(parsed.paragraphs) ? parsed.paragraphs : [],
      tables: Array.isArray(parsed.tables) ? parsed.tables : [],
      footnote: parsed.footnote || undefined,
      flags: Array.isArray(parsed.flags) ? parsed.flags : [],
    };
  } catch {
    return { heading: spec.name, paragraphs: [], tables: [], flags: [`Section "${spec.name}" returned malformed output — not included in this report. Retry recommended.`] };
  }
}

// ── Fact counting for the Verification Summary panel ─────────────────────────

function countFacts(dossier: ResearchDossier): { total: number; unverified: number } {
  let total = 0;
  let unverified = 0;
  for (const e of dossier.entities) {
    total += e.financials.length + e.leadership.length + e.productNames.length + (e.marketShare ? 1 : 0) + (e.techProofPoint ? 1 : 0);
    unverified += e.unverifiedCategories.length;
    total += e.unverifiedCategories.length; // count the attempted-but-failed category as a fact slot too
  }
  return { total, unverified };
}

// ── Main runner ──────────────────────────────────────────────────────────────

export async function runCompetitionBenchmarking(jobId: string, input: CompetitionBenchmarkingInput): Promise<void> {
  try {
    let finalCompetitors: string[];
    let competitorSelection: CompetitorSelection | undefined;

    if (input.competitorList && input.competitorList.length > 0) {
      finalCompetitors = (input.selectedCompetitors && input.selectedCompetitors.length > 0
        ? input.selectedCompetitors
        : input.competitorList
      ).slice(0, 5);
    } else {
      let job = update(jobId, { status: 'selecting', progress: 5, currentStep: `Selecting top 5 competitors for ${input.userFirm}…` });
      emit(jobId, 'progress', job);

      const selection = await selectCompetitors(input);
      if (!selection) {
        job = update(jobId, { status: 'error', error: `Could not identify a verifiable competitor set for ${input.userFirm}. Try supplying a competitor list directly.` });
        emit(jobId, 'error', job);
        return;
      }
      competitorSelection = selection;
      finalCompetitors = selection.competitors.map((c) => c.name);
    }

    let job = update(jobId, { competitorSelection, finalCompetitors, status: 'researching', progress: 15, currentStep: `Researching ${input.userFirm} and ${finalCompetitors.length} competitors…` });
    emit(jobId, 'progress', job);

    const entities = [input.userFirm, ...finalCompetitors];
    const dossier = await buildResearchDossier(entities, input, (done, total) => {
      const progress = 15 + Math.round((done / total) * 45); // 15 → 60
      job = update(jobId, { progress, currentStep: `Researched ${done}/${total} companies…` });
      emit(jobId, 'progress', job);
    });

    job = update(jobId, { dossier, status: 'synthesizing', progress: 62, currentStep: 'Writing report sections…' });
    emit(jobId, 'progress', job);

    const specs = sectionSpecs(input, finalCompetitors.length);
    const sections: BenchmarkingSection[] = [];
    for (let i = 0; i < specs.length; i++) {
      const section = await synthesizeSection(specs[i], dossier, input);
      sections.push(section);
      const progress = 62 + Math.round(((i + 1) / specs.length) * 35); // 62 → 97
      job = update(jobId, { sections: [...sections], progress, currentStep: `Drafting "${specs[i].name}" (${i + 1}/${specs.length})…` });
      emit(jobId, 'progress', job);
    }

    const { total, unverified } = countFacts(dossier);

    job = update(jobId, {
      status: 'complete',
      progress: 100,
      currentStep: 'Complete',
      sections,
      totalFactCount: total,
      unverifiedFactCount: unverified,
      completedAt: new Date().toISOString(),
    });
    emit(jobId, 'result', job);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Competition Benchmarking failed';
    console.error(`[competitionBenchmarking] job ${jobId} failed:`, message);
    const job = update(jobId, { status: 'error', error: message });
    emit(jobId, 'error', job);
  }
}
