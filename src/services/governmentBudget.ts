import {
  FinancialAnalysisInput, FinancialAnalysisResult, RevenueDataPoint, FinancialSegmentRow, GeoRow,
  FinancialStatementRow, KeyHighlightsStructured,
} from '@ai-insights/types';
import {
  claudeCreateDirect, claudeWithWebResearch, parseJsonRobust, toBulletArray,
  getRecencyDirective, WRITING_DIRECTIVE, SYNTHESIS_MODEL, FAST_MODEL,
} from './claudeAI';
import { formatRevenueUSD } from './yahooFinance';

// Financial Analysis for government departments, agencies and government
// enterprises funded through appropriations. They do not report revenue, so
// the report shows their budget instead, in the SAME report sections:
//   revenueHistory  -> budget authority by fiscal year
//   segmentRevenue  -> budget by sub-agency, bureau or program
//   geoRevenue      -> mandatory vs discretionary split
//   plStatement     -> budget summary, this fiscal year vs the previous one
//   keyHighlights   -> the same five sections, about the budget
// entityType 'government' tells the app to relabel those sections.

// ── Detection ────────────────────────────────────────────────────────────────

const GOV_HOST = /(^|\.)(gov|mil)$|(^|\.)(gov|gouv|gob|govt|go|gv|gub)\.[a-z]{2}$|(^|\.)gc\.ca$|(^|\.)canada\.ca$|(^|\.)europa\.eu$|(^|\.)admin\.ch$|(^|\.)bund\.de$|(^|\.)nic\.in$/i;
const GOV_NAME = /\b(department|dept\.?|ministry|ministerio|agency|bureau|administration|commission|office of|government of|county|city of|state of|commonwealth of|province of|municipality|municipal|council|federal|national institutes?|secretariat|directorate|public schools?|school district|treasury|authority)\b/i;

