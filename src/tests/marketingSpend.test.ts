// Regression tests for the Marketing Spend benchmark calculator.
//
// Locked down here:
//   1. The shipped tables still cover the same 37 industries as the IT/ERD module,
//      with a 91-line taxonomy whose mix sums to 100% for every industry and year.
//   2. The tier and region multipliers reproduce figures the source JSON publishes
//      itself (by_revenue_tier / by_hq_region), so the formula is not a guess.
//   3. Worked examples (expected values computed independently from the source JSON)
//      and the disclosed-figure override rules.
import request from 'supertest';
import app from '../app';
import {
  computeMarketingSpend,
  computeMarketingPctByYear,
  computeMarketingMix,
  resolveMarketingRegion,
  marketingTierMultiplier,
  MEDIA_AND_ADVERTISING,
} from '../services/marketingSpendCalculator';
import { resolveExclusionTierIndex } from '../services/itErdSpendCalculator';
import { MARKETING_INDUSTRIES, MARKETING_TAXONOMY, MARKETING_YEARS, MARKETING_HQ_REGIONS } from '../data/marketingSpendData';
import { SPEND_CALCULATOR_INDUSTRIES } from '../services/claudeAI';
import { SpendBreakdownNode } from '@ai-insights/types';

const TIER_SAMPLE_REVENUES = [5, 50, 300, 700, 3000, 7000, 20000];
const AIRBUS = { companyName: 'Airbus', industry: 'Aerospace & Defence', geography: 'France', revenueUsdMillion: 73420 };
const WESTERN_EUROPE = 'Western Europe (DACH, France, Benelux)';

const l1Value = (tree: SpendBreakdownNode[], name: string) => tree.find((n) => n.name === name)!.value;
const leaves = (tree: SpendBreakdownNode[]) => tree.flatMap((l1) => (l1.children ?? []).flatMap((l2) => l2.children ?? []));

describe('reference tables', () => {
  it('covers exactly the 37 spend-module industries, 9 years each', () => {
    expect(Object.keys(MARKETING_INDUSTRIES).sort()).toEqual([...SPEND_CALCULATOR_INDUSTRIES].sort());
    for (const [industry, row] of Object.entries(MARKETING_INDUSTRIES)) {
      expect(`${industry}:${row.pctRevenue.length}:${row.l3Share.length}`).toBe(`${industry}:9:9`);
    }
    expect(MARKETING_TAXONOMY).toHaveLength(91);
    expect(new Set(MARKETING_TAXONOMY.map((t) => t.level1)).size).toBe(7);
    expect(new Set(MARKETING_TAXONOMY.map((t) => t.level2)).size).toBe(27);
    expect(Object.keys(MARKETING_HQ_REGIONS)).toHaveLength(16);
  });

  it('has a mix that sums to 100% and a % of revenue in a sane band', () => {
    for (const [industry, row] of Object.entries(MARKETING_INDUSTRIES)) {
      row.l3Share.forEach((year) => {
        expect(`${industry}:${year.reduce((s, v) => s + v, 0).toFixed(3)}`).toBe(`${industry}:1.000`);
      });
      for (const pct of row.pctRevenue) {
        expect(pct).toBeGreaterThan(0.002);
        expect(pct).toBeLessThan(0.2);
      }
    }
  });
});

