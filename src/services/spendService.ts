import { v4 as uuidv4 } from 'uuid';
import { SpendInput, SpendResult } from '@ai-insights/types';
import { geminiSpendLookup, geminiRevenueLookup } from './parallelAI';
import { claudeClassifyIndustry, SPEND_CALCULATOR_INDUSTRIES } from './claudeAI';
import { convertToUsd } from './yahooFinance';
import {
  resolveRegion,
  resolveRevenueTier,
  isErdEligible,
  computeItBaseSpend,
  computeErdBaseSpend,
  computeItLevel3Breakdown,
  computeErdBreakdown,
  computeEmergingTechBreakdown,
  computeItSpendTrend,
  computeErdSpendTrend,
  findItLevel3Value,
  findErdCategoryValue,
} from './itErdSpendCalculator';

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
    createdAt: new Date().toISOString(),
  });
  return jobId;
}

export function getSpendJob(jobId: string): SpendResult | undefined {
  return jobs.get(jobId);
}

// ── Main runner ──────────────────────────────────────────────────────────────
// Flow: research disclosed IT/R&D/AI spend (Gemini) in parallel with revenue +
// industry classification, then:
//   - IT base value  = disclosed IT spend if found, else Revenue × industry IT
//     benchmark % (region + revenue-tier adjusted).
//   - ERD base value = disclosed R&D spend if found, else Revenue × industry ERD
//     benchmark % (only for the 14 ERD-eligible industries).
//   - Category breakdowns (IT Level-3, ERD categories, Emerging Tech) are always
//     computed from the benchmark formula, applied to whichever base value above
//     was used.
//   - AI: if disclosed AI spend is found, it REPLACES the formula-computed AI line
//     inside the Emerging Tech breakdown, and the Emerging Tech total is
//     recalculated to reflect the real figure instead of the formula estimate.

