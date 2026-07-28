import { v4 as uuidv4 } from 'uuid';
import { SpendInput, SpendResult } from '@ai-insights/types';
import { geminiSpendLookup } from './parallelAI';
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
    const tier = resolveRevenueTier(revenueUsdM);

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

    let itBreakdown: SpendResult['itBreakdown'];
    let erdBreakdown: SpendResult['erdBreakdown'];
    let emergingTechBreakdown: SpendResult['emergingTechBreakdown'];
    let itBaseUsdMillion: number | undefined;
    let erdBaseUsdMillion: number | undefined;
    let erdApplicable = false;

    // ── IT base value: disclosed if found, else formula ──────────────────────
    if (spendResult.itSpend.found && spendResult.itSpend.valueRaw) {
      itBaseUsdMillion = spendResult.itSpend.valueRaw / 1_000_000;
    } else {
      const formula = computeItBaseSpend(industry, revenueUsdM, region, tier);
      if (formula) itBaseUsdMillion = formula.usdMillion;
    }
    if (itBaseUsdMillion != null) {
      itBreakdown = computeItLevel3Breakdown(industry, itBaseUsdMillion, revenueUsdM);
    }
    const itSpendTrend = computeItSpendTrend(industry, revenueUsdM, region, tier);

    // ── ERD base value: disclosed R&D if found, else formula (ERD-eligible only) ──
    let erdSpendTrend: SpendResult['erdSpendTrend'];
    if (isErdEligible(industry)) {
      erdApplicable = true;
      if (spendResult.rdSpend.found && spendResult.rdSpend.valueRaw) {
        erdBaseUsdMillion = spendResult.rdSpend.valueRaw / 1_000_000;
      } else {
        const formula = computeErdBaseSpend(industry, revenueUsdM, region, tier);
        if (formula) erdBaseUsdMillion = formula.usdMillion;
      }
      if (erdBaseUsdMillion != null) {
        erdBreakdown = computeErdBreakdown(industry, erdBaseUsdMillion, tier);
      }
      erdSpendTrend = computeErdSpendTrend(industry, revenueUsdM, region, tier);
    }

    // ── Emerging Tech (incl. AI, Blockchain) breakdown ────────────────────────
    // AI priority: disclosed research figure > ERD's "AI/ML & Data Engineering" line > formula.
    // Blockchain: always sourced from the IT breakdown's Services → Digital Enterprise →
    // Blockchain line item (never the formula-computed Emerging Tech value).
    if (itBaseUsdMillion != null) {
      const disclosedAi = spendResult.aiSpend.found && spendResult.aiSpend.valueRaw
        ? spendResult.aiSpend.valueRaw / 1_000_000
        : undefined;
      const erdAiLine = erdBreakdown ? findErdCategoryValue(erdBreakdown, 'AI/ML & Data Engineering') : undefined;
      const aiOverride = disclosedAi ?? erdAiLine;

      const blockchainOverride = itBreakdown
        ? findItLevel3Value(itBreakdown, 'Services', 'Digital Enterprise', 'Blockchain')
        : undefined;

      emergingTechBreakdown = computeEmergingTechBreakdown(industry, itBaseUsdMillion, region, tier, aiOverride, blockchainOverride, revenueUsdM);
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
      resolvedIndustry: industry,
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