function hostOf(domain?: string): string {
  if (!domain) return '';
  try { return new URL(/^https?:\/\//i.test(domain) ? domain : `https://${domain}`).hostname.toLowerCase(); } catch { return ''; }
}

/** Cheap first pass: worth asking the classifier at all? */
export function looksGovernmental(input: FinancialAnalysisInput): boolean {
  return GOV_HOST.test(hostOf(input.companyDomain)) || GOV_NAME.test(input.companyName);
}

/**
 * Whether the entity is government and funded on a budgetary basis
 * (appropriations) rather than reporting revenue. Government enterprises that
 * do report revenue (Tennessee Valley Authority, national postal companies,
 * listed state-owned companies) stay on the normal company path.
 */
export async function isBudgetFundedGovernment(input: FinancialAnalysisInput): Promise<boolean> {
  if (!looksGovernmental(input)) return false;
  const system = 'You classify organisations. Output ONLY JSON: {"government": boolean, "budgetFunded": boolean}.';
  const user = `Organisation: "${input.companyName}"${input.companyDomain ? `, website ${input.companyDomain}` : ''}.
government: true if it is a federal, state, provincial or local government entity, department, ministry, agency, bureau, commission, or government enterprise.
budgetFunded: true if it is funded mainly through government appropriations or a budget (it publishes a budget, not revenue in financial statements). False for government enterprises and state-owned companies that report revenue from selling goods or services (for example Tennessee Valley Authority, Amtrak, national postal or rail companies, listed state-owned companies).`;
  try {
    const raw = await claudeCreateDirect(system, user, 100, FAST_MODEL, 30_000, 0, 'financialAnalysis.govClassify');
    const r = parseJsonRobust(raw) as { government?: boolean; budgetFunded?: boolean };
    return Boolean(r?.government && r?.budgetFunded);
  } catch (err) {
    console.warn('[governmentBudget] classification failed, treating as a company:', err instanceof Error ? err.message : err);
    return false;
  }
}

// ── Research ─────────────────────────────────────────────────────────────────

const RESEARCH_SYSTEM = `You are a public finance analyst. Every fact must come from a page or search result you actually retrieved with your tools in this session. Never use memory for figures or URLs. After each figure, write the exact URL of the page it came from, and say whether it is enacted, estimated or requested.`;

export async function researchGovernmentBudget(input: FinancialAnalysisInput): Promise<{ notes: string; urls: string[] }> {
  const who = `"${input.companyName}"${input.companyDomain ? ` (website ${input.companyDomain})` : ''}`;
  const brief = `Research the budget of ${who} for the most recent fiscal year that has an ENACTED budget, and the fiscal year before it. ${getRecencyDirective()}

Find, with the fiscal year for every figure:
1. Total enacted budget authority (and total outlays if published).
2. The breakdown by major sub-agencies, bureaus, offices or programmatic line items, with amounts for both fiscal years.
3. The previous fiscal year's enacted budget, to compare against. Include up to five fiscal years of total budget authority if available.
4. The split between mandatory and discretionary spending, with amounts for both fiscal years, if the jurisdiction uses that distinction.
5. Context: the entity's mission, head (Secretary, Director, Commissioner or similar), headquarters, workforce (FTEs), the next fiscal year's budget request, and major budget changes, rescissions or supplemental appropriations.

Best sources: the government budget office (for US federal agencies: the OMB Budget Appendix on whitehouse.gov, the agency's Budget in Brief and Congressional Budget Justification, USAspending.gov, appropriations acts on congress.gov, CBO), the agency's own budget pages, state or local enacted budget documents, finance ministry budget documents for other countries, and major news.

OUTPUT: plain text notes with the URL after every figure. Give amounts in full units with the currency (for example "$52.4 billion"). Write "NOT FOUND" for anything you could not verify.`;

  const r = await claudeWithWebResearch(RESEARCH_SYSTEM, brief, 10000, SYNTHESIS_MODEL, {
    maxSearches: 8,
    legacySearch: true,
    timeoutMs: 270_000,
    source: 'financialAnalysis.govResearch',
  });
  return { notes: r.text, urls: r.urls };
}

// ── Structuring ──────────────────────────────────────────────────────────────

interface BudgetDraft {
  fiscalYear?: string;
  previousFiscalYear?: string;
  currency?: string;
  totalHistory?: { year?: string; amount?: number }[];
  breakdown?: { name?: string; amount?: number; priorAmount?: number }[];
  spendingType?: { type?: string; amount?: number; priorAmount?: number }[];
  outlays?: number;
  priorOutlays?: number;
  about?: string;
  head?: string;
  headquarters?: string;
  employees?: string;
  keyHighlights?: Record<string, unknown>;
  budgetInsight?: string;
  breakdownInsight?: string;
  spendingTypeInsight?: string;
  summaryInsight?: string;
  chartInsights?: unknown;
  sources?: unknown;
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && isFinite(v) ? v : undefined);
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

export function pctChange(curr?: number, prev?: number): number | undefined {
  if (curr == null || prev == null || prev === 0) return undefined;
  return Math.round(((curr - prev) / Math.abs(prev)) * 1000) / 10;
}

const signed = (p?: number) => (p == null ? undefined : `${p >= 0 ? '+' : ''}${p.toFixed(1)}%`);

/** Maps the structured budget onto the existing Financial Analysis fields. */
export function budgetToReport(d: BudgetDraft, observedUrls: string[]): Partial<FinancialAnalysisResult> {
  const currency = (str(d.currency) || 'USD').toUpperCase();
  const fmt = (v?: number) => (v == null ? '—' : formatRevenueUSD(v, currency));
  const fy = str(d.fiscalYear);
  const pfy = str(d.previousFiscalYear);

  const history = (d.totalHistory || [])
    .map((h) => ({ year: str(h.year), amount: num(h.amount) }))
    .filter((h): h is { year: string; amount: number } => Boolean(h.year) && h.amount != null)
    .sort((a, b) => a.year.localeCompare(b.year, undefined, { numeric: true }));
  const revenueHistory: RevenueDataPoint[] = history.map((h, i) => ({
    year: h.year,
    revenue: h.amount,
    revenueFormatted: fmt(h.amount),
    yoyGrowth: i > 0 ? pctChange(h.amount, history[i - 1].amount) : undefined,
  }));

  const breakdown = (d.breakdown || []).filter((b) => str(b.name) && num(b.amount) != null);
  const breakdownTotal = breakdown.reduce((s, b) => s + (b.amount as number), 0);
  const segmentRevenue: FinancialSegmentRow[] = breakdown
    .sort((a, b) => (b.amount as number) - (a.amount as number))
    .map((b) => ({
      segment: str(b.name),
      revenue: fmt(b.amount),
      percentage: breakdownTotal ? Math.round(((b.amount as number) / breakdownTotal) * 1000) / 10 : 0,
      yoyGrowth: signed(pctChange(b.amount, num(b.priorAmount))),
    }));

  const types = (d.spendingType || []).filter((t) => str(t.type) && num(t.amount) != null);
  const typesTotal = types.reduce((s, t) => s + (t.amount as number), 0);
  const geoRevenue: GeoRow[] = types.map((t) => ({
    region: str(t.type),
    revenue: fmt(t.amount),
    percentage: typesTotal ? Math.round(((t.amount as number) / typesTotal) * 1000) / 10 : 0,
    yoyGrowth: signed(pctChange(t.amount, num(t.priorAmount))),
  }));

  const latest = history.at(-1);
  const prior = history.at(-2);
  const row = (label: string, curr?: number, prev?: number, isBold = false): FinancialStatementRow | null =>
    curr == null ? null : { label, value: fmt(curr), previousValue: prev == null ? undefined : fmt(prev), yoy: signed(pctChange(curr, prev)), isBold };
  const findType = (re: RegExp) => types.find((t) => re.test(str(t.type)));
  const disc = findType(/discretionary/i);
  const mand = findType(/mandatory/i);
  const plStatement = [
    { label: `Budget Summary${fy ? ` (${fy}${pfy ? ` vs ${pfy}` : ''})` : ''}`, value: '', isSection: true } as FinancialStatementRow,
    row('Total Enacted Budget Authority', latest?.amount, prior?.amount, true),
    row('Discretionary Budget Authority', num(disc?.amount), num(disc?.priorAmount)),
    row('Mandatory Budget Authority', num(mand?.amount), num(mand?.priorAmount)),
    row('Total Outlays', num(d.outlays), num(d.priorOutlays)),
  ].filter((r): r is FinancialStatementRow => r !== null);

  const kh = (d.keyHighlights || {}) as Record<string, unknown>;
  const keyHighlights: KeyHighlightsStructured = {
    overallPerformance: toBulletArray(kh.overallPerformance),
    overallPerformanceTagline: str(kh.overallPerformanceTagline) || undefined,
    factorsDrivingGrowth: toBulletArray(kh.factorsDrivingGrowth),
    factorsDrivingGrowthTagline: str(kh.factorsDrivingGrowthTagline) || undefined,
    factorsInhibitingGrowth: toBulletArray(kh.factorsInhibitingGrowth),
    factorsInhibitingGrowthTagline: str(kh.factorsInhibitingGrowthTagline) || undefined,
    futureStrategy: toBulletArray(kh.futureStrategy),
    futureStrategyTagline: str(kh.futureStrategyTagline) || undefined,
    growthOutlook: toBulletArray(kh.growthOutlook),
    growthOutlookTagline: str(kh.growthOutlookTagline) || undefined,
  };

  // Sources must be pages the research actually retrieved.
  const seen = new Set(observedUrls.map((u) => u.replace(/\/+$/, '')));
  const sources = (Array.isArray(d.sources) ? d.sources : [])
    .filter((u): u is string => typeof u === 'string' && seen.has(u.trim().replace(/\/+$/, '')));

  return {
    entityType: 'government',
    fiscalYear: fy || latest?.year,
    currency,
    dataSource: 'Government budget documents',
    companyInfo: {
      about: str(d.about) || undefined,
      ceo: str(d.head) || undefined,
      headquarters: str(d.headquarters) || undefined,
      employees: str(d.employees) || undefined,
    },
    revenueHistory,
    segmentRevenue,
    geoRevenue,
    plStatement: plStatement.length > 1 ? plStatement : undefined,
    revenueInsight: str(d.budgetInsight) || undefined,
    segmentInsight: str(d.breakdownInsight) || undefined,
    geoInsight: str(d.spendingTypeInsight) || undefined,
    plInsight: str(d.summaryInsight) || undefined,
    chartInsights: toBulletArray(d.chartInsights),
    keyHighlights,
    budgetSources: sources.length ? Array.from(new Set(sources)) : undefined,
  };
}

export async function structureGovernmentBudget(
  input: FinancialAnalysisInput,
  notes: string,
  urls: string[]
): Promise<Partial<FinancialAnalysisResult>> {
  const system = `You are a public finance analyst turning research notes into a structured budget report. Use ONLY figures in the notes; never estimate or add figures from memory. ${getRecencyDirective()} ${WRITING_DIRECTIVE} Output ONLY valid JSON, no markdown fences.`;
  const user = `ENTITY: "${input.companyName}"${input.companyDomain ? ` (${input.companyDomain})` : ''}

RESEARCH NOTES:
${notes.slice(0, 50000)}

URLS THE RESEARCH RETRIEVED (cite only these):
${urls.slice(0, 150).join('\n')}

Return JSON of exactly this shape. All amounts are plain numbers in full units (52400000000, not "52.4B"). Omit a figure the notes do not give rather than guessing.
{
  "fiscalYear": "most recent fiscal year with an enacted budget, e.g. FY2026",
  "previousFiscalYear": "the fiscal year before it, e.g. FY2025",
  "currency": "ISO code, e.g. USD",
  "totalHistory": [{"year": "FY2024", "amount": 0}],
  "breakdown": [{"name": "sub-agency, bureau or program", "amount": 0, "priorAmount": 0}],
  "spendingType": [{"type": "Discretionary", "amount": 0, "priorAmount": 0}, {"type": "Mandatory", "amount": 0, "priorAmount": 0}],
  "outlays": 0,
  "priorOutlays": 0,
  "about": "2 sentences: mission and what the budget funds",
  "head": "name and title of the head of the entity",
  "headquarters": "city, state or country",
  "employees": "workforce, e.g. '14,000 FTEs (FY2026)'",
  "keyHighlights": {
    "overallPerformance": ["• total enacted budget authority and change vs the previous fiscal year"],
    "overallPerformanceTagline": "3-6 words",
    "factorsDrivingGrowth": ["• programs and sub-agencies that grew, and why"],
    "factorsDrivingGrowthTagline": "3-6 words",
    "factorsInhibitingGrowth": ["• cuts, rescissions, caps or pressures"],
    "factorsInhibitingGrowthTagline": "3-6 words",
    "futureStrategy": ["• priorities in the next budget request"],
    "futureStrategyTagline": "3-6 words",
    "growthOutlook": ["• outlook for the next fiscal year"],
    "growthOutlookTagline": "3-6 words"
  },
  "budgetInsight": "2-3 sentences on the multi-year budget trend",
  "breakdownInsight": "2-3 sentences on where the money goes and what changed",
  "spendingTypeInsight": "2 sentences on mandatory vs discretionary, or why the split does not apply",
  "summaryInsight": "2 sentences comparing this fiscal year with the previous one",
  "chartInsights": ["• 2-4 bullets on the budget history"],
  "sources": ["URLs from the list above that support the figures"]
}
Rules: give the breakdown's 6-12 largest items for the latest fiscal year, with priorAmount where the notes give it. Omit spendingType if the jurisdiction does not use mandatory and discretionary. Each keyHighlights section has 2-4 bullets starting with "• ". Single quotes inside strings, never double quotes.`;

  const raw = await claudeCreateDirect(system, user, 9000, SYNTHESIS_MODEL, 180_000, undefined, 'financialAnalysis.govStructure');
  return budgetToReport(parseJsonRobust(raw) as BudgetDraft, urls);
}
