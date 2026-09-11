// Regression tests for the IT / ERD / Emerging-Tech benchmark calculator.
//
// Two things are locked down here:
//   1. The shipped reference tables still agree with their source workbooks
//      ('Automated IT ERD Spend Calculator.xlsx' for the base %, country, ERD-split
//      and emerging-tech tables; 'IT Spend.xlsx' for the 117-item Level-3 taxonomy;
//      the two exclusion workbooks for the tier/industry exclusion matrices). A
//      stale copy of these tables shipped for ~6 weeks in 2026 and produced IT
//      spend figures 2-4x too high, so the shape/invariant checks below exist to
//      make that failure mode loud.
//   2. The Airbus worked example reproduces the reference output files
//      (ERD_Spend.json / IT_Spend.json) to the cent.
import {
  resolveRegion,
  resolveRevenueTier,
  isErdEligible,
  computeItBaseSpend,
  computeErdBaseSpend,
  computeItLevel3Breakdown,
  computeErdBreakdown,
  computeEmergingTechV2,
  computeItSpendTrendV2,
  computeErdSpendTrendV2,
  buildItBreakdownTree,
  buildErdBreakdownTree,
  findItLevel3Value,
  findErdCategoryValue,
} from '../services/itErdSpendCalculator';
import {
  IT_BASE_PCT_BY_YEAR,
  ERD_BASE_PCT_BY_YEAR,
  IT_LEVEL3_TAXONOMY,
  IT_LEVEL3_PCT,
  IT_LEVEL3_EXCLUSION,
  EMERGING_TECH_EXCLUSION,
  EMERGING_TECH_BASE_PCT,
  ERD_ELIGIBLE_INDUSTRIES,
  ERD_CATEGORY_SPLIT,
} from '../data/itErdSpendData';

const INDUSTRIES = Object.keys(IT_BASE_PCT_BY_YEAR);
// One revenue inside each of the 7 exclusion tiers (<$25M … >$10B).
const TIER_SAMPLE_REVENUES = [5, 50, 300, 700, 3000, 7000, 20000];

describe('reference tables', () => {
  it('covers 37 industries for IT and 14 for ERD, 9 years each', () => {
    expect(INDUSTRIES).toHaveLength(37);
    expect(Object.keys(ERD_BASE_PCT_BY_YEAR)).toHaveLength(14);
    expect(ERD_ELIGIBLE_INDUSTRIES).toHaveLength(14);
    for (const [industry, years] of Object.entries(IT_BASE_PCT_BY_YEAR)) {
      expect(`${industry}:${years.length}`).toBe(`${industry}:9`);
    }
    for (const [industry, years] of Object.entries(ERD_BASE_PCT_BY_YEAR)) {
      expect(`${industry}:${years.length}`).toBe(`${industry}:9`);
    }
  });

  // Guards the stale-table regression: the superseded tables had IT Services at
  // 20.5-46.8% of revenue and Healthcare Providers at 22% by 2030, which no real
  // benchmark supports. The current tables top out at 14.3% (Software's IT spend)
  // and 19.7% (Pharma's R&D spend, where a high share of revenue is expected).
  it('keeps every base % inside a plausible share-of-revenue band', () => {
    for (const [industry, years] of Object.entries(IT_BASE_PCT_BY_YEAR)) {
      for (const pct of years) {
        expect(`IT ${industry}:${pct >= 0.3 && pct <= 15}`).toBe(`IT ${industry}:true`);
      }
    }
    for (const [industry, years] of Object.entries(ERD_BASE_PCT_BY_YEAR)) {
      for (const pct of years) {
        expect(`ERD ${industry}:${pct >= 0.3 && pct <= 20}`).toBe(`ERD ${industry}:true`);
      }
    }
  });

  it('has a 117-item Level-3 taxonomy across the 4 live-UI Level-1 buckets', () => {
    expect(IT_LEVEL3_TAXONOMY).toHaveLength(117);
    expect([...new Set(IT_LEVEL3_TAXONOMY.map((t) => t.level1))]).toEqual([
      'Communications',
      'Hardware',
      'Services',
      'Software',
    ]);
    expect(new Set(IT_LEVEL3_TAXONOMY.map((t) => t.level3)).size).toBe(117);
  });

  it('allocates exactly 100% of the IT budget per industry, before exclusions', () => {
    for (const industry of INDUSTRIES) {
      const items = IT_LEVEL3_PCT[industry];
      expect(Object.keys(items)).toHaveLength(117);
      const sum = IT_LEVEL3_TAXONOMY.reduce((acc, t) => acc + items[t.level3], 0);
      expect(`${industry}:${sum.toFixed(6)}`).toBe(`${industry}:1.000000`);
    }
  });

  it('splits ERD 14 ways summing to ~100% per eligible industry', () => {
    for (const industry of ERD_ELIGIBLE_INDUSTRIES) {
      const split = ERD_CATEGORY_SPLIT[industry];
      const categories = Object.keys(split).filter((k) => k !== 'Row Total');
      expect(`${industry}:${categories.length}`).toBe(`${industry}:14`);
      // The source workbook's own rows carry rounding drift (1.0003 etc.) — kept as-is
      // rather than renormalized in the data file (build notes §8.8).
      const sum = categories.reduce((acc, c) => acc + split[c], 0);
      expect(Math.abs(sum - 1)).toBeLessThan(0.005);
    }
  });

  it('keys both exclusion matrices by industry with one flag per 7 revenue tiers', () => {
    expect(Object.keys(IT_LEVEL3_EXCLUSION)).toHaveLength(44);
    expect(Object.keys(EMERGING_TECH_EXCLUSION)).toHaveLength(8);
    const known = new Set(IT_LEVEL3_TAXONOMY.map((t) => t.level3));
    const industries = new Set(INDUSTRIES);
    // Only the industries an item is actually excluded in are listed; anything absent
    // is treated as never excluded.
    for (const [item, byIndustry] of Object.entries(IT_LEVEL3_EXCLUSION)) {
      expect(`${item}:${known.has(item)}`).toBe(`${item}:true`);
      expect(Object.keys(byIndustry).every((i) => industries.has(i))).toBe(true);
      for (const flags of Object.values(byIndustry)) {
        expect(flags).toHaveLength(7);
        expect(flags.every((f) => f === 0 || f === 1)).toBe(true);
        // Exclusions only ever relax as a company gets bigger — never re-appear.
        expect([...flags].sort((a, b) => b - a)).toEqual(flags);
      }
    }
    for (const [tech, byIndustry] of Object.entries(EMERGING_TECH_EXCLUSION)) {
      expect(`${tech}:${tech in EMERGING_TECH_BASE_PCT['Aerospace & Defence']}`).toBe(`${tech}:true`);
      expect(Object.keys(byIndustry).every((i) => industries.has(i))).toBe(true);
    }
  });
});