export async function runSpendJob(jobId: string, input: SpendInput): Promise<void> {
  try {
    let job = update(jobId, {
      status: 'researching',
      progress: 15,
      currentStep: `Researching ${input.companyName}'s IT, R&D, and AI spend…`,
    });
    emit(jobId, 'progress', job);

    // User-selected industry takes priority over auto-classification (skips the
    // extra Claude call entirely when a valid selection is provided).
    const userIndustry = input.industry && SPEND_CALCULATOR_INDUSTRIES.includes(input.industry)
      ? input.industry
      : undefined;

    const [spendResult, revenueResult, classifiedIndustry] = await Promise.all([
      geminiSpendLookup(input.companyName, input.companyDomain, input.geography),
      geminiRevenueLookup(input.companyName, input.companyDomain).catch(() => null),
      userIndustry ? Promise.resolve(null) : claudeClassifyIndustry(input.companyName, input.companyDomain).catch(() => null),
    ]);
    const industry = userIndustry ?? classifiedIndustry;

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

    const region = resolveRegion(input.geography);
    // geminiRevenueLookup's *Raw fields are in the company's NATIVE currency units —
    // convert to USD before using as the revenue base for the benchmark formula.
    const revenueRawUsd = typeof revenueResult?.latestRevenueRaw === 'number'
      ? convertToUsd(revenueResult.latestRevenueRaw, revenueResult.currency)
      : undefined;

    let itBreakdown: SpendResult['itBreakdown'];
    let erdBreakdown: SpendResult['erdBreakdown'];
    let emergingTechBreakdown: SpendResult['emergingTechBreakdown'];
    let itBaseUsdMillion: number | undefined;
    let erdBaseUsdMillion: number | undefined;
    let erdApplicable = false;
    let itSpendTrend: SpendResult['itSpendTrend'];
    let erdSpendTrend: SpendResult['erdSpendTrend'];

    const revenueUsdM = revenueRawUsd != null ? revenueRawUsd / 1_000_000 : undefined;
    const tier = revenueUsdM != null ? resolveRevenueTier(revenueUsdM) : undefined;

    // ── IT base value: disclosed if found, else formula ──────────────────────
    if (spendResult.itSpend.found && spendResult.itSpend.valueRaw) {
      itBaseUsdMillion = spendResult.itSpend.valueRaw / 1_000_000;
    } else if (industry && revenueUsdM != null && tier) {
      const formula = computeItBaseSpend(industry, revenueUsdM, region, tier);
      if (formula) itBaseUsdMillion = formula.usdMillion;
    }
    if (itBaseUsdMillion != null && industry) {
      itBreakdown = computeItLevel3Breakdown(industry, itBaseUsdMillion);
    }
    if (industry && revenueUsdM != null && tier) {
      itSpendTrend = computeItSpendTrend(industry, revenueUsdM, region, tier);
    }

    // ── ERD base value: disclosed R&D if found, else formula (ERD-eligible only) ──
    if (industry && isErdEligible(industry)) {
      erdApplicable = true;
      if (spendResult.rdSpend.found && spendResult.rdSpend.valueRaw) {
        erdBaseUsdMillion = spendResult.rdSpend.valueRaw / 1_000_000;
      } else if (revenueUsdM != null && tier) {
        const formula = computeErdBaseSpend(industry, revenueUsdM, region, tier);
        if (formula) erdBaseUsdMillion = formula.usdMillion;
      }
      if (erdBaseUsdMillion != null && tier) {
        erdBreakdown = computeErdBreakdown(industry, erdBaseUsdMillion, tier);
      }
      if (revenueUsdM != null && tier) {
        erdSpendTrend = computeErdSpendTrend(industry, revenueUsdM, region, tier);
      }
    }

    // ── Emerging Tech (incl. AI, Blockchain) breakdown ────────────────────────
    // AI priority: disclosed research figure > ERD's "AI/ML & Data Engineering" line > formula.
    // Blockchain: always sourced from the IT breakdown's Services → Digital Enterprise →
    // Blockchain line item (never the formula-computed Emerging Tech value).
    if (industry && itBaseUsdMillion != null && tier) {
      const disclosedAi = spendResult.aiSpend.found && spendResult.aiSpend.valueRaw
        ? spendResult.aiSpend.valueRaw / 1_000_000
        : undefined;
      const erdAiLine = erdBreakdown ? findErdCategoryValue(erdBreakdown, 'AI/ML & Data Engineering') : undefined;
      const aiOverride = disclosedAi ?? erdAiLine;

      const blockchainOverride = itBreakdown
        ? findItLevel3Value(itBreakdown, 'Services', 'Digital Enterprise', 'Blockchain')
        : undefined;

      emergingTechBreakdown = computeEmergingTechBreakdown(industry, itBaseUsdMillion, region, tier, aiOverride, blockchainOverride);
    }

    const emergingTechTotalUsdMillion = emergingTechBreakdown?.reduce((sum, row) => sum + row.usdMillion, 0);

    job = update(jobId, {
      status: 'complete',
      progress: 100,
      currentStep: 'Complete',
      completedAt: new Date().toISOString(),
      itSpend: spendResult.itSpend,
      rdSpend: spendResult.rdSpend,
      aiSpend: spendResult.aiSpend,
      resolvedIndustry: industry ?? undefined,
      resolvedRegion: region,
      itBaseUsdMillion,
      itBreakdown,
      itSpendTrend,
      erdApplicable,
      erdBaseUsdMillion,
      erdBreakdown,
      erdSpendTrend,
      emergingTechBreakdown,
      emergingTechTotalUsdMillion,
    });
    emit(jobId, 'result', job);

  } catch (err) {
    const message = err instanceof Error ? err.message : 'Spend research failed';
    console.error(`[spend] job ${jobId} failed:`, message);
    const job = update(jobId, { status: 'error', error: message });
    emit(jobId, 'error', job);
  }
}
