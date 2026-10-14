import {
  MARKETING_YEARS,
  MARKETING_TAXONOMY,
  MARKETING_REVENUE_TIERS,
  MARKETING_ARCHETYPE_ELASTICITY,
  MARKETING_TIER_L2_MIX,
  MARKETING_HQ_REGIONS,
  MARKETING_ARCHETYPES,
  MARKETING_INDUSTRIES,
} from '../data/marketingSpendData';
import { resolveExclusionTierIndex, getBaseYear, ExclusionTier } from './itErdSpendCalculator';
import { MarketingSpendPayload, MarketingSpendTrendPoint, MarketingSalesCeiling, SpendBreakdownNode } from '@ai-insights/types';

// ── Marketing Spend benchmark calculator ─────────────────────────────────────
// Static-table maths, like the IT/ERD calculator — no research call. The source
// JSON (scripts/marketing-spend-data.py) publishes, per industry, the marketing
// budget as % of revenue for a $1B-$5B US-HQ firm (2022-2030) and a 91-line Level-3
// mix per year. Revenue tier and HQ region move both:
//
//   % of revenue = industry % [year] x tierMult x regionIntensity
//     tierMult   = 1 + (tier base multiplier - 1) x archetype elasticity
//   mix          = L3 share [year] x tier L2 multiplier x region L2 multiplier,
//                  renormalized to 100%
//
// The script refuses to extract a source file whose global multipliers do not
// reproduce its own per-industry tier/region tables, so these formulas are pinned
// to the published numbers, not an interpretation of them.

export const MEDIA_AND_ADVERTISING = 'Media & Advertising';
export const MARKETING_BASE_REGION = 'North America – United States';

// ── HQ geography -> one of the 16 marketing regions ──
// Free-text geography from the form ("United States", "Redmond, WA, USA", "UK").
// Countries the source does not name are put in the nearest region by market
// structure (e.g. Switzerland -> Western Europe, Taiwan/Hong Kong -> China).
const REGION_COUNTRIES: Record<string, string[]> = {
  'North America – United States': ['united states', 'united states of america', 'usa', 'us', 'america', 'puerto rico'],
  'North America – Canada': ['canada'],
  'UK & Ireland': ['united kingdom', 'uk', 'great britain', 'britain', 'england', 'scotland', 'wales', 'northern ireland', 'ireland'],
  'Western Europe (DACH, France, Benelux)': ['germany', 'austria', 'switzerland', 'liechtenstein', 'france', 'monaco', 'belgium', 'netherlands', 'holland', 'luxembourg'],
  'Southern Europe (Italy, Spain, Portugal, Greece)': ['italy', 'spain', 'portugal', 'greece', 'malta', 'cyprus', 'andorra', 'san marino'],
  Nordics: ['sweden', 'norway', 'denmark', 'finland', 'iceland'],
  'Central & Eastern Europe': [
    'poland', 'czech republic', 'czechia', 'slovakia', 'hungary', 'romania', 'bulgaria', 'croatia', 'slovenia', 'serbia',
    'bosnia', 'montenegro', 'albania', 'north macedonia', 'estonia', 'latvia', 'lithuania', 'ukraine', 'belarus', 'moldova',
    'russia', 'turkey', 'turkiye', 'georgia', 'armenia', 'azerbaijan', 'kazakhstan', 'uzbekistan', 'kyrgyzstan', 'tajikistan',
    'turkmenistan',
  ],
  Japan: ['japan'],
  'South Korea': ['south korea', 'korea', 'republic of korea'],
  China: ['china', 'prc', 'hong kong', 'macau', 'macao', 'taiwan', 'mongolia'],
  India: ['india', 'pakistan', 'bangladesh', 'sri lanka', 'nepal', 'bhutan', 'maldives', 'afghanistan'],
  ASEAN: ['singapore', 'malaysia', 'indonesia', 'thailand', 'vietnam', 'philippines', 'myanmar', 'burma', 'cambodia', 'laos', 'brunei', 'timor-leste'],
  'Australia & New Zealand': ['australia', 'new zealand', 'papua new guinea', 'fiji', 'samoa', 'tonga', 'vanuatu', 'new caledonia'],
  'Middle East (GCC)': [
    'saudi arabia', 'ksa', 'united arab emirates', 'uae', 'qatar', 'kuwait', 'bahrain', 'oman', 'israel', 'jordan', 'lebanon',
    'iraq', 'iran', 'syria', 'yemen', 'palestine',
  ],
  Africa: [
    'south africa', 'nigeria', 'kenya', 'egypt', 'morocco', 'algeria', 'tunisia', 'ghana', 'ethiopia', 'tanzania', 'uganda',
    'angola', 'ivory coast', "cote d'ivoire", 'senegal', 'cameroon', 'rwanda', 'zambia', 'zimbabwe', 'botswana', 'namibia',
    'mozambique', 'madagascar', 'mauritius', 'congo', 'libya', 'sudan',
  ],
  'Latin America': [
    'brazil', 'mexico', 'argentina', 'chile', 'colombia', 'peru', 'ecuador', 'venezuela', 'bolivia', 'paraguay', 'uruguay',
    'costa rica', 'panama', 'guatemala', 'honduras', 'el salvador', 'nicaragua', 'dominican republic', 'cuba', 'jamaica',
    'trinidad and tobago', 'bahamas', 'barbados', 'belize', 'guyana', 'suriname', 'haiti',
  ],
};