describe('input resolution', () => {
  it('maps HQ country to a region, defaulting to US when blank or unknown', () => {
    expect(resolveRegion('France')).toBe('EU');
    expect(resolveRegion('Italy')).toBe('EU');
    expect(resolveRegion('United States')).toBe('US');
    expect(resolveRegion(undefined)).toBe('US');
    expect(resolveRegion('Atlantis')).toBe('US');
  });

  it('buckets revenue into the 6 adjustment tiers on their exact boundaries', () => {
    expect(resolveRevenueTier(5000)).toBe('>$5B');
    expect(resolveRevenueTier(4999)).toBe('$1B-$5B');
    expect(resolveRevenueTier(1000)).toBe('$1B-$5B');
    expect(resolveRevenueTier(500)).toBe('$500M-$1B');
    expect(resolveRevenueTier(100)).toBe('$100M-$500M');
    expect(resolveRevenueTier(10)).toBe('$10M-$100M');
    expect(resolveRevenueTier(9.99)).toBe('<$10M');
  });
});

describe('exclusion handling', () => {
  it('zeroes excluded line items and keeps the breakdown at 100% of the IT budget', () => {
    for (const revenue of TIER_SAMPLE_REVENUES) {
      for (const industry of INDUSTRIES) {
        const rows = computeItLevel3Breakdown(industry, 1000, revenue);
        const label = `${industry} @ $${revenue}M`;
        expect(`${label}:${rows.length}`).toBe(`${label}:117`);
        const pctSum = rows.reduce((acc, r) => acc + r.pctOfBudget, 0);
        expect(`${label}:${pctSum.toFixed(6)}`).toBe(`${label}:1.000000`);
        const dollarSum = rows.reduce((acc, r) => acc + r.usdMillion, 0);
        expect(`${label}:${dollarSum.toFixed(4)}`).toBe(`${label}:1000.0000`);
        expect(rows.every((r) => r.pctOfBudget >= 0)).toBe(true);
      }
    }
  });

  it('excludes MPLS below $500M for every industry and restores it above', () => {
    // Retail keeps both Satellite Comms items at this tier, so Fixed Data absorbs
    // the freed MPLS share on its own with no cascade from a wiped sibling group.
    const small = computeItLevel3Breakdown('Retail', 1000, 300);
    const large = computeItLevel3Breakdown('Retail', 1000, 3000);
    const mpls = (rows: typeof small) => rows.find((r) => r.level3 === 'MPLS & Dedicated Transport Core')!;
    expect(mpls(small).usdMillion).toBe(0);
    expect(mpls(large).usdMillion).toBeGreaterThan(0);
    // Its share moves to the sibling item in the same Level-2 group, not out of the budget.
    const sibling = 'SD-WAN & SASE Network Services';
    expect(small.find((r) => r.level3 === sibling)!.pctOfBudget)
      .toBeCloseTo(large.find((r) => r.level3 === sibling)!.pctOfBudget + mpls(large).pctOfBudget, 10);
  });

  it('cascades a fully-excluded Level-2 group outward instead of dropping the money', () => {
    // Both Satellite Comms items are excluded for every tier below $500M.
    const rows = computeItLevel3Breakdown('Aerospace & Defence', 1000, 50);
    const satellite = rows.filter((r) => r.level2 === 'Satellite Comms');
    expect(satellite).toHaveLength(2);
    expect(satellite.every((r) => r.usdMillion === 0)).toBe(true);
    // The freed share lands on the surviving Communications items (same Level-1).
    const unexcluded = computeItLevel3Breakdown('Aerospace & Defence', 1000);
    const comms = (rows_: typeof rows) =>
      rows_.filter((r) => r.level1 === 'Communications').reduce((a, r) => a + r.pctOfBudget, 0);
    expect(comms(rows)).toBeCloseTo(comms(unexcluded), 10);
  });

  it('applies emerging-tech exclusions by tier and never returns a negative figure', () => {
    for (const revenue of TIER_SAMPLE_REVENUES) {
      for (const industry of INDUSTRIES) {
        const rows = computeEmergingTechV2(industry, 1000, 'US', resolveRevenueTier(revenue), undefined, undefined, revenue);
        const label = `${industry} @ $${revenue}M`;
        expect(`${label}:${rows.length}`).toBe(`${label}:8`);
        expect(`${label}:${rows.every((r) => r.value >= 0 && r.adjTotal >= 0)}`).toBe(`${label}:true`);
      }
    }
    // Every one of the 8 technologies is excluded in the smallest tier, so a micro
    // company gets no emerging-tech budget at all (source: EmergingTech_Exclusion_List).
    const micro = computeEmergingTechV2('Aerospace & Defence', 1000, 'US', '<$10M', undefined, undefined, 5);
    expect(micro.every((r) => r.value === 0)).toBe(true);
    const enterprise = computeEmergingTechV2('Aerospace & Defence', 1000, 'US', '>$5B', undefined, undefined, 20000);
    expect(enterprise.every((r) => r.value > 0)).toBe(true);
  });

  it('leaves overridden AI and Blockchain lines untouched by redistribution', () => {
    const rows = computeEmergingTechV2('Aerospace & Defence', 1000, 'US', '$100M-$500M', 42, 7, 300);
    expect(rows.find((r) => r.tech === 'AI (ML/DL/GenAI & Safety)')!.value).toBe(42);
    expect(rows.find((r) => r.tech === 'Blockchain')!.value).toBe(7);
  });
});

