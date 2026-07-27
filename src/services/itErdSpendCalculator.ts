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
  IT_LEVEL3_EXCLUSION,
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

// 7-tier scheme used only by the IT Level-3 exclusion matrix (2026-07-27 source file) —
// distinct boundaries from the 6-tier RevenueTier above, which drives the base %
// region/tier adjustment and is unrelated to this exclusion feature.
export type ExclusionTier = 0 | 1 | 2 | 3 | 4 | 5 | 6; // index into the 7-element flag array
export function resolveExclusionTierIndex(revenueUsdMillion: number): ExclusionTier {
  if (revenueUsdMillion < 25) return 0;      // T1 <$25M
  if (revenueUsdMillion < 100) return 1;     // T2 $25M-$100M
  if (revenueUsdMillion < 500) return 2;     // T3 $100M-$500M
  if (revenueUsdMillion < 1000) return 3;    // T4 $500M-$1B
  if (revenueUsdMillion < 5000) return 4;    // T5 $1B-$5B
  if (revenueUsdMillion < 10000) return 5;   // T6 $5B-$10B
  return 6;                                   // T7 >$10B
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
 *
 * Exclusion + redistribution (2026-07-27): if `revenueUsdMillion` is provided, any
 * Level-3 item flagged excluded for this industry/revenue-tier (per
 * IT_LEVEL3_EXCLUSION — e.g. "MPLS & Dedicated Transport Core" is not warranted below
 * $500M revenue) is forced to 0%, and its % is redistributed EQUALLY among the other
 * still-active items in the same Level-2 group (not proportionally — a flat split).
 * If every item in a Level-2 group is excluded, that group's total simply drops to 0
 * (nothing to redistribute into).
 */
export function computeItLevel3Breakdown(industry: string, baseUsdMillion: number, revenueUsdMillion?: number): Level3BreakdownRow[] {
  const rawPct = IT_LEVEL3_PCT[industry];
  if (!rawPct) return [];
  const rawTotal = IT_LEVEL3_TAXONOMY.reduce((sum, item) => sum + (rawPct[item.level3] ?? 0), 0);
  if (rawTotal <= 0) return [];

  // Base normalized % per item, before any exclusion.
  const normalized = IT_LEVEL3_TAXONOMY.map((item) => ({
    level1: item.level1,
    level2: item.level2,
    level3: item.level3,
    pct: (rawPct[item.level3] ?? 0) / rawTotal,
  }));

  if (revenueUsdMillion == null) {
    return normalized.map((r) => ({ ...r, pctOfBudget: r.pct, usdMillion: baseUsdMillion * r.pct }));
  }

  const tierIdx = resolveExclusionTierIndex(revenueUsdMillion);
  const excluded = new Set(
    normalized.filter((r) => (IT_LEVEL3_EXCLUSION[r.level3]?.[industry]?.[tierIdx] ?? 0) === 1).map((r) => r.level3)
  );

  // Redistribute each excluded item's % equally among the other active items in the same Level-2 group.
  const adjustedPct = new Map<string, number>(normalized.map((r) => [r.level3, excluded.has(r.level3) ? 0 : r.pct]));
  const level2Groups = new Map<string, typeof normalized>();
  for (const r of normalized) {
    if (!level2Groups.has(r.level2)) level2Groups.set(r.level2, []);
    level2Groups.get(r.level2)!.push(r);
  }
  for (const [, items] of level2Groups) {
    const excludedInGroup = items.filter((r) => excluded.has(r.level3));
    const activeInGroup = items.filter((r) => !excluded.has(r.level3));
    if (excludedInGroup.length === 0 || activeInGroup.length === 0) continue;
    const freedPct = excludedInGroup.reduce((sum, r) => sum + r.pct, 0);
    const share = freedPct / activeInGroup.length;
    for (const r of activeInGroup) {
      adjustedPct.set(r.level3, (adjustedPct.get(r.level3) ?? 0) + share);
    }
  }

  return normalized.map((r) => {
    const pctOfBudget = adjustedPct.get(r.level3) ?? 0;
    return { level1: r.level1, level2: r.level2, level3: r.level3, pctOfBudget, usdMillion: baseUsdMillion * pctOfBudget };
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
