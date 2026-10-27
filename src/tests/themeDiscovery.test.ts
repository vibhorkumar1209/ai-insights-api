import { DISCOVERY_PARAMS, themeContextBlock, discoveryQuestionsBlock } from '../services/themeDiscovery';
import { isRedirectWrapper } from '../services/urlValidator';
import { verifyThemeSources } from '../services/themeResearch';

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

});

describe('theme sources', () => {
  it('recognises redirect wrappers but not real pages', () => {
    expect(isRedirectWrapper('https://vertexaisearch.cloud.google.com/grounding-api-redirect/AbC')).toBe(true);
    expect(isRedirectWrapper('https://www.google.com/url?q=https://acme.com')).toBe(true);
    expect(isRedirectWrapper('https://news.google.com/rss/articles/CBMi')).toBe(true);
    expect(isRedirectWrapper('https://t.co/xyz')).toBe(true);
    expect(isRedirectWrapper('https://investors.acme.com/annual-report')).toBe(false);
    expect(isRedirectWrapper('https://cloud.google.com/blog/acme')).toBe(false);
  });

  it('drops cited URLs the research never retrieved', async () => {
    const rows = [{ theme: 't', source: 'https://made-up.example/report' }, { theme: 'u', source: '' }];
    const out = await verifyThemeSources(rows, { notes: 'n', urls: ['https://real.example/page'] });
    expect(out[0].source).toBe('No verified source found');
    expect(out[1].source).toBe('No verified source found');
  });
});
