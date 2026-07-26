import {
  IT_BASE_PCT_BY_YEAR,
  ERD_BASE_PCT_BY_YEAR,
  REGION_ADJ,
  REVENUE_TIER_ADJ,
  TECH_REGION_ADJ,
  TECH_TIER_ADJ,
  EMERGING_TECH_BASE_PCT,
  COUNTRY_TO_REGION,
  ERD_CATEGORY_SPLIT,
  ERD_CATEGORY_TIER_ADJ,
  IT_LEVEL3_TAXONOMY,
  IT_LEVEL3_PCT,
  ERD_ELIGIBLE_INDUSTRIES,
} from '../data/itErdSpendData';

// ── Base year (Jan-Sep -> last year, Oct-Dec -> this year — same convention used elsewhere) ──
function getBaseYear(): number {
  const month = new Date().getMonth() + 1;
  return month <= 9 ? new Date().getFullYear() - 1 : new Date().getFullYear();
}

const YEARS = [2022, 2023, 2024, 2025, 2026, 2027, 2028, 2029, 2030];

export type Region = 'US' | 'EU' | 'APAC' | 'ROW1' | 'ROW2';
export type RevenueTier = '>$5B' | '$1B-$5B' | '$500M-$1B' | '$100M-$500M' | '$10M-$100M' | '<$10M';

export function resolveRegion(hqCountry?: string): Region {
  if (!hqCountry) return 'US';
  const region = COUNTRY_TO_REGION[hqCountry.trim()];
  return (region as Region) || 'US';
}

export function resolveRevenueTier(revenueUsdMillion: number): RevenueTier {
  if (revenueUsdMillion >= 5000) return '>$5B';
  if (revenueUsdMillion >= 1000) return '$1B-$5B';
  if (revenueUsdMillion >= 500) return '$500M-$1B';
  if (revenueUsdMillion >= 100) return '$100M-$500M';
  if (revenueUsdMillion >= 10) return '$10M-$100M';
  return '<$10M';
}

export function isErdEligible(industry: string): boolean {
  return ERD_ELIGIBLE_INDUSTRIES.includes(industry);
}

export interface BaseSpendResult {
  usdMillion: number;
  pctOfRevenue: number;
  source: 'formula';
}

/** IT Spend % of revenue for the base year, region+revenue-tier adjusted (fully specified, no open questions — §2/§3 of the build notes). */
export function computeItBaseSpend(industry: string, revenueUsdMillion: number, region: Region, tier: RevenueTier): BaseSpendResult | null {
  const yearly = IT_BASE_PCT_BY_YEAR[industry];
  if (!yearly) return null;
  const yearIdx = YEARS.indexOf(getBaseYear());
  const basePct = yearly[yearIdx >= 0 ? yearIdx : yearly.length - 1];
  const regionAdj = REGION_ADJ[region] ?? 0;
  const tierAdj = REVENUE_TIER_ADJ[tier] ?? 0;
  const pctOfRevenue = (basePct * (1 + regionAdj) * (1 + tierAdj)) / 100;
  return { usdMillion: revenueUsdMillion * pctOfRevenue, pctOfRevenue, source: 'formula' };
}

/** ERD Spend % of revenue — only for the 14 ERD-eligible industries. */
export function computeErdBaseSpend(industry: string, revenueUsdMillion: number, region: Region, tier: RevenueTier): BaseSpendResult | null {
  const yearly = ERD_BASE_PCT_BY_YEAR[industry];
  if (!yearly) return null;
  const yearIdx = YEARS.indexOf(getBaseYear());
  const basePct = yearly[yearIdx >= 0 ? yearIdx : yearly.length - 1];
  const regionAdj = REGION_ADJ[region] ?? 0;
  const tierAdj = REVENUE_TIER_ADJ[tier] ?? 0;
  const pctOfRevenue = (basePct * (1 + regionAdj) * (1 + tierAdj)) / 100;
  return { usdMillion: revenueUsdMillion * pctOfRevenue, pctOfRevenue, source: 'formula' };
}