describe('ERD applicability', () => {
  it('computes ERD only for the 14 engineering-heavy industries', () => {
    expect(isErdEligible('Aerospace & Defence')).toBe(true);
    expect(isErdEligible('Retail')).toBe(false);
    expect(computeErdBaseSpend('Retail', 1000, 'US', '>$5B')).toBeNull();
    expect(computeErdBreakdown('Retail', 1000, '>$5B')).toEqual([]);
    expect(computeErdSpendTrendV2('Retail', 1000, 'US', '>$5B')).toEqual([]);
    // …while IT still works for those industries.
    expect(computeItBaseSpend('Retail', 1000, 'US', '>$5B')!.usdMillion).toBeGreaterThan(0);
  });

  it('splits ERD into 14 categories summing to the ERD budget', () => {
    const rows = computeErdBreakdown('Automotive', 500, '$1B-$5B');
    expect(rows).toHaveLength(14);
    expect(rows.reduce((a, r) => a + r.usdMillion, 0)).toBeCloseTo(500, 6);
    expect(rows.reduce((a, r) => a + r.finalPct, 0)).toBeCloseTo(1, 10);
  });
});

// ── Airbus worked example — reproduces ERD_Spend.json / IT_Spend.json ──────────
// Inputs: Airbus, France (EU), $73,420M revenue, Aerospace & Defence, tier >$5B.
describe('Airbus reference output', () => {
  const industry = 'Aerospace & Defence';
  const revenue = 73420;
  const region = resolveRegion('France');
  const tier = resolveRevenueTier(revenue);

  it('reproduces the published IT trend series', () => {
    const trend = computeItSpendTrendV2(industry, revenue, region, tier);
    expect(trend.map((p) => [p.year, +p.itPercent.toFixed(4), +p.itSpend.toFixed(4)])).toEqual([
      [2022, 2.66, 1952.972],
      [2023, 2.755, 2022.721],
      [2024, 2.85, 2092.47],
      [2025, 2.945, 2162.219],
      [2026, 3.0495, 2238.9429],
      [2027, 3.1635, 2322.6417],
      [2028, 3.268, 2399.3656],
      [2029, 3.382, 2483.0644],
      [2030, 3.5055, 2573.7381],
    ]);
  });

  it('reproduces the published ERD trend series', () => {
    const trend = computeErdSpendTrendV2(industry, revenue, region, tier);
    expect(trend.map((p) => [p.year, +p.erdPercent.toFixed(4), +p.erdSpend.toFixed(4)])).toEqual([
      [2022, 3.5435, 2601.6377],
      [2023, 3.667, 2692.3114],
      [2024, 3.8, 2789.96],
      [2025, 3.933, 2887.6086],
      [2026, 4.066, 2985.2572],
      [2027, 4.2085, 3089.8807],
      [2028, 4.3605, 3201.4791],
      [2029, 4.5125, 3313.0775],
      [2030, 4.674, 3431.6508],
    ]);
  });

  it('reproduces the published ERD category mix', () => {
    const erdBase = computeErdBaseSpend(industry, revenue, region, tier)!;
    const rows = computeErdBreakdown(industry, erdBase.usdMillion, tier);
    const mix = Object.fromEntries(rows.map((r) => [r.category, +(r.finalPct * 100).toFixed(2)]));
    expect(mix).toEqual({
      'AI/ML & Data Engineering': 12.5,
      'Compliance & Certification': 9,
      'Design & Simulation': 1.65,
      'Digital Engineering & IoT': 12.67,
      'Mechanical & Hardware Design': 15.28,
      'Platform Engineering': 10.85,
      'Product Engineering': 1.41,
      'Program Management & PMO': 18.69,
      'Prototyping & Testing': 3.19,
      'Software Engineering': 4.57,
      'Sustenance Engineering': 0.34,
      'Systems Engineering': 5.8,
      'Technical Documentation': 3.39,
      Others: 0.68,
    });
  });
});