describe('tier and region multipliers reproduce the published tables', () => {
  // Values copied from the source JSON's by_revenue_tier / by_hq_region blocks (2025).
  it('Aerospace & Defence (archetype elasticity 0.6) by revenue tier', () => {
    const published = [0.0254, 0.0236, 0.0218, 0.0206, 0.02, 0.01904, 0.01784];
    TIER_SAMPLE_REVENUES.forEach((rev, i) => {
      const pct = computeMarketingPctByYear('Aerospace & Defence', 'North America – United States', resolveExclusionTierIndex(rev))[3];
      expect(pct).toBeCloseTo(published[i], 6);
    });
    expect(marketingTierMultiplier('Aerospace & Defence', 0)).toBeCloseTo(1.27, 10);
  });

  it('Aerospace & Defence by HQ region, at the $1B-$5B base tier', () => {
    const at = (region: string) => computeMarketingPctByYear('Aerospace & Defence', region, 4)[3];
    expect(at('North America – Canada')).toBeCloseTo(0.016, 6);
    expect(at('UK & Ireland')).toBeCloseTo(0.020892, 6);
    expect(at(WESTERN_EUROPE)).toBeCloseTo(0.015272, 6);
  });

  it('Aerospace & Defence L1 mix at the smallest tier matches the published shares', () => {
    const mix = computeMarketingMix('Aerospace & Defence', 2025, 'North America – United States', 0);
    const l1 = (name: string) => mix.filter((r) => r.level1 === name).reduce((s, r) => s + r.share, 0);
    expect(l1('Media & Advertising')).toBeCloseTo(0.173789, 4);
    expect(l1('Agencies & Services')).toBeCloseTo(0.060813, 4);
    expect(l1('Marketing Workforce')).toBeCloseTo(0.231028, 4);
  });
});

describe('resolveMarketingRegion', () => {
  it.each([
    ['United States', 'North America – United States'],
    ['USA', 'North America – United States'],
    ['Atlanta, Georgia, USA', 'North America – United States'],
    ['Tbilisi, Georgia', 'Central & Eastern Europe'],
    ['UK', 'UK & Ireland'],
    ['France', WESTERN_EUROPE],
    ['Zürich, Switzerland', WESTERN_EUROPE],
    ['Mumbai India', 'India'],
    ['Taiwan', 'China'],
    ['São Paulo, Brazil', 'Latin America'],
    ['South Africa', 'Africa'],
    ['Dubai, UAE', 'Middle East (GCC)'],
    ['Sweden', 'Nordics'],
    ['', 'North America – United States'],
    ['Atlantis', 'North America – United States'],
  ])('%s -> %s', (geography, region) => {
    expect(resolveMarketingRegion(geography)).toBe(region);
  });
});

