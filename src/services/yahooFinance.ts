import YahooFinance from 'yahoo-finance2';
import fetch from 'node-fetch';
import {
  RevenueDataPoint,
  MarginDataPoint,
  FinancialStatementRow,
  CompanyInfo,
  QuarterlyDataPoint,
} from '../types';

// yahoo-finance2 v3 requires instantiation
const yahooFinance = new YahooFinance();

// Suppress yahoo-finance2 console warnings in production
try {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (yahooFinance as any).setGlobalConfig?.({ validation: { logOptionsErrors: false } });
} catch { /* ignore */ }

// ── Custom Finance API ─────────────────────────────────────────────────────────

const FINANCE_API_BASE = 'http://20.219.199.59/FinanceScrapper/api/ExternalApi';

// Map Yahoo Finance ticker suffix → Google Finance exchange code
const SUFFIX_TO_EXCHANGE: Record<string, string> = {
  L:   'LON',   // London Stock Exchange
  TO:  'TSE',   // Toronto Stock Exchange
  HK:  'HKG',   // Hong Kong Exchange
  PA:  'EPA',   // Euronext Paris
  F:   'ETR',   // Frankfurt (old)
  DE:  'ETR',   // Deutsche Börse XETRA
  MC:  'BME',   // Madrid (Bolsa)
  MI:  'BIT',   // Milan (Borsa Italiana)
  AS:  'AMS',   // Euronext Amsterdam
  SW:  'SWX',   // Swiss Exchange
  CO:  'CPH',   // Copenhagen
  ST:  'STO',   // Stockholm
  OL:  'OSL',   // Oslo
  HE:  'HEL',   // Helsinki
  BR:  'EBR',   // Brussels
  VI:  'VIE',   // Vienna
  LS:  'ELI',   // Lisbon
  WA:  'WSE',   // Warsaw
  IS:  'BIST',  // Istanbul
  SI:  'SGX',   // Singapore Exchange
  AX:  'ASX',   // Australian Securities Exchange
  NS:  'NSE',   // National Stock Exchange (India)
  BO:  'BSE',   // Bombay Stock Exchange
  KS:  'KRX',   // Korea Stock Exchange
  T:   'TYO',   // Tokyo Stock Exchange
  SS:  'SHA',   // Shanghai A-shares
  SZ:  'SHE',   // Shenzhen A-shares
};

// Map Yahoo exchange code → Google Finance exchange (for tickers with no dot-suffix)
function yahooExchangeToGoogle(yExchange: string): string {
  const e = yExchange.toUpperCase();
  if (e.includes('NASDAQ') || ['NMS', 'NGM', 'NCM', 'NASDAQGS', 'NASDAQGM', 'NASDAQCM'].includes(e)) return 'NASDAQ';
  if (e.includes('NYSE') || ['NYQ', 'NYE', 'PCX', 'ASE'].includes(e)) return 'NYSE';
  return 'NASDAQ'; // safe fallback for unknown US exchanges
}

/**
 * Convert a Yahoo Finance symbol + exchange into the TICKER:EXCHANGE format
 * expected by the custom finance scraper API (e.g. "LLOY:LON", "AAPL:NASDAQ").
 */
export function buildSearchString(yahooSymbol: string, yahooExchangeCode: string): string {
  const dotIdx = yahooSymbol.indexOf('.');
  if (dotIdx !== -1) {
    const base   = yahooSymbol.slice(0, dotIdx);
    const suffix = yahooSymbol.slice(dotIdx + 1).toUpperCase();
    const exchange = SUFFIX_TO_EXCHANGE[suffix] || suffix;
    return `${base}:${exchange}`;
  }
  // No dot — determine exchange from the Yahoo exchange code
  const exchange = yahooExchangeToGoogle(yahooExchangeCode);
  return `${yahooSymbol}:${exchange}`;
}

// ── Value parsing helpers ──────────────────────────────────────────────────────

const EM_DASH = '\u2014';
const EN_DASH = '\u2013';

/**
 * Parse finance value strings like "18.63B", "738.00M", "—" → number | null.
 * Handles optional leading "-" and currency/whitespace noise.
 */
