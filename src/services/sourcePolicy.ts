// Which sites count as a citable source for theme analysis: primary sources
// (the company itself, regulators and filing systems, official press-release
// wires, sustainability registries), earnings call transcripts, and
// established business, technology and trade news from around the world.
// Aggregators, SEO stock sites, data brokers and blogs are excluded even when
// they quote a primary source; cite the primary source instead.

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

// Earnings call transcripts. Some hosts also publish stock tips, so those are
// allowed only under their transcript path.
const TRANSCRIPT_SOURCES: { host: string; path?: RegExp }[] = [
  { host: 'fool.com', path: /^\/earnings\/call-transcripts\// },
  { host: 'seekingalpha.com', path: /^\/article\/.*transcript/i },
  { host: 'investing.com', path: /transcript/i },
  { host: 'finance.yahoo.com' },
  { host: 'gurufocus.com', path: /transcript/i },
  { host: 'marketscreener.com', path: /transcript/i },
];

const MAJOR_NEWS_HOSTS = [
  // India: business, startup and sector news (Economic Times covers ETAuto,
  // ETCIO, ETRetail and the other ET verticals as subdomains)
  'economictimes.com', 'indiatimes.com', 'yourstory.com', 'moneycontrol.com', 'business-standard.com',
  'financialexpress.com', 'thehindu.com', 'hindustantimes.com', 'ndtvprofit.com', 'inc42.com', 'entrackr.com',
  'thehindubusinessline.com', 'businesstoday.in', 'fortuneindia.com', 'cnbctv18.com', 'medianama.com',
  'the-ken.com', 'theprint.in', 'autocarindia.com', 'expresscomputer.in',
  // Asia Pacific
  'japantimes.co.jp', 'koreaherald.com', 'koreatimes.co.kr', 'caixinglobal.com', 'chinadaily.com.cn',
  'channelnewsasia.com', 'businesstimes.com.sg', 'theedgemalaysia.com', 'thestar.com.my', 'bangkokpost.com',
  'inquirer.net', 'thejakartapost.com', 'vnexpress.net', 'smh.com.au', 'abc.net.au', 'nzherald.co.nz',
  'digitimes.com', 'techinasia.com', 'kr-asia.com', 'dealstreetasia.com',
  // Europe
  'dw.com', 'france24.com', 'euronews.com', 'spiegel.de', 'faz.net', 'sueddeutsche.de', 'lemonde.fr',
  'lefigaro.fr', 'elpais.com', 'expansion.com', 'ilsole24ore.com', 'corriere.it', 'nrc.nl', 'fd.nl',
  'politico.eu', 'cityam.com', 'thetimes.co.uk', 'telegraph.co.uk', 'independent.co.uk', 'irishtimes.com',
  'sifted.eu', 'tech.eu',
  // Middle East and Africa
  'gulfnews.com', 'thenationalnews.com', 'arabnews.com', 'khaleejtimes.com', 'zawya.com', 'agbi.com',
  'timesofisrael.com', 'globes.co.il', 'businessday.ng', 'techcabal.com', 'businesslive.co.za',
  'dailymaverick.co.za', 'news24.com', 'theeastafrican.co.ke', 'nation.africa',
  // Americas
  'financialpost.com', 'cbc.ca', 'valor.globo.com', 'bnamericas.com', 'eleconomista.com.mx', 'infobae.com',
  'latimes.com', 'bostonglobe.com', 'chicagotribune.com', 'bizjournals.com', 'crainsnewyork.com',
  // Technology
  'zdnet.com', 'computerweekly.com', 'theregister.com', 'venturebeat.com', 'siliconangle.com',
  'arstechnica.com', 'protocol.com', 'theinformation.com', 'cio.com', 'informationweek.com', 'datacenterdynamics.com',
  // Sector trade press
  'supplychaindive.com', 'fooddive.com', 'retaildive.com', 'ciodive.com', 'utilitydive.com', 'healthcaredive.com',
  'bankingdive.com', 'constructiondive.com', 'manufacturingdive.com', 'fiercebiotech.com', 'fiercehealthcare.com',
  'fiercepharma.com', 'fiercetelecom.com', 'autonews.com', 'just-auto.com', 'electrek.co', 'insideevs.com',
  'freightwaves.com', 'supplychainbrain.com', 'distributionstrategy.com', 'foodbusinessnews.net',
  'nrn.com', 'grocerydive.com', 'americanbanker.com', 'insurancejournal.com', 'pharmaceutical-technology.com',
  'medicaldevice-network.com', 'mining.com', 'rigzone.com', 'spglobal.com', 'energymonitor.ai',
  'greenbiz.com', 'esgtoday.com', 'edie.net', 'responsible-investor.com', 'carbonbrief.org',
  // Global
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

export type SourceKind = 'company' | 'primary' | 'transcript' | 'news';

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
  let path = '/';
  try { path = new URL(url).pathname; } catch { /* keep '/' */ }
  if (TRANSCRIPT_SOURCES.some((t) => matches(host, t.host) && (!t.path || t.path.test(path)))) return 'transcript';
  return undefined;
}

export function isAllowedSource(url: string, companyDomain?: string): boolean {
  return sourceKind(url, companyDomain) !== undefined;
}

/** For prompts: what may be cited. */
export const SOURCE_POLICY_TEXT = `Cite ONLY: primary sources (the company's own website and investor relations pages, annual reports, SEC and other regulatory filings, stock exchange announcements, official press releases on PR Newswire, Business Wire or GlobeNewswire, sustainability disclosures to CDP or SBTi, government sites); earnings call transcripts (Motley Fool transcripts, Seeking Alpha, Investing.com, Yahoo Finance); and established news outlets worldwide, including global business press (Reuters, Bloomberg, WSJ, Financial Times, CNBC, BBC), regional business press (Economic Times and its ETAuto, ETCIO and other verticals, YourStory, Moneycontrol, Business Standard, Mint, Nikkei Asia, Handelsblatt, Gulf News and similar), technology press, and sector trade publications (Industry Dive, Fierce, Automotive News and similar). Do not cite aggregators, stock-tip or SEO sites, data brokers or personal blogs; find the primary source or news report they rely on instead.`;
