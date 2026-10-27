// Which sites count as a citable source for theme analysis: primary sources
// (the company itself, regulators and filing systems, official press-release
// wires, sustainability registries) and major news outlets. Aggregators, SEO
// stock sites, data brokers and blogs are excluded even when they quote a
// primary source; cite the primary source instead.

const PRIMARY_HOSTS = [
  // Regulators, filings, exchanges
  'sec.gov', 'europa.eu', 'companieshouse.gov.uk', 'find-and-update.company-information.service.gov.uk',
  'sedarplus.ca', 'asx.com.au', 'londonstockexchange.com', 'hkexnews.hk', 'nseindia.com', 'bseindia.com',
  'sgx.com', 'jpx.co.jp', 'nasdaq.com', 'nyse.com', 'fca.org.uk', 'esma.europa.eu', 'efrag.org',
  // Official company announcements and IR hosting
  'prnewswire.com', 'businesswire.com', 'globenewswire.com', 'q4cdn.com', 'gcs-web.com', 'investis.com',
  'annualreports.com',
  // Sustainability disclosure registries
  'cdp.net', 'sciencebasedtargets.org', 'globalreporting.org', 'ifrs.org',
];

const MAJOR_NEWS_HOSTS = [
  'reuters.com', 'bloomberg.com', 'wsj.com', 'ft.com', 'cnbc.com', 'apnews.com', 'bbc.com', 'bbc.co.uk',
  'nytimes.com', 'washingtonpost.com', 'economist.com', 'theguardian.com', 'forbes.com', 'fortune.com',
  'businessinsider.com', 'barrons.com', 'marketwatch.com', 'axios.com', 'nikkei.com', 'asia.nikkei.com',
  'latimes.com', 'usatoday.com', 'cnn.com', 'npr.org', 'techcrunch.com', 'theverge.com', 'wired.com',
  'economictimes.indiatimes.com', 'livemint.com', 'thehindubusinessline.com', 'handelsblatt.com',
  'lesechos.fr', 'scmp.com', 'straitstimes.com', 'afr.com', 'theglobeandmail.com',
];

function hostOf(url: string): string {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
}

const matches = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

function companyRoot(companyDomain?: string): string {
  if (!companyDomain) return '';
  return hostOf(/^https?:\/\//i.test(companyDomain) ? companyDomain : `https://${companyDomain}`);
}

export type SourceKind = 'company' | 'primary' | 'news';

/** Why a URL is allowed, or undefined when it is not. */
export function sourceKind(url: string, companyDomain?: string): SourceKind | undefined {
  const host = hostOf(url);
  if (!host) return undefined;
  const root = companyRoot(companyDomain);
  if (root && matches(host, root)) return 'company';
  // Any government domain: .gov, .gov.uk, .gov.in, .gouv.fr and similar.
  if (/(^|\.)(gov|gouv|gob|govt)(\.[a-z]{2})?$/.test(host) || /\.gov\.[a-z]{2}$/.test(host)) return 'primary';
  if (PRIMARY_HOSTS.some((d) => matches(host, d))) return 'primary';
  if (MAJOR_NEWS_HOSTS.some((d) => matches(host, d))) return 'news';
  return undefined;
}

export function isAllowedSource(url: string, companyDomain?: string): boolean {
  return sourceKind(url, companyDomain) !== undefined;
}

/** For prompts: what may be cited. */
export const SOURCE_POLICY_TEXT = `Cite ONLY primary sources (the company's own website and investor relations pages, annual reports, SEC and other regulatory filings, stock exchange announcements, official press releases on PR Newswire, Business Wire or GlobeNewswire, sustainability disclosures to CDP or SBTi, government sites) and major news outlets (Reuters, Bloomberg, The Wall Street Journal, Financial Times, CNBC, AP, BBC, The New York Times, Forbes, Fortune and similar). Do not cite aggregators, stock-tip or SEO sites, data brokers, blogs or trade newsletters; find the primary source they rely on instead.`;
