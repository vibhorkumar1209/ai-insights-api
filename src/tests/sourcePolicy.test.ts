import { sourceKind, isAllowedSource } from '../services/sourcePolicy';
import { verifyThemeSources } from '../services/themeResearch';

const CO = 'chefswarehouse.com';

describe('theme source policy', () => {
  it('allows the company itself, including its IR subdomain', () => {
    expect(sourceKind('https://investors.chefswarehouse.com/news-releases/x', CO)).toBe('company');
    expect(sourceKind('https://www.chefswarehouse.com/about', CO)).toBe('company');
  });

  it('allows regulators, filings, wires and registries', () => {
    for (const u of [
      'https://www.sec.gov/Archives/edgar/data/1517175/x.htm',
      'https://www.fda.gov/food/x',
      'https://www.gov.uk/guidance/x',
      'https://eur-lex.europa.eu/eli/dir/2022/2464',
      'https://www.prnewswire.com/news-releases/x.html',
      'https://www.businesswire.com/news/home/x',
      'https://www.cdp.net/en/responses/x',
    ]) expect(sourceKind(u, CO)).toBe('primary');
  });

  it('allows major news', () => {
    for (const u of ['https://www.reuters.com/business/x', 'https://www.ft.com/content/x', 'https://www.bloomberg.com/news/x'])
      expect(sourceKind(u, CO)).toBe('news');
  });

  it('rejects aggregators and secondary sites seen in real runs', () => {
    for (const u of [
      'https://gloom.sh/stocks/chef/risk-factors/2025',
      'https://leadiq.com/c/the-chefs-warehouse/5a1d',
      'https://simplywall.st/stocks/us/x',
      'https://www.reveliolabs.com/companies/chefs-warehouse/employees/',
      'https://distributionstrategy.com/2025/11/x',
      'https://www.fool.com/earnings/call-transcripts/x',
      'https://notchefswarehouse.com/x',
    ]) expect(isAllowedSource(u, CO)).toBe(false);
  });

  it('drops a retrieved but disallowed URL from a theme', async () => {
    const out = await verifyThemeSources(
      [{ source: 'https://gloom.sh/stocks/chef/risk-factors/2025' }],
      { notes: 'n', urls: ['https://gloom.sh/stocks/chef/risk-factors/2025'] },
      CO,
    );
    expect(out[0].source).toBe('No verified source found');
  });
});
