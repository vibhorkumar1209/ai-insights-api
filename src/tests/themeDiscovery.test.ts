import { DISCOVERY_PARAMS, themeContextBlock, shapeDiscovery, discoveryQuestionsBlock } from '../services/themeDiscovery';

const base = { companyName: 'Acme', themeType: 'business' as const };

describe('theme discovery', () => {
  it('has the agreed parameters per theme type', () => {
    expect(DISCOVERY_PARAMS.business.map((p) => p.parameter)).toEqual(['Strategic Imperatives', 'Industry Vertical', 'Geographic Footprint']);
    expect(DISCOVERY_PARAMS.technology.map((p) => p.parameter)).toEqual(['Infrastructure Topology', 'Integration Ecosystem', 'Developer Experience']);
    expect(DISCOVERY_PARAMS.sustainability.map((p) => p.parameter)).toEqual(['Carbon Footprint Tracking', 'Regulatory Reporting']);
  });

  it('puts the target company into the questions', () => {
    expect(discoveryQuestionsBlock(base)).toContain('Is Acme focusing on cutting costs');
  });

  it('writes every optional input into the context block, and nothing when none are given', () => {
    expect(themeContextBlock(base)).toBe('');
    const ctx = themeContextBlock({ ...base, industry: 'EU banking', keyTriggers: 'new CFO', userOrganization: 'Snowflake', userDomain: 'snowflake.com', solutionPortfolio: 'data cloud', focusTechnologies: 'GenAI' });
    for (const s of ['EU banking', 'new CFO', 'Snowflake (snowflake.com)', 'data cloud', 'GenAI']) expect(ctx).toContain(s);
  });

  it('returns exactly the fixed parameters in order, filling gaps', () => {
    const out = shapeDiscovery({ ...base, userOrganization: 'Snowflake' }, [
      { parameter: 'geographic footprint', finding: '• EU expansion', sellerAngle: 'fit', source: 'https://x.com' },
      { parameter: 'Made Up', finding: 'drop me' },
    ]);
    expect(out.map((r) => r.parameter)).toEqual(['Strategic Imperatives', 'Industry Vertical', 'Geographic Footprint']);
    expect(out[0].finding).toBe('Not publicly disclosed.');
    expect(out[2].finding).toBe('• EU expansion');
    expect(out[2].sellerAngle).toBe('fit');
  });

  it('omits the seller angle when no seller was given', () => {
    const out = shapeDiscovery(base, [{ parameter: 'Strategic Imperatives', finding: 'x', sellerAngle: 'invented' }]);
    expect(out[0].sellerAngle).toBeUndefined();
  });
});
