import { v4 as uuidv4 } from 'uuid';
import {
  SpendInput,
  SpendResult,
  ItSpendPayload,
  ErdSpendPayload,
  SpendCalculatorInput,
  ItSpendCalculatorResult,
  ErdSpendCalculatorResult,
} from '@ai-insights/types';
import { geminiSpendLookup } from './parallelAI';
import {
  resolveRegion,
  resolveRevenueTier,
  isErdEligible,
  computeItBaseSpend,
  computeErdBaseSpend,
  computeItLevel3Breakdown,
  computeErdBreakdown,
  findItLevel3Value,
  findErdCategoryValue,
  buildItBreakdownTree,
  buildErdBreakdownTree,
  computeItSpendTrendV2,
  computeErdSpendTrendV2,
  computeItCAGR,
  computeErdCAGR,
  computeEmergingTechV2,
  getBaseYear,
} from './itErdSpendCalculator';

// ── Shared calculation core ───────────────────────────────────────────────────
// One code path produces the numbers for all three entry points: the async research
// job (which feeds in disclosed figures it found) and the two synchronous calculator
// endpoints (which feed in nothing and get the pure industry-benchmark estimate).
// IT and ERD are computed together even when only one is asked for, because they
// feed each other: the Emerging Tech "AI" line is sourced from ERD's "AI/ML & Data
// Engineering" category for the 14 ERD-eligible industries.

interface DisclosedOverrides {
  itBaseUsdMillion?: number;  // disclosed IT spend, replaces the benchmark estimate
  erdBaseUsdMillion?: number; // disclosed R&D spend, ditto
  aiUsdMillion?: number;      // disclosed AI spend, outranks the ERD AI/ML line
}

interface SpendCore {
  region: ReturnType<typeof resolveRegion>;
  tier: ReturnType<typeof resolveRevenueTier>;
  baseYear: number;
  itSpend?: ItSpendPayload;
  erdSpend?: ErdSpendPayload;
}

function computeSpendCore(
  input: { companyName: string; geography?: string; industry: string; revenueUsdMillion: number },
  overrides: DisclosedOverrides = {}
): SpendCore {
  const { industry, companyName } = input;
  const revenueUsdM = input.revenueUsdMillion;
  const region = resolveRegion(input.geography);
  const tier = resolveRevenueTier(revenueUsdM);
  const baseYear = getBaseYear();
  const currencyInfo = { currency: 'USD', revenueUSD: revenueUsdM, exchangeRateToUSD: 1 };
  const core: SpendCore = { region, tier, baseYear };

  // ── ERD first — its AI/ML line is one of the Emerging Tech overrides below ──
  let erdAiLine: number | undefined;
  if (isErdEligible(industry)) {
    const erdBaseUsdMillion =
      overrides.erdBaseUsdMillion ?? computeErdBaseSpend(industry, revenueUsdM, region, tier)?.usdMillion;
    if (erdBaseUsdMillion != null) {
      const erdFlat = computeErdBreakdown(industry, erdBaseUsdMillion, tier);
      erdAiLine = findErdCategoryValue(erdFlat, 'AI/ML & Data Engineering');
      const erdTrend = computeErdSpendTrendV2(industry, revenueUsdM, region, tier);
      const erdCagr = computeErdCAGR(erdTrend);
      core.erdSpend = {
        region,
        trends: erdTrend,
        country: input.geography ?? '', // stays present (empty) when HQ is unknown, so the payload shape never varies
        revenue: revenueUsdM,
        industry,
        companyName,
        currencyInfo,
        erdBreakdown: buildErdBreakdownTree(erdFlat),
        erdCAGR_Forecast: erdCagr.forecast,
        erdCAGR_Historical: erdCagr.historical,
      };
    }
  }

  // ── IT, its Level-3 breakdown (exclusion-adjusted) and Emerging Tech ──
  const itBaseUsdMillion =
    overrides.itBaseUsdMillion ?? computeItBaseSpend(industry, revenueUsdM, region, tier)?.usdMillion;
  if (itBaseUsdMillion != null) {
    const itFlat = computeItLevel3Breakdown(industry, itBaseUsdMillion, revenueUsdM);
    const emergingTech = computeEmergingTechV2(
      industry,
      itBaseUsdMillion,
      region,
      tier,
      overrides.aiUsdMillion ?? erdAiLine,
      findItLevel3Value(itFlat, 'Services', 'Digital Enterprise', 'Blockchain'),
      revenueUsdM
    );
    const itTrend = computeItSpendTrendV2(industry, revenueUsdM, region, tier);
    const itCagr = computeItCAGR(itTrend);
    core.itSpend = {
      region,
      trends: itTrend,
      country: input.geography ?? '', // stays present (empty) when HQ is unknown, so the payload shape never varies
      revenue: revenueUsdM,
      industry,
      companyName,
      itBreakdown: buildItBreakdownTree(itFlat),
      currencyInfo,
      emergingTech: emergingTech.map((r) => ({ name: r.tech, value: r.value, adjTotal: r.adjTotal })),
      itCAGR_Forecast: itCagr.forecast,
      itCAGR_Historical: itCagr.historical,
    };
  }

  return core;
}

// ── Synchronous calculator API ────────────────────────────────────────────────
// No research call, so these answer immediately — no job/SSE round trip needed.

/** IT Spend (incl. the 117-item Level-3 breakdown and the 8 Emerging Tech lines). */
export function calculateItSpend(input: SpendCalculatorInput): ItSpendCalculatorResult {
  const core = computeSpendCore(input);
  if (!core.itSpend) {
    return { applicable: false, message: `No IT spend benchmark data for industry "${input.industry}".` };
  }
  return { applicable: true, revenueTier: core.tier, baseYear: core.baseYear, itSpend: core.itSpend };
}