const COUNTRY_TO_MARKETING_REGION = new Map<string, string>();
for (const [region, countries] of Object.entries(REGION_COUNTRIES)) {
  for (const country of countries) COUNTRY_TO_MARKETING_REGION.set(country, region);
}
// Longest names first, so "united states of america" wins over "america".
const COUNTRY_NAMES_BY_LENGTH = [...COUNTRY_TO_MARKETING_REGION.keys()].sort((a, b) => b.length - a.length);

function normalizeGeography(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ /g, ' ')
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/[^a-z' -]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Free-text HQ geography -> one of the 16 marketing regions; blank/unknown -> US (the base case). */
export function resolveMarketingRegion(geography?: string): string {
  if (!geography || !geography.trim()) return MARKETING_BASE_REGION;
  if (MARKETING_HQ_REGIONS[geography.trim()]) return geography.trim(); // already a region name
  // "Atlanta, Georgia, USA": addresses end with the country, so try whole comma
  // segments from the last one back — otherwise the US state would read as Georgia.
  const segments = geography.split(',').map(normalizeGeography).filter(Boolean);
  for (const segment of [...segments].reverse()) {
    const region = COUNTRY_TO_MARKETING_REGION.get(segment);
    if (region) return region;
  }
  // "Headquartered in Mumbai India" — a whole-word country name anywhere in the text.
  const padded = ` ${segments.join(' ')} `;
  for (const name of COUNTRY_NAMES_BY_LENGTH) {
    if (name.length < 3) continue; // "us"/"uk" only as a whole segment — too ambiguous inside text
    if (padded.includes(` ${name} `)) return COUNTRY_TO_MARKETING_REGION.get(name)!;
  }
  return MARKETING_BASE_REGION;
}

export function isMarketingIndustry(industry: string): boolean {
  return !!MARKETING_INDUSTRIES[industry];
}

export function marketingTierLabel(tierIdx: ExclusionTier): string {
  return MARKETING_REVENUE_TIERS[tierIdx].tier;
}

/** Industry-specific revenue-tier intensity multiplier (archetype-elasticity damped). */
export function marketingTierMultiplier(industry: string, tierIdx: ExclusionTier): number {
  const row = MARKETING_INDUSTRIES[industry];
  if (!row) return 1;
  const elasticity = MARKETING_ARCHETYPE_ELASTICITY[row.archetype] ?? 1;
  return 1 + (MARKETING_REVENUE_TIERS[tierIdx].multiplier - 1) * elasticity;
}

/** Marketing budget as a fraction of revenue for every year 2022-2030. */
export function computeMarketingPctByYear(industry: string, region: string, tierIdx: ExclusionTier): number[] {
  const row = MARKETING_INDUSTRIES[industry];
  if (!row) return [];
  const regionIntensity = MARKETING_HQ_REGIONS[region]?.intensity ?? 1;
  const tierMult = marketingTierMultiplier(industry, tierIdx);
  return row.pctRevenue.map((pct) => pct * tierMult * regionIntensity);
}

export interface MarketingMixRow {
  code: string;
  level1: string;
  level2: string;
  level3: string;
  share: number; // share of the total marketing budget, sums to 1 across the 91 rows
}

/** 91-line Level-3 mix for one year, reweighted for revenue tier and HQ region. */
export function computeMarketingMix(industry: string, year: number, region: string, tierIdx: ExclusionTier): MarketingMixRow[] {
  const row = MARKETING_INDUSTRIES[industry];
  if (!row) return [];
  const yearIdx = Math.max(0, MARKETING_YEARS.indexOf(year));
  const shares = row.l3Share[yearIdx];
  const regionL2 = MARKETING_HQ_REGIONS[region]?.l2Mix ?? {};
  const weighted = MARKETING_TAXONOMY.map((item, i) => {
    const tierL2 = MARKETING_TIER_L2_MIX[item.l2Key]?.[tierIdx] ?? 1;
    return (shares[i] ?? 0) * tierL2 * (regionL2[item.l2Key] ?? 1);
  });
  const total = weighted.reduce((s, w) => s + w, 0);
  if (total <= 0) return [];
  return MARKETING_TAXONOMY.map((item, i) => ({
    code: item.code,
    level1: item.level1,
    level2: item.level2,
    level3: item.level3,
    share: weighted[i] / total,
  }));
}

/** Groups the flat 91-row allocation into the same L1 -> L2 -> L3 tree shape the IT
 *  breakdown uses (percentage is of the grand total at every level). */
export function buildMarketingBreakdownTree(rows: Array<MarketingMixRow & { usdMillion: number }>, totalUsdMillion: number): SpendBreakdownNode[] {
  const l1Order: string[] = [];
  const l1Map = new Map<string, Map<string, Array<MarketingMixRow & { usdMillion: number }>>>();
  for (const row of rows) {
    if (!l1Map.has(row.level1)) { l1Map.set(row.level1, new Map()); l1Order.push(row.level1); }
    const l2Map = l1Map.get(row.level1)!;
    if (!l2Map.has(row.level2)) l2Map.set(row.level2, []);
    l2Map.get(row.level2)!.push(row);
  }
  const pctOf = (v: number) => (totalUsdMillion > 0 ? (v / totalUsdMillion) * 100 : 0);
  return l1Order.map((l1Name) => {
    const l2Nodes: SpendBreakdownNode[] = [...l1Map.get(l1Name)!.entries()].map(([l2Name, items]) => {
      const l3Nodes: SpendBreakdownNode[] = items.map((r) => ({
        id: `L3-${l1Name}-${l2Name}-${r.level3}`,
        name: r.level3,
        level: 2,
        value: r.usdMillion,
        percentage: pctOf(r.usdMillion),
      }));
      const l2Value = items.reduce((s, r) => s + r.usdMillion, 0);
      return { id: `L2-${l1Name}-${l2Name}`, name: l2Name, level: 1, value: l2Value, percentage: pctOf(l2Value), children: l3Nodes };
    });
    const l1Value = l2Nodes.reduce((s, n) => s + n.value, 0);
    return { id: `L1-${l1Name}`, name: l1Name, level: 0, value: l1Value, percentage: pctOf(l1Value), children: l2Nodes };
  });
}

function cagr(startValue: number, endValue: number, years: number): number {
  if (startValue <= 0 || years <= 0) return 0;
  return (Math.pow(endValue / startValue, 1 / years) - 1) * 100;
}

export interface MarketingDisclosedOverrides {
  totalUsdMillion?: number;             // disclosed total marketing budget — replaces the benchmark total
  advertisingUsdMillion?: number;       // disclosed advertising expense — pins the Media & Advertising L1 line
  salesAndMarketingUsdMillion?: number; // disclosed Sales & Marketing line — caps a benchmark total
}

/**
 * Most a benchmark marketing estimate may take of a disclosed Sales & Marketing line,
 * by archetype. S&M also carries the sales force, whose share differs by business
 * model: consumer brands spend S&M mostly on marketing, B2B firms mostly on sales
 * headcount. Product decision 2026-10-14 (the source JSON has no such ratio) — it
 * came from the benchmark putting Microsoft's marketing at $22.9B, 85% of its
 * $26.7B Sales & Marketing line.
 */
export const MARKETING_SHARE_OF_SALES_AND_MARKETING: Record<string, number> = {
  A1: 0.7, // B2C Mass Brand
  A2: 0.7, // B2C Digital-First
  A3: 0.7, // Retail (Omnichannel)
  A4: 0.7, // B2C Regulated Financial
  A5: 0.4, // B2B Technology
  A6: 0.4, // B2B Services & Institutional
  A7: 0.4, // B2B Industrial & Asset-Heavy
  A8: 0.5, // Healthcare & Life Sciences
  A9: 0.5, // Public, Non-Profit & Education
};

/**
 * Full Marketing Spend payload for the base year.
 *
 * Disclosed figures outrank the benchmark, mirroring how the IT module treats a
 * disclosed IT budget (total) and a disclosed AI budget (one line):
 * - Total disclosed: it becomes the headline; the benchmark mix splits it.
 * - Advertising disclosed: the Media & Advertising L1 group is pinned to it (its
 *   L2/L3 lines keep their benchmark proportions). The other six L1 groups take the
 *   rest of a disclosed total, or keep their benchmark dollars when no total was
 *   disclosed (the headline is then advertising + benchmark non-advertising).
 *   Advertising >= a disclosed total is contradictory, so it is ignored then.
 * - Sales & Marketing disclosed and no marketing total: the estimate may not exceed
 *   MARKETING_SHARE_OF_SALES_AND_MARKETING x S&M. Above it, the benchmark lines are
 *   scaled down to the cap (a disclosed advertising line keeps its value). If the
 *   disclosed advertising alone is at or above the cap the figures contradict each
 *   other, so the cap is reported but not applied.
 *
 * Unlike the IT trend, the 2022-2030 trend is scaled by headline / benchmark so the
 * base-year point always equals the headline figure; the curve's shape and CAGR are
 * the benchmark's.
 */
export function computeMarketingSpend(
  input: { companyName: string; geography?: string; industry: string; revenueUsdMillion: number },
  overrides: MarketingDisclosedOverrides = {}
): MarketingSpendPayload | null {
  const { industry, companyName, revenueUsdMillion } = input;
  const row = MARKETING_INDUSTRIES[industry];
  if (!row) return null;

  const region = resolveMarketingRegion(input.geography);
  const tierIdx = resolveExclusionTierIndex(revenueUsdMillion);
  const baseYear = getBaseYear();
  const baseIdx = Math.max(0, MARKETING_YEARS.indexOf(baseYear));
  const pctByYear = computeMarketingPctByYear(industry, region, tierIdx);
  const benchmarkTotal = revenueUsdMillion * pctByYear[baseIdx];
  const mix = computeMarketingMix(industry, baseYear, region, tierIdx);
  const isAdvertising = (r: MarketingMixRow) => r.level1 === MEDIA_AND_ADVERTISING;
  const advShare = mix.filter(isAdvertising).reduce((s, r) => s + r.share, 0);

  const disclosedTotal = overrides.totalUsdMillion != null && overrides.totalUsdMillion > 0 ? overrides.totalUsdMillion : undefined;
  let disclosedAdv = overrides.advertisingUsdMillion != null && overrides.advertisingUsdMillion > 0 ? overrides.advertisingUsdMillion : undefined;
  if (disclosedAdv != null && (advShare <= 0 || (disclosedTotal != null && disclosedAdv >= disclosedTotal))) disclosedAdv = undefined;

  const allocated = mix.map((r) => {
    let usdMillion: number;
    if (disclosedAdv != null) {
      if (isAdvertising(r)) usdMillion = disclosedAdv * (r.share / advShare);
      else if (disclosedTotal != null) usdMillion = (disclosedTotal - disclosedAdv) * (r.share / (1 - advShare));
      else usdMillion = benchmarkTotal * r.share;
    } else {
      usdMillion = (disclosedTotal ?? benchmarkTotal) * r.share;
    }
    return { ...r, usdMillion };
  });
  let total = allocated.reduce((s, r) => s + r.usdMillion, 0);

  let ceiling: MarketingSalesCeiling | undefined;
  const salesAndMarketing = overrides.salesAndMarketingUsdMillion;
  if (salesAndMarketing != null && salesAndMarketing > 0) {
    const capShare = MARKETING_SHARE_OF_SALES_AND_MARKETING[row.archetype] ?? 0.5;
    const capUsdMillion = salesAndMarketing * capShare;
    const pinned = disclosedAdv ?? 0;
    const applied = disclosedTotal == null && total > capUsdMillion && pinned < capUsdMillion;
    if (applied) {
      const free = allocated.filter((r) => !(disclosedAdv != null && isAdvertising(r)));
      const freeSum = free.reduce((s, r) => s + r.usdMillion, 0);
      const factor = freeSum > 0 ? (capUsdMillion - pinned) / freeSum : 1;
      for (const r of free) r.usdMillion *= factor;
      total = allocated.reduce((s, r) => s + r.usdMillion, 0);
    }
    ceiling = { salesAndMarketingUsdMillion: salesAndMarketing, capShare, capUsdMillion, applied };
  }

  const scale = benchmarkTotal > 0 ? total / benchmarkTotal : 1;
  let prev: number | null = null;
  const trends: MarketingSpendTrendPoint[] = MARKETING_YEARS.map((year, i) => {
    const marketingSpend = revenueUsdMillion * pctByYear[i] * scale;
    const marketingYoY = prev != null && prev !== 0 ? ((marketingSpend - prev) / Math.abs(prev)) * 100 : 0;
    prev = marketingSpend;
    return { year, marketingYoY, marketingSpend, marketingPercent: pctByYear[i] * scale * 100 };
  });
  const lastIdx = trends.length - 1;

  return {
    region,
    trends,
    country: input.geography ?? '',
    revenue: revenueUsdMillion,
    industry,
    companyName,
    currencyInfo: { currency: 'USD', revenueUSD: revenueUsdMillion, exchangeRateToUSD: 1 },
    archetype: MARKETING_ARCHETYPES[row.archetype] ?? row.archetypeName,
    revenueTier: marketingTierLabel(tierIdx),
    pctOfRevenue: revenueUsdMillion > 0 ? (total / revenueUsdMillion) * 100 : 0,
    totalSource: disclosedTotal != null ? 'disclosed' : ceiling?.applied ? 'capped' : 'benchmark',
    advertisingSource: disclosedAdv != null ? 'disclosed' : 'benchmark',
    ...(ceiling ? { salesAndMarketingCeiling: ceiling } : {}),
    marketingBreakdown: buildMarketingBreakdownTree(allocated, total),
    marketingCAGR_Historical: cagr(trends[0].marketingSpend, trends[baseIdx].marketingSpend, baseIdx),
    marketingCAGR_Forecast: cagr(trends[baseIdx].marketingSpend, trends[lastIdx].marketingSpend, lastIdx - baseIdx),
  };
}