export interface Level3BreakdownRow {
  level1: string;
  level2: string;
  level3: string;
  pctOfBudget: number; // renormalized to sum to 1.0 across all rows
  usdMillion: number;
}

/**
 * IT Level-3 category breakdown. Renormalizes the raw allocation %s (which sum to
 * 84-98% in the source data, never exactly 100%) to a clean 100% so the rows fully
 * exhaust `baseUsdMillion` — see build-notes §13, Q7 (resolved this way for this
 * implementation: full renormalization, no separate "Other/Unclassified" line).
 */
export function computeItLevel3Breakdown(industry: string, baseUsdMillion: number): Level3BreakdownRow[] {
  const rawPct = IT_LEVEL3_PCT[industry];
  if (!rawPct) return [];
  const rawTotal = IT_LEVEL3_TAXONOMY.reduce((sum, item) => sum + (rawPct[item.level3] ?? 0), 0);
  if (rawTotal <= 0) return [];
  return IT_LEVEL3_TAXONOMY.map((item) => {
    const raw = rawPct[item.level3] ?? 0;
    const pctOfBudget = raw / rawTotal;
    return { level1: item.level1, level2: item.level2, level3: item.level3, pctOfBudget, usdMillion: baseUsdMillion * pctOfBudget };
  });
}

export interface ErdBreakdownRow {
  category: string;
  basePct: number;
  adjPct: number;
  finalPct: number; // renormalized
  usdMillion: number;
}

export function computeErdBreakdown(industry: string, baseUsdMillion: number, tier: RevenueTier): ErdBreakdownRow[] {
  const split = ERD_CATEGORY_SPLIT[industry];
  const adj = ERD_CATEGORY_TIER_ADJ[industry];
  if (!split) return [];
  const categories = Object.keys(split).filter((k) => k !== 'Row Total');
  const tilted = categories.map((cat) => {
    const basePct = split[cat] ?? 0;
    const adjPct = adj?.[cat]?.[tier] ?? 0;
    return { category: cat, basePct, adjPct, tiltedPct: basePct * (1 + adjPct) };
  });
  const total = tilted.reduce((sum, t) => sum + t.tiltedPct, 0);
  if (total <= 0) return [];
  return tilted.map((t) => ({
    category: t.category,
    basePct: t.basePct,
    adjPct: t.adjPct,
    finalPct: t.tiltedPct / total,
    usdMillion: baseUsdMillion * (t.tiltedPct / total),
  }));
}

export interface EmergingTechRow {
  tech: string;
  pctOfIt: number;
  usdMillion: number;
}

/**
 * 8-category Emerging Tech breakdown (AI, Blockchain, Cloud & Edge, Connectivity,
 * Quantum, Robotics, Spatial, Big Data). `aiOverrideUsdMillion` lets a disclosed
 * AI-spend figure replace the formula-computed AI line — the remaining 7 lines stay
 * as computed, and the caller should sum this array for the adjusted overall total.
 */
export function computeEmergingTechBreakdown(
  industry: string,
  itBaseUsdMillion: number,
  region: Region,
  tier: RevenueTier,
  aiOverrideUsdMillion?: number
): EmergingTechRow[] {
  const base = EMERGING_TECH_BASE_PCT[industry];
  if (!base) return [];
  return Object.entries(base).map(([tech, basePct]) => {
    if (tech === 'AI (ML/DL/GenAI & Safety)' && aiOverrideUsdMillion != null) {
      return { tech, pctOfIt: aiOverrideUsdMillion / itBaseUsdMillion, usdMillion: aiOverrideUsdMillion };
    }
    const regionAdj = (TECH_REGION_ADJ[tech]?.[region] ?? 0) / 100;
    const tierAdj = (TECH_TIER_ADJ[tech]?.[tier] ?? 0) / 100;
    const pctOfIt = (basePct / 100) * (1 + regionAdj) * (1 + tierAdj);
    return { tech, pctOfIt, usdMillion: itBaseUsdMillion * pctOfIt };
  });
}