/** ER&D Spend — available for the 14 engineering-heavy industries only. */
export function calculateErdSpend(input: SpendCalculatorInput): ErdSpendCalculatorResult {
  const core = computeSpendCore(input);
  if (!core.erdSpend) {
    return {
      applicable: false,
      revenueTier: core.tier,
      baseYear: core.baseYear,
      message: `ER&D spend is not applicable for industry "${input.industry}" — it is modelled for the 14 engineering-heavy industries only.`,
    };
  }
  return { applicable: true, revenueTier: core.tier, baseYear: core.baseYear, erdSpend: core.erdSpend };
}

// ── In-memory job store ────────────────────────────────────────────────────────

const jobs = new Map<string, SpendResult>();

setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [id, job] of jobs.entries()) {
    if (new Date(job.createdAt).getTime() < cutoff) jobs.delete(id);
  }
}, 30 * 60 * 1000);

// ── SSE subscriber registry ────────────────────────────────────────────────────

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

function update(jobId: string, patch: Partial<SpendResult>): SpendResult {
  const current = jobs.get(jobId)!;
  const updated = { ...current, ...patch };
  jobs.set(jobId, updated);
  return updated;
}

// ── Public API ─────────────────────────────────────────────────────────────────

export function createSpendJob(input: SpendInput): string {
  const jobId = uuidv4();
  jobs.set(jobId, {
    jobId,
    status: 'pending',
    progress: 0,
    companyName: input.companyName,
    companyDomain: input.companyDomain,
    geography: input.geography,
    revenueUsdMillion: input.revenueUsdMillion,
    createdAt: new Date().toISOString(),
  });
  return jobId;
}

export function getSpendJob(jobId: string): SpendResult | undefined {
  return jobs.get(jobId);
}

// ── Main runner ──────────────────────────────────────────────────────────────
// All four inputs (companyName, companyDomain, geography, industry, revenueUsdMillion)
// are mandatory (enforced in routes/spend.ts) — this is deliberate: domain/geography
// are rooted into the research query to disambiguate same-name companies, industry
// and revenue drive the benchmark formula deterministically instead of depending on
// live auto-classification/auto-lookup calls that can miss (as geminiRevenueLookup
// occasionally did for some companies).
//
// Flow: research disclosed IT/R&D/AI spend (Gemini), then:
//   - IT base value  = disclosed IT spend if found, else Revenue × industry IT
//     benchmark % (region + revenue-tier adjusted).
//   - ERD base value = disclosed R&D spend if found, else Revenue × industry ERD
//     benchmark % (only for the 14 ERD-eligible industries).
//   - IT Level-3 breakdown applies the exclusion + equal-redistribution rules
//     (IT_LEVEL3_EXCLUSION) based on revenue tier + industry.
//   - AI: disclosed research figure > ERD's "AI/ML & Data Engineering" line > formula.
//   - Blockchain: always sourced from the IT breakdown's Digital Enterprise line.

export async function runSpendJob(jobId: string, input: SpendInput): Promise<void> {
  try {
    let job = update(jobId, {
      status: 'researching',
      progress: 15,
      currentStep: `Researching ${input.companyName}'s IT, R&D, and AI spend…`,
    });
    emit(jobId, 'progress', job);

    const industry = input.industry;
    const region = resolveRegion(input.geography);
    const revenueUsdM = input.revenueUsdMillion;

    const spendResult = await geminiSpendLookup(input.companyName, input.companyDomain, input.geography, industry, revenueUsdM);

    if (!spendResult) {
      job = update(jobId, {
        status: 'error',
        error: `Could not research spend data for ${input.companyName}.`,
      });
      emit(jobId, 'error', job);
      return;
    }

    job = update(jobId, {
      status: 'synthesizing',
      progress: 60,
      currentStep: 'Calculating category breakdown…',
    });
    emit(jobId, 'progress', job);

    // Disclosed figures outrank the benchmark estimate wherever research found one;
    // everything else (breakdowns, trends, CAGR, Emerging Tech) comes out of the same
    // calculation core the synchronous /api/spend/it and /api/spend/erd routes use.
    const core = computeSpendCore(
      { companyName: input.companyName, geography: input.geography, industry, revenueUsdMillion: revenueUsdM },
      {
        itBaseUsdMillion:
          spendResult.itSpend.found && spendResult.itSpend.valueRaw ? spendResult.itSpend.valueRaw / 1_000_000 : undefined,
        erdBaseUsdMillion:
          spendResult.rdSpend.found && spendResult.rdSpend.valueRaw ? spendResult.rdSpend.valueRaw / 1_000_000 : undefined,
        aiUsdMillion:
          spendResult.aiSpend.found && spendResult.aiSpend.valueRaw ? spendResult.aiSpend.valueRaw / 1_000_000 : undefined,
      }
    );

    job = update(jobId, {
      status: 'complete',
      progress: 100,
      currentStep: 'Complete',
      completedAt: new Date().toISOString(),
      itSpendDisclosed: spendResult.itSpend,
      rdSpendDisclosed: spendResult.rdSpend,
      aiSpendDisclosed: spendResult.aiSpend,
      resolvedIndustry: industry,
      resolvedRegion: region,
      itSpend: core.itSpend,
      erdSpend: core.erdSpend,
    });
    emit(jobId, 'result', job);

  } catch (err) {
    const message = err instanceof Error ? err.message : 'Spend research failed';
    console.error(`[spend] job ${jobId} failed:`, message);
    const job = update(jobId, { status: 'error', error: message });
    emit(jobId, 'error', job);
  }
}
