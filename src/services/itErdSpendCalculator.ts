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
  ERD_LEVEL3_MAP,
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
 * IT Level-3 category breakdown — 117 line items across 4 Level-1 categories
 * (Communications, Hardware, Services, Software), matching the live UI reference.
 * Source data (`IT Spend.xlsx` v2, "IT Spend L3 by Industry" sheet) already sums to
 * exactly 100% per industry; the /rawTotal division below is a harmless safety net
 * for rounding drift, not a real renormalization (build-notes §13, Q7 is now moot —
 * the earlier 84-98%-sum data source this note referred to has been superseded).
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
  level1: string;
  level2: string;
  category: string; // Level 3
  basePct: number;
  adjPct: number;
  finalPct: number; // renormalized
  usdMillion: number;
}

/** ERD Spend breakdown — 14 Level-3 categories, grouped into the Level-1/Level-2
 *  hierarchy provided 2026-07-26 (ERD_LEVEL3_MAP), mirroring the IT breakdown's shape. */
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
  return tilted.map((t) => {
    const hierarchy = ERD_LEVEL3_MAP[t.category] ?? { level1: 'Other', level2: 'Other' };
    return {
      level1: hierarchy.level1,
      level2: hierarchy.level2,
      category: t.category,
      basePct: t.basePct,
      adjPct: t.adjPct,
      finalPct: t.tiltedPct / total,
      usdMillion: baseUsdMillion * (t.tiltedPct / total),
    };
  });
}

/** Looks up a single Level-3 line item's $ value from an already-computed IT breakdown. */
export function findItLevel3Value(breakdown: Level3BreakdownRow[], level1: string, level2: string, level3: string): number | undefined {
  return breakdown.find((r) => r.level1 === level1 && r.level2 === level2 && r.level3 === level3)?.usdMillion;
}

/** Looks up a single ERD Level-3 category's $ value from an already-computed ERD breakdown. */
export function findErdCategoryValue(breakdown: ErdBreakdownRow[], category: string): number | undefined {
  return breakdown.find((r) => r.category === category)?.usdMillion;
}

export interface EmergingTechRow {
  tech: string;
  pctOfIt: number;
  usdMillion: number;
}

/**
 * 8-category Emerging Tech breakdown (AI, Blockchain, Cloud & Edge, Connectivity,
 * Quantum, Robotics, Spatial, Big Data).
 *
 * Overrides (2026-07-26):
 * - `aiOverrideUsdMillion`: AI line is replaced by, in priority order, (1) a disclosed
 *   AI-spend research figure if found, (2) the ERD breakdown's "AI/ML & Data
 *   Engineering" line if the industry is ERD-eligible — the caller resolves this
 *   priority and passes in whichever value wins.
 * - `blockchainOverrideUsdMillion`: Blockchain line is always replaced by the IT
 *   Level-3 breakdown's Services → Digital Enterprise → Blockchain line item value
 *   (not formula-computed) — the caller passes this in from the IT breakdown.
 *
 * Region/revenue-tier adjustments can drive a technology's % deeply negative for
 * small/niche combinations (e.g. Quantum Computing at the smallest revenue tier) —
 * negative results are clamped to exactly 0 ("not warranted for this tier/industry")
 * rather than left as a nonsensical negative spend figure.
 */
export function computeEmergingTechBreakdown(
  industry: string,
  itBaseUsdMillion: number,
  region: Region,
  tier: RevenueTier,
  aiOverrideUsdMillion?: number,
  blockchainOverrideUsdMillion?: number
): EmergingTechRow[] {
  const base = EMERGING_TECH_BASE_PCT[industry];
  if (!base) return [];
  return Object.entries(base).map(([tech, basePct]) => {
    if (tech === 'AI (ML/DL/GenAI & Safety)' && aiOverrideUsdMillion != null) {
      return { tech, pctOfIt: aiOverrideUsdMillion / itBaseUsdMillion, usdMillion: aiOverrideUsdMillion };
    }
    if (tech === 'Blockchain' && blockchainOverrideUsdMillion != null) {
      return { tech, pctOfIt: blockchainOverrideUsdMillion / itBaseUsdMillion, usdMillion: blockchainOverrideUsdMillion };
    }
    const regionAdj = (TECH_REGION_ADJ[tech]?.[region] ?? 0) / 100;
    const tierAdj = (TECH_TIER_ADJ[tech]?.[tier] ?? 0) / 100;
    const pctOfIt = Math.max(0, (basePct / 100) * (1 + regionAdj) * (1 + tierAdj));
    return { tech, pctOfIt, usdMillion: itBaseUsdMillion * pctOfIt };
  });
}

export interface TrendPoint {
  year: number;
  usdMillion: number;
}

/** 2022-2030 IT Spend trend, region+revenue-tier adjusted, for the trend chart. */
export function computeItSpendTrend(industry: string, revenueUsdMillion: number, region: Region, tier: RevenueTier): TrendPoint[] {
  const yearly = IT_BASE_PCT_BY_YEAR[industry];
  if (!yearly) return [];
  const regionAdj = REGION_ADJ[region] ?? 0;
  const tierAdj = REVENUE_TIER_ADJ[tier] ?? 0;
  return YEARS.map((year, idx) => {
    const pct = (yearly[idx] * (1 + regionAdj) * (1 + tierAdj)) / 100;
    return { year, usdMillion: revenueUsdMillion * pct };
  });
}

/** 2022-2030 ERD Spend trend — only for ERD-eligible industries. */
export function computeErdSpendTrend(industry: string, revenueUsdMillion: number, region: Region, tier: RevenueTier): TrendPoint[] {
  const yearly = ERD_BASE_PCT_BY_YEAR[industry];
  if (!yearly) return [];
  const regionAdj = REGION_ADJ[region] ?? 0;
  const tierAdj = REVENUE_TIER_ADJ[tier] ?? 0;
  return YEARS.map((year, idx) => {
    const pct = (yearly[idx] * (1 + regionAdj) * (1 + tierAdj)) / 100;
    return { year, usdMillion: revenueUsdMillion * pct };
  });
}
