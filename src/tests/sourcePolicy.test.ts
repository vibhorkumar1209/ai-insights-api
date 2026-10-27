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

  it('allows the named aggregators and data providers', () => {
    for (const u of [
      'https://gloom.sh/stocks/chef/risk-factors/2025',
      'https://leadiq.com/c/the-chefs-warehouse/5a1d',
      'https://simplywall.st/stocks/us/x',
      'https://www.reveliolabs.com/companies/chefs-warehouse/employees/',
      'https://www.crunchbase.com/organization/x',
    ]) expect(sourceKind(u, CO)).toBe('aggregator');
  });

  it('still rejects unknown sites, blogs and lookalike domains', () => {
    for (const u of [
      'https://www.fool.com/investing/2026/01/01/3-stocks-to-buy-now/',
      'https://notchefswarehouse.com/x',
      'https://someones-blog.example/chefs-warehouse-review',
      'https://medium.com/@x/chefs-warehouse',
    ]) expect(isAllowedSource(u, CO)).toBe(false);
  });

  it('allows earnings call transcripts, but not the same hosts\' stock tips', () => {
    expect(sourceKind('https://www.fool.com/earnings/call-transcripts/2026/08/07/chef-q2-2026/', CO)).toBe('transcript');
    expect(sourceKind('https://seekingalpha.com/article/4800000-chefs-warehouse-q2-2026-earnings-call-transcript', CO)).toBe('transcript');
    expect(sourceKind('https://www.investing.com/news/transcripts/earnings-call-transcript-chefs-warehouse-q2', CO)).toBe('transcript');
    expect(isAllowedSource('https://seekingalpha.com/article/4800001-chefs-warehouse-a-buy', CO)).toBe(false);
  });

  it('allows Economic Times verticals, Indian startup press, global and trade news', () => {
    for (const u of [
      'https://economictimes.indiatimes.com/tech/x',
      'https://auto.economictimes.indiatimes.com/news/x',
      'https://cio.economictimes.indiatimes.com/news/x',
      'https://yourstory.com/2026/05/x',
      'https://www.moneycontrol.com/news/x',
      'https://www.business-standard.com/companies/x',
      'https://gulfnews.com/business/x',
      'https://www.handelsblatt.com/x',
      'https://www.supplychaindive.com/news/x',
      'https://distributionstrategy.com/2025/11/x',
    ]) expect(sourceKind(u, CO)).toBe('news');
  });

  it('drops a retrieved but disallowed URL from a theme', async () => {
    const out = await verifyThemeSources(
      [{ source: 'https://someones-blog.example/chefs-warehouse-review' }],
      { notes: 'n', urls: ['https://someones-blog.example/chefs-warehouse-review'] },
      CO,
    );
    expect(out[0].source).toBe('No verified source found');
  });
});