describe('computeMarketingSpend', () => {
  it('Airbus (France, $73.4B, A&D): independent worked example', () => {
    const out = computeMarketingSpend(AIRBUS)!;
    expect(out.region).toBe(WESTERN_EUROPE);
    expect(out.revenueTier).toBe('T7 >$10B');
    expect(out.archetype).toBe('B2B Industrial & Asset-Heavy');
    expect(out.totalSource).toBe('benchmark');
    const y2026 = out.trends.find((t) => t.year === 2026)!;
    expect(y2026.marketingPercent).toBeCloseTo(1.372888, 5);
    expect(y2026.marketingSpend).toBeCloseTo(1007.9744, 3);
    expect(l1Value(out.marketingBreakdown, 'Events & Experiential')).toBeCloseTo(243.5839, 3);
    expect(l1Value(out.marketingBreakdown, MEDIA_AND_ADVERTISING)).toBeCloseTo(129.4567, 3);
    expect(out.marketingCAGR_Historical).toBeCloseTo(-3.0398, 3);
    expect(out.marketingCAGR_Forecast).toBeCloseTo(0, 6);
  });

  it('breaks every industry/tier into 91 leaves that sum to the headline', () => {
    for (const industry of Object.keys(MARKETING_INDUSTRIES)) {
      for (const rev of TIER_SAMPLE_REVENUES) {
        const out = computeMarketingSpend({ companyName: 'X', industry, geography: 'Japan', revenueUsdMillion: rev })!;
        const tree = out.marketingBreakdown;
        expect(leaves(tree)).toHaveLength(91);
        const total = tree.reduce((s, n) => s + n.value, 0);
        const base = out.trends.find((t) => t.year === 2026)!.marketingSpend;
        expect(total).toBeCloseTo(base, 6);
        expect(tree.reduce((s, n) => s + n.percentage, 0)).toBeCloseTo(100, 8);
        expect(out.pctOfRevenue).toBeCloseTo((total / rev) * 100, 8);
      }
    }
  });

  it('a disclosed total replaces the benchmark and rescales the trend', () => {
    const out = computeMarketingSpend(AIRBUS, { totalUsdMillion: 1500 })!;
    expect(out.totalSource).toBe('disclosed');
    expect(out.marketingBreakdown.reduce((s, n) => s + n.value, 0)).toBeCloseTo(1500, 6);
    expect(out.trends.find((t) => t.year === 2026)!.marketingSpend).toBeCloseTo(1500, 6);
    // Shape of the curve is the benchmark's.
    expect(out.marketingCAGR_Historical).toBeCloseTo(-3.0398, 3);
  });

  it('disclosed advertising alone pins Media & Advertising and keeps the rest at benchmark', () => {
    const bench = computeMarketingSpend(AIRBUS)!;
    const out = computeMarketingSpend(AIRBUS, { advertisingUsdMillion: 300 })!;
    expect(out.advertisingSource).toBe('disclosed');
    expect(out.totalSource).toBe('benchmark');
    expect(l1Value(out.marketingBreakdown, MEDIA_AND_ADVERTISING)).toBeCloseTo(300, 6);
    expect(l1Value(out.marketingBreakdown, 'Marketing Workforce')).toBeCloseTo(l1Value(bench.marketingBreakdown, 'Marketing Workforce'), 6);
    const benchTotal = bench.marketingBreakdown.reduce((s, n) => s + n.value, 0);
    const benchAdv = l1Value(bench.marketingBreakdown, MEDIA_AND_ADVERTISING);
    expect(out.marketingBreakdown.reduce((s, n) => s + n.value, 0)).toBeCloseTo(benchTotal - benchAdv + 300, 6);
  });

  it('disclosed total + advertising: advertising pinned, others share the remainder', () => {
    const out = computeMarketingSpend(AIRBUS, { totalUsdMillion: 2000, advertisingUsdMillion: 500 })!;
    expect(out.marketingBreakdown.reduce((s, n) => s + n.value, 0)).toBeCloseTo(2000, 6);
    expect(l1Value(out.marketingBreakdown, MEDIA_AND_ADVERTISING)).toBeCloseTo(500, 6);
  });

  it('ignores an advertising figure that is not smaller than the disclosed total', () => {
    const out = computeMarketingSpend(AIRBUS, { totalUsdMillion: 400, advertisingUsdMillion: 900 })!;
    expect(out.advertisingSource).toBe('benchmark');
    expect(out.marketingBreakdown.reduce((s, n) => s + n.value, 0)).toBeCloseTo(400, 6);
  });

  it('returns null for an industry with no benchmark', () => {
    expect(computeMarketingSpend({ companyName: 'X', industry: 'Basket Weaving', revenueUsdMillion: 10 })).toBeNull();
  });

  it('covers 2022-2030', () => {
    expect(computeMarketingSpend(AIRBUS)!.trends.map((t) => t.year)).toEqual(MARKETING_YEARS);
  });
});

describe('POST /api/spend/marketing', () => {
  it('returns the marketing payload', async () => {
    const res = await request(app).post('/api/spend/marketing').send(AIRBUS);
    expect(res.status).toBe(200);
    expect(res.body.applicable).toBe(true);
    expect(res.body.revenueTier).toBe('T7 >$10B');
    expect(res.body.marketingSpend.marketingBreakdown.map((n: { name: string }) => n.name)).toEqual([
      'Media & Advertising',
      'Marketing Technology',
      'Agencies & Services',
      'Events & Experiential',
      'Content & Production',
      'Marketing Workforce',
      'Channel, Trade & Customer Marketing',
    ]);
  });

  it('validates input like the IT/ERD routes', async () => {
    const res = await request(app).post('/api/spend/marketing').send({ ...AIRBUS, industry: 'Nope' });
    expect(res.status).toBe(400);
  });
});