export function parseFinanceValue(val: string | undefined | null): number | null {
  if (!val || val === EM_DASH || val === EN_DASH || val.trim() === '-' || val.trim() === 'N/A') return null;
  const clean  = val.replace(/[$£€¥₹,\u00a0\s]/g, '').trim();
  const isNeg  = clean.startsWith('-');
  const digits = clean.replace(/^-/, '');
  const m = digits.match(/^([0-9.]+)([BMKT]?)$/i);
  if (!m) return null;
  const num = parseFloat(m[1]);
  if (isNaN(num)) return null;
  const mult: Record<string, number> = { B: 1e9, M: 1e6, K: 1e3, T: 1e12 };
  const multiplier = mult[m[2].toUpperCase()] ?? 1;
  return (isNeg ? -1 : 1) * num * multiplier;
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: '$', GBP: '£', EUR: '€', JPY: '¥', CAD: 'CA$', AUD: 'A$',
  INR: '₹', CHF: 'CHF ', CNY: '¥', HKD: 'HK$', SGD: 'S$', KRW: '₩',
};

function formatWithCurrency(raw: number | null, currency = 'USD'): string {
  if (raw == null || isNaN(raw)) return 'N/A';
  const abs    = Math.abs(raw);
  const sign   = raw < 0 ? '-' : '';
  const sym    = CURRENCY_SYMBOLS[currency.toUpperCase()] ?? (currency + ' ');
  if (abs >= 1e12) return `${sign}${sym}${(abs / 1e12).toFixed(2)}T`;
  if (abs >= 1e9)  return `${sign}${sym}${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6)  return `${sign}${sym}${(abs / 1e6).toFixed(0)}M`;
  if (abs >= 1e3)  return `${sign}${sym}${(abs / 1e3).toFixed(0)}K`;
  return `${sign}${sym}${raw.toLocaleString()}`;
}

function calcYoy(current: number | null, previous: number | null): string | undefined {
  if (current == null || previous == null || previous === 0) return undefined;
  const pct = ((current - previous) / Math.abs(previous)) * 100;
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
}

// ── Annual API response shapes ─────────────────────────────────────────────────

interface AnnualPeriodData {
  Revenue?:           string;
  'Operating expense'?: string;
  'Net income'?:      string;
  'Net profit margin'?: string;
  'Earnings per share'?: string;
  EBITDA?:            string;
  'Effective tax rate'?: string;
}

interface AnnualAPIResponse {
  Company?: {
    Name?:              string;
    'PREVIOUS CLOSE'?:  string;
    'DAY RANGE'?:       string;
    'YEAR RANGE'?:      string;
    'MARKET CAP'?:      string;
    'AVG VOLUME'?:      string;
    'P/E RATIO'?:       string;
    'DIVIDEND YIELD'?:  string;
    'PRIMARY EXCHANGE'?: string;
    CEO?:               string;
    FOUNDED?:           string;
    HEADQUARTERS?:      string;
    WEBSITE?:           string;
    EMPLOYEES?:         string;
    About?:             string;
  };
  Financial?: Record<string, AnnualPeriodData | { Currency: string }>;
}

interface QuarterlyAPIResponse {
  QuarterFinancialAnalysis?: Record<string, AnnualPeriodData | { Currency: string }>;
}

// ── node-fetch v2 compatible timeout helper ────────────────────────────────────
// AbortSignal.timeout() is Node 17.3+ / native fetch only — not supported by
// node-fetch v2.  Use a manual AbortController + setTimeout instead.

function fetchWithTimeout(url: string, timeoutMs: number): Promise<import('node-fetch').Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // node-fetch v2 accepts AbortSignal; cast needed to satisfy TS overloads
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return fetch(url, { signal: controller.signal as any }).finally(() => clearTimeout(timer));
}

// ── Fetch annual data ──────────────────────────────────────────────────────────

export interface AnnualFinancialsResult {
  companyInfo:    CompanyInfo;
  currency:       string;
  revenueHistory: RevenueDataPoint[];
  marginHistory:  MarginDataPoint[];
  plStatement:    FinancialStatementRow[];
}

export async function fetchAnnualFinancials(searchString: string): Promise<AnnualFinancialsResult> {
  const url = `${FINANCE_API_BASE}/SearchOnPuppeteer?searchString=${searchString}`;
  // 60 s timeout — Puppeteer-based API can be slow to launch the browser
  const res  = await fetchWithTimeout(url, 60_000);
  if (!res.ok) throw new Error(`Finance API annual: HTTP ${res.status}`);
  const data = (await res.json()) as AnnualAPIResponse;

  const currency = extractCurrency(data.Financial);

  // ── Company info ──────────────────────────────────────────────────────────
  const c = data.Company || {};
  const companyInfo: CompanyInfo = {
    name:          c.Name,
    exchange:      c['PRIMARY EXCHANGE'],
    previousClose: c['PREVIOUS CLOSE'],
    dayRange:      c['DAY RANGE'],
    yearRange:     c['YEAR RANGE'],
    marketCap:     c['MARKET CAP'],
    avgVolume:     c['AVG VOLUME'],
    peRatio:       c['P/E RATIO'],
    dividendYield: c['DIVIDEND YIELD'],
    ceo:           c.CEO,
    founded:       c.FOUNDED,
    headquarters:  c.HEADQUARTERS,
    website:       c.WEBSITE,
    employees:     c.EMPLOYEES,
    about:         c.About,
  };

  // ── Annual period data ────────────────────────────────────────────────────
  const periodsRaw = buildSortedPeriods(data.Financial || {});

  const revenueHistory: RevenueDataPoint[] = [];
  const marginHistory:  MarginDataPoint[]  = [];

  periodsRaw.forEach(({ label, data: p }, idx) => {
    const rev    = parseFinanceValue(p.Revenue);
    const opex   = parseFinanceValue(p['Operating expense']);
    const ni     = parseFinanceValue(p['Net income']);
    const netMar = parseFloat(p['Net profit margin'] || '0') || 0;

    if (rev == null) return;

    const prevRev  = idx > 0 ? parseFinanceValue(periodsRaw[idx - 1].data.Revenue) : null;
    const yoyNum   = prevRev ? ((rev - prevRev) / Math.abs(prevRev)) * 100 : undefined;

    revenueHistory.push({
      year: label,
      revenue: rev,
      revenueFormatted: formatWithCurrency(rev, currency),
      yoyGrowth: yoyNum != null ? parseFloat(yoyNum.toFixed(1)) : undefined,
    });

    // Operating income = Revenue – Operating expense
    const opInc    = (rev != null && opex != null) ? rev - opex : null;
    const opMar    = (opInc != null && rev > 0) ? parseFloat(((opInc / rev) * 100).toFixed(1)) : 0;

    marginHistory.push({
      year: label,
      netMargin:       parseFloat(netMar.toFixed(1)),
      operatingMargin: opMar,
    });
  });

  // ── P&L from most recent year ─────────────────────────────────────────────
  const plStatement = buildPLFromAPI(periodsRaw, currency);

  return { companyInfo, currency, revenueHistory, marginHistory, plStatement };
}

// ── Fetch quarterly data ───────────────────────────────────────────────────────

export async function fetchQuarterlyFinancials(searchString: string): Promise<QuarterlyDataPoint[]> {
  const url = `${FINANCE_API_BASE}/ScrapQuarterAnalysisData?searchString=${searchString}`;
  // 60 s timeout — Puppeteer-based API can be slow to launch the browser
  const res  = await fetchWithTimeout(url, 60_000);
  if (!res.ok) throw new Error(`Finance API quarterly: HTTP ${res.status}`);
  const data = (await res.json()) as QuarterlyAPIResponse;

  const raw      = data.QuarterFinancialAnalysis || {};
  const currency = extractCurrency(raw);

  const points: QuarterlyDataPoint[] = [];
  for (const [period, val] of Object.entries(raw)) {
    if (period === 'ReportedCurrency') continue;
    const p = val as AnnualPeriodData;
    const rev = parseFinanceValue(p.Revenue);
    const opex = parseFinanceValue(p['Operating expense']);
    const ni   = parseFinanceValue(p['Net income']);
    const eps  = p['Earnings per share'];

    points.push({
      period,
      revenue:          rev ?? undefined,
      revenueFormatted: rev != null ? formatWithCurrency(rev, currency) : undefined,
      operatingExpense: opex ?? undefined,
      netIncome:        ni ?? undefined,
      netProfitMargin:  p['Net profit margin'] ? parseFloat(p['Net profit margin']) : undefined,
      earningsPerShare: (eps && eps !== EM_DASH && eps !== EN_DASH) ? eps : '—',
      effectiveTaxRate: p['Effective tax rate'],
    });
  }

  // Sort chronologically: parse "DEC 2025" → Date, oldest first
  points.sort((a, b) => parsePeriodDate(a.period) - parsePeriodDate(b.period));
  return points;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractCurrency(fin: Record<string, unknown> | undefined): string {
  if (!fin) return 'USD';
  const cur = fin['ReportedCurrency'] as { Currency?: string } | undefined;
  return cur?.Currency?.toUpperCase() || 'USD';
}

interface PeriodEntry { label: string; data: AnnualPeriodData }

function buildSortedPeriods(fin: Record<string, AnnualPeriodData | { Currency: string }>): PeriodEntry[] {
  // Deduplicate: if "2022" and "2022_1" both exist, prefer "2022" (no suffix)
  const yearMap = new Map<number, { key: string; hasSuffix: boolean }>();
  for (const key of Object.keys(fin)) {
    if (key === 'ReportedCurrency') continue;
    const year = parseInt(key.split('_')[0], 10);
    if (isNaN(year)) continue;
    const hasSuffix = key.includes('_');
    const existing  = yearMap.get(year);
    if (!existing || (!hasSuffix && existing.hasSuffix)) {
      yearMap.set(year, { key, hasSuffix });
    }
  }
  return [...yearMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, { key }]) => ({ label: String(parseInt(key.split('_')[0], 10)), data: fin[key] as AnnualPeriodData }));
}

function parsePeriodDate(period: string): number {
  const MONTHS: Record<string, number> = {
    JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
    JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
  };
  const parts = period.trim().split(/\s+/);
  if (parts.length === 2) {
    const mon = MONTHS[parts[0].toUpperCase()];
    const yr  = parseInt(parts[1], 10);
    if (mon !== undefined && !isNaN(yr)) return new Date(yr, mon, 1).getTime();
  }
  return 0;
}

function buildPLFromAPI(periods: PeriodEntry[], currency: string): FinancialStatementRow[] {
  if (periods.length === 0) return [];
  const current = periods[periods.length - 1].data;
  const prev    = periods.length > 1 ? periods[periods.length - 2].data : null;

  const rev    = parseFinanceValue(current.Revenue);
  const opex   = parseFinanceValue(current['Operating expense']);
  const ni     = parseFinanceValue(current['Net income']);
  const opInc  = (rev != null && opex != null) ? rev - opex : null;
  const netMar = current['Net profit margin'];
  const taxR   = current['Effective tax rate'];
  const eps    = current['Earnings per share'];
  const ebitda = parseFinanceValue(current.EBITDA);

  const pRev   = prev ? parseFinanceValue(prev.Revenue) : null;
  const pOpex  = prev ? parseFinanceValue(prev['Operating expense']) : null;
  const pNi    = prev ? parseFinanceValue(prev['Net income']) : null;
  const pOpInc = (pRev != null && pOpex != null) ? pRev - pOpex : null;

  const rows: FinancialStatementRow[] = [
    { label: 'INCOME SUMMARY', value: '', isSection: true },
    { label: 'Revenue',             value: formatWithCurrency(rev, currency),   yoy: calcYoy(rev, pRev),     isBold: true },
    { label: 'Operating Expense',   value: formatWithCurrency(opex, currency),  yoy: calcYoy(opex, pOpex) },
    { label: 'Operating Income',    value: formatWithCurrency(opInc, currency), yoy: calcYoy(opInc, pOpInc), isBold: true },
    ...(opInc != null && rev ? [{ label: 'Operating Margin', value: `${((opInc / rev) * 100).toFixed(1)}%` }] : []),
    ...(ebitda != null ? [{ label: 'EBITDA', value: formatWithCurrency(ebitda, currency) }] : []),
    { label: 'NET RESULTS', value: '', isSection: true },
    { label: 'Net Income',          value: formatWithCurrency(ni, currency),    yoy: calcYoy(ni, pNi),       isBold: true },
    ...(netMar && netMar !== EM_DASH ? [{ label: 'Net Profit Margin', value: `${parseFloat(netMar).toFixed(1)}%` }] : []),
    ...(eps && eps !== EM_DASH && eps !== EN_DASH && eps !== '—' ? [{ label: 'Earnings per Share', value: eps }] : []),
    ...(taxR && taxR !== EM_DASH ? [{ label: 'Effective Tax Rate', value: taxR }] : []),
  ];

  return rows.filter((r) => r.isSection || r.value !== 'N/A');
}

// ── Ticker detection (unchanged — still uses yahoo-finance2) ──────────────────

// Exchange codes that map to US major stock exchanges
const US_EXCHANGE_CODES = new Set([
  'NMS', 'NGM', 'NCM', // NASDAQ variants
  'NYQ', 'NYE',         // NYSE
  'PCX',                // NYSE ARCA
  'ASE',                // NYSE American
  'BTS', 'CBOE',        // BATS/CBOE
]);

// Quote types that are NOT equities
const NON_EQUITY_TYPES = new Set([
  'MUTUALFUND', 'ETF', 'INDEX', 'CURRENCY',
  'FUTURE', 'OPTION', 'CRYPTOCURRENCY', 'MONEYMARKET',
]);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isEquityQuote(q: any): boolean {
  const qt = (q.quoteType || '').toUpperCase();
  const td = (q.typeDisp || '').toLowerCase();
  if (NON_EQUITY_TYPES.has(qt)) return false;
  if (qt === 'EQUITY' || td === 'equity') return true;
  if (!qt || qt === '') {
    const sym = (q.symbol || '') as string;
    return /^[A-Z]{1,5}$/.test(sym);
  }
  return false;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isUSExchangeQuote(q: any): boolean {
  const exch = ((q.exchDisp || q.exchange || '') as string).toUpperCase();
  if (exch.includes('NASDAQ') || exch.includes('NYSE')) return true;
  return US_EXCHANGE_CODES.has(exch);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function runSearch(query: string): Promise<any[]> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const results = await yahooFinance.search(query, {} as any, { validateResult: false } as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const quotes: any[] = (results as any).quotes || [];
    return quotes.filter(isEquityQuote);
  } catch {
    return [];
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function scoreQuote(q: any, companyName: string, domainHint: string): number {
  const qName   = ((q.shortname || q.longname || '') as string).toLowerCase();
  const qSym    = ((q.symbol || '') as string).toLowerCase();
  const nameLow = companyName.toLowerCase();
  let s = 0;

  if (isUSExchangeQuote(q)) s += 15;

  if (qName === nameLow) s += 30;
  else if (qName.startsWith(nameLow.split(' ')[0])) s += 10;
  else if (qName.includes(nameLow.split(' ')[0])) s += 5;

  if (domainHint) {
    if (qSym === domainHint) s += 20;
    if (qName.includes(domainHint)) s += 10;
  }

  return s;
}

export async function detectTicker(
  companyName: string,
  domain?: string
): Promise<{ ticker: string; exchange: string } | null> {
  const domainHint = domain ? domain.replace(/^www\./, '').split('.')[0].toLowerCase() : '';
  const words      = companyName.trim().split(/\s+/);

  const queries: string[] = [companyName];
  if (words.length > 2) queries.push(words.slice(0, 2).join(' '));
  if (words.length > 1) queries.push(words[0]);
  if (domainHint && domainHint.length <= 5) queries.push(domainHint.toUpperCase());

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let equities: any[] = [];

  for (const query of queries) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const found: any[] = await runSearch(query);
    if (found.length > 0) { equities = found; break; }
  }
  if (equities.length === 0) return null;

  equities.sort((a, b) => scoreQuote(b, companyName, domainHint) - scoreQuote(a, companyName, domainHint));

  const best     = equities[0];
  const exchange = best.exchDisp || best.exchange || '';
  return { ticker: best.symbol as string, exchange };
}