describe('output shape', () => {
  const industry = 'Aerospace & Defence';
  const revenue = 73420;

  it('nests the IT breakdown as L1 -> L2 -> L3 with totals that roll up', () => {
    const base = computeItBaseSpend(industry, revenue, 'EU', '>$5B')!;
    const tree = buildItBreakdownTree(computeItLevel3Breakdown(industry, base.usdMillion, revenue));
    expect(tree.map((n) => n.name)).toEqual(['Communications', 'Hardware', 'Services', 'Software']);
    let leafCount = 0;
    for (const l1 of tree) {
      expect(l1).toMatchObject({ id: `L1-${l1.name}`, level: 0 });
      expect(l1.value).toBeCloseTo(l1.children!.reduce((a, c) => a + c.value, 0), 8);
      for (const l2 of l1.children!) {
        expect(l2.level).toBe(1);
        expect(l2.value).toBeCloseTo(l2.children!.reduce((a, c) => a + c.value, 0), 8);
        for (const l3 of l2.children!) {
          expect(l3.level).toBe(2);
          leafCount++;
        }
      }
    }
    expect(leafCount).toBe(117);
    expect(tree.reduce((a, n) => a + n.value, 0)).toBeCloseTo(base.usdMillion, 6);
    expect(tree.reduce((a, n) => a + n.percentage, 0)).toBeCloseTo(100, 8);
  });

  it('nests the ERD breakdown the same way', () => {
    const base = computeErdBaseSpend(industry, revenue, 'EU', '>$5B')!;
    const tree = buildErdBreakdownTree(computeErdBreakdown(industry, base.usdMillion, '>$5B'));
    expect(tree.length).toBeGreaterThan(0);
    const leaves = tree.flatMap((l1) => l1.children!.flatMap((l2) => l2.children!));
    expect(leaves).toHaveLength(14);
    expect(tree.reduce((a, n) => a + n.value, 0)).toBeCloseTo(base.usdMillion, 6);
  });

  it('exposes the two line items the emerging-tech overrides are sourced from', () => {
    const itBase = computeItBaseSpend(industry, revenue, 'EU', '>$5B')!;
    const itRows = computeItLevel3Breakdown(industry, itBase.usdMillion, revenue);
    const erdBase = computeErdBaseSpend(industry, revenue, 'EU', '>$5B')!;
    const erdRows = computeErdBreakdown(industry, erdBase.usdMillion, '>$5B');
    expect(findItLevel3Value(itRows, 'Services', 'Digital Enterprise', 'Blockchain')).toBeGreaterThan(0);
    expect(findErdCategoryValue(erdRows, 'AI/ML & Data Engineering')).toBeGreaterThan(0);
  });
});
