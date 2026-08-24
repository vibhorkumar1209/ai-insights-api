import YahooFinance from 'yahoo-finance2';
import fetch from 'node-fetch';
import {
  RevenueDataPoint,
  MarginDataPoint,
  FinancialStatementRow,
  CompanyInfo,
  QuarterlyDataPoint,
} from '@ai-insights/types';

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
  // LATAM
  SA:  'BVMF',  // Brazil — B3 (formerly Bovespa)
  MX:  'BMV',   // Mexico — Bolsa Mexicana de Valores
  CL:  'BVC',   // Colombia — Bolsa de Valores de Colombia
  SN:  'SNSE',  // Chile — Bolsa de Santiago
  BA:  'BCBA',  // Argentina — Bolsa de Comercio de Buenos Aires
  LM:  'BVL',   // Peru — Bolsa de Valores de Lima
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

// ── USD-normalised revenue formatting (Firmographic module) ──────────────────
// Static approximate FX-to-USD rates. Good enough for the Firmographic
// module's "USD Million unless >= $1B" display rule — this is a scale
// indicator, not a precision financial conversion.
const FX_TO_USD: Record<string, number> = {
  USD: 1, GBP: 1.27, EUR: 1.08, JPY: 0.0067, CAD: 0.73, AUD: 0.65,
  INR: 0.012, CHF: 1.13, CNY: 0.14, HKD: 0.128, SGD: 0.74, KRW: 0.00073,
};

/** Converts a raw amount in its native currency to a raw USD number (no formatting). */
export function convertToUsd(raw: number, currency = 'USD'): number {
  const rate = FX_TO_USD[currency.toUpperCase()] ?? 1;
  return raw * rate;
}

/** Format a raw revenue figure (in its native currency) per the Firmographic
 *  module rule: USD Millions if under $1B, USD Billions if $1B or more.
 *  If the native currency isn't USD, append the native-currency figure in
 *  brackets, e.g. "$485M (₹4,020 Cr)" or "$12.4B ($12.4B)" → no bracket if USD. */
export function formatRevenueUSD(raw: number | null, currency = 'USD'): string {
  if (raw == null || isNaN(raw)) return 'N/A';
  const cur = currency.toUpperCase();
  const rate = FX_TO_USD[cur] ?? 1;
  const usd = raw * rate;
  const sign = usd < 0 ? '-' : '';
  const absUsd = Math.abs(usd);

  // Below $1M, M would round to "$0M" — fall back to K (or plain dollars under $1K).
  let usdStr: string;
  if (absUsd >= 1e9) {
    usdStr = `${sign}$${(absUsd / 1e9).toFixed(2)}B`;
  } else if (absUsd >= 1e6) {
    usdStr = `${sign}$${(absUsd / 1e6).toFixed(0)}M`;
  } else if (absUsd >= 1e3) {
    usdStr = `${sign}$${(absUsd / 1e3).toFixed(0)}K`;
  } else {
    usdStr = `${sign}$${absUsd.toFixed(0)}`;
  }

  if (cur === 'USD') return usdStr;

  // Native-currency figure in brackets, formatted with the same scale rule
  // using the native currency's own symbol.
  const nativeAbs = Math.abs(raw);
  const nativeSign = raw < 0 ? '-' : '';
  const sym = CURRENCY_SYMBOLS[cur] ?? (cur + ' ');
  let nativeStr: string;
  if (cur === 'INR') {
    // India reports in Crore (1 Cr = 10,000,000) or Lakh (1 Lakh = 100,000) for smaller figures.
    if (nativeAbs >= 1e7) {
      nativeStr = `${nativeSign}${sym}${(nativeAbs / 1e7).toLocaleString(undefined, { maximumFractionDigits: 0 })} Cr`;
    } else if (nativeAbs >= 1e5) {
      nativeStr = `${nativeSign}${sym}${(nativeAbs / 1e5).toLocaleString(undefined, { maximumFractionDigits: 1 })} Lakh`;
    } else {
      nativeStr = `${nativeSign}${sym}${nativeAbs.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
    }
  } else if (nativeAbs >= 1e9) {
    nativeStr = `${nativeSign}${sym}${(nativeAbs / 1e9).toFixed(2)}B`;
  } else if (nativeAbs >= 1e6) {
    nativeStr = `${nativeSign}${sym}${(nativeAbs / 1e6).toFixed(0)}M`;
  } else if (nativeAbs >= 1e3) {
    nativeStr = `${nativeSign}${sym}${(nativeAbs / 1e3).toFixed(0)}K`;
  } else {
    nativeStr = `${nativeSign}${sym}${nativeAbs.toFixed(0)}`;
  }

  return `${usdStr} (${nativeStr})`;
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

// Bounds how much of the Puppeteer scraper's response body this process will
// buffer before parsing — same pattern as parallelAI.ts's readBodyLimited,
// applied here because this backend runs on a 512MB instance and an
// unbounded `res.json()` on a pathological/garbled scraper response has no
// upper limit on memory it can consume.
async function readJsonBodyLimited<T>(res: import('node-fetch').Response, maxBytes = 2_000_000): Promise<T> {
  const body = res.body;
  if (!body) return {} as T;

  const rawText = await new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    (body as unknown as import('stream').Readable)
      .on('data', (raw: unknown) => {
        const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
        const remaining = maxBytes - total;
        if (chunk.length >= remaining) {
          chunks.push(chunk.slice(0, remaining));
          total = maxBytes;
          try { (body as unknown as { destroy?: () => void }).destroy?.(); } catch { /* ignore */ }
        } else {
          chunks.push(chunk);
          total += chunk.length;
        }
      })
      .on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      .on('error', () => resolve(Buffer.concat(chunks).toString('utf8')))
      .on('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });

  return JSON.parse(rawText) as T;
}

// ── Fetch annual data ──────────────────────────────────────────────────────────

export interface AnnualFinancialsResult {
  companyInfo:      CompanyInfo;
  currency:         string;
  revenueHistory:   RevenueDataPoint[];
  marginHistory:    MarginDataPoint[];
  plStatement:      FinancialStatementRow[];
  balanceSheet?:    FinancialStatementRow[];
  cashFlow?:        FinancialStatementRow[];
  quarterlyHistory?: QuarterlyDataPoint[];
}

export async function fetchAnnualFinancials(searchString: string): Promise<AnnualFinancialsResult> {
  const url = `${FINANCE_API_BASE}/SearchOnPuppeteer?searchString=${searchString}`;
  // 60 s timeout — Puppeteer-based API can be slow to launch the browser
  const res  = await fetchWithTimeout(url, 60_000);
  if (!res.ok) throw new Error(`Finance API annual: HTTP ${res.status}`);
  const data = await readJsonBodyLimited<AnnualAPIResponse>(res);

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

// ── Fetch financials directly via yahoo-finance2 quoteSummary ─────────────────
// Used as fallback for non-US tickers where the Puppeteer scraper returns 400.
// Returns the same AnnualFinancialsResult shape so the caller needs no changes.
export async function fetchYahooQuoteSummaryFinancials(ticker: string): Promise<AnnualFinancialsResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r: any = await (yahooFinance as any).quoteSummary(ticker, {
    modules: [
      'incomeStatementHistory', 'financialData', 'summaryDetail', 'summaryProfile', 'price',
      'incomeStatementHistoryQuarterly',
    ],
  }, { validateResult: false });

  // balanceSheetHistory/cashflowStatementHistory (quoteSummary submodules) have
  // returned almost no data since Nov 2024 — Yahoo's replacement is
  // fundamentalsTimeSeries. Fetched separately (non-fatal if it fails).
  const period1 = new Date();
  period1.setFullYear(period1.getFullYear() - 3);
  const [bsSeries, cfSeries] = await Promise.all([
    (yahooFinance as any).fundamentalsTimeSeries(ticker, { period1, module: 'balance-sheet', type: 'annual' }, { validateResult: false }).catch(() => []),
    (yahooFinance as any).fundamentalsTimeSeries(ticker, { period1, module: 'cash-flow', type: 'annual' }, { validateResult: false }).catch(() => []),
  ]);

  const priceCurrency: string = (r.price?.currency || 'USD').toUpperCase();
  const currency = priceCurrency;

  // ── Company info ──────────────────────────────────────────────────────────
  const sd = r.summaryDetail || {};
  const sp = r.summaryProfile || {};
  const px = r.price || {};
  const companyInfo: CompanyInfo = {
    name:          px.longName || px.shortName,
    exchange:      px.exchangeName,
    marketCap:     sd.marketCap  ? formatWithCurrency(sd.marketCap, currency)  : undefined,
    peRatio:       sd.trailingPE ? String(sd.trailingPE.toFixed(2))            : undefined,
    dividendYield: sd.dividendYield ? `${(sd.dividendYield * 100).toFixed(2)}%` : undefined,
    headquarters:  sp.city && sp.country ? `${sp.city}, ${sp.country}` : undefined,
    website:       sp.website,
    employees:     sp.fullTimeEmployees ? String(sp.fullTimeEmployees) : undefined,
    about:         sp.longBusinessSummary,
  };

  // ── Annual income ─────────────────────────────────────────────────────────
  const fd = r.financialData || {};
  const incRows: any[] = r.incomeStatementHistory?.incomeStatementHistory || [];
  // Sort oldest→newest
  incRows.sort((a: any, b: any) => new Date(a.endDate).getTime() - new Date(b.endDate).getTime());

  const revenueHistory: RevenueDataPoint[] = [];
  const marginHistory: MarginDataPoint[] = [];

  incRows.forEach((row: any, idx: number) => {
    const rev = typeof row.totalRevenue === 'number' ? row.totalRevenue : null;
    const ni  = typeof row.netIncome === 'number' ? row.netIncome : null;
    if (rev == null) return;

    const prevRev = idx > 0 ? (typeof incRows[idx - 1].totalRevenue === 'number' ? incRows[idx - 1].totalRevenue : null) : null;
    const yoyNum  = prevRev ? ((rev - prevRev) / Math.abs(prevRev)) * 100 : undefined;
    const year    = String(new Date(row.endDate).getFullYear());

    revenueHistory.push({
      year,
      revenue: rev,
      revenueFormatted: formatWithCurrency(rev, currency),
      yoyGrowth: yoyNum != null ? parseFloat(yoyNum.toFixed(1)) : undefined,
    });

    // Use current-period margins from financialData for the most recent row; derive for older rows
    const isLastRow = idx === incRows.length - 1;
    const netMar  = isLastRow && fd.profitMargins  != null ? parseFloat((fd.profitMargins * 100).toFixed(1))  : (ni != null && rev > 0 ? parseFloat(((ni / rev) * 100).toFixed(1)) : 0);
    const opMar   = isLastRow && fd.operatingMargins != null ? parseFloat((fd.operatingMargins * 100).toFixed(1)) : 0;

    marginHistory.push({ year, netMargin: netMar, operatingMargin: opMar });
  });

  // ── P&L rows (current year, using financialData for margins) ─────────────
  const lastRow = incRows[incRows.length - 1];
  const prevRow = incRows.length > 1 ? incRows[incRows.length - 2] : null;
  const plStatement: FinancialStatementRow[] = [];
  if (lastRow) {
    const rev   = lastRow.totalRevenue as number | null;
    const ni    = lastRow.netIncome    as number | null;
    const pRev  = prevRow?.totalRevenue as number | null ?? null;
    const pNi   = prevRow?.netIncome   as number | null ?? null;
    const ebitda = typeof fd.ebitda === 'number' ? fd.ebitda : null;
    const opMar  = typeof fd.operatingMargins === 'number' ? fd.operatingMargins : null;
    const opInc  = opMar != null && rev != null ? opMar * rev : null;
    const netMar = typeof fd.profitMargins === 'number' ? fd.profitMargins : null;

    plStatement.push(
      { label: 'INCOME SUMMARY', value: '', isSection: true },
      { label: 'Revenue',          value: formatWithCurrency(rev, currency), previousValue: formatWithCurrency(pRev, currency), yoy: calcYoy(rev, pRev), isBold: true },
      ...(opInc != null ? [{ label: 'Operating Income', value: formatWithCurrency(opInc, currency), isBold: true }] : []),
      ...(opMar != null ? [{ label: 'Operating Margin', value: `${(opMar * 100).toFixed(1)}%` }] : []),
      ...(ebitda != null ? [{ label: 'EBITDA', value: formatWithCurrency(ebitda, currency) }] : []),
      { label: 'NET RESULTS', value: '', isSection: true },
      { label: 'Net Income', value: formatWithCurrency(ni, currency), previousValue: formatWithCurrency(pNi, currency), yoy: calcYoy(ni, pNi), isBold: true },
      ...(netMar != null ? [{ label: 'Net Profit Margin', value: `${(netMar * 100).toFixed(1)}%` }] : []),
    );
  }

  // ── Balance Sheet & Cash Flow (most recent period vs. prior, for comparison) ──
  const statementRow = (
    curPeriod: any, prevPeriod: any, label: string, key: string, isBold = false
  ): FinancialStatementRow | null => {
    const cur  = typeof curPeriod?.[key] === 'number' ? curPeriod[key] : null;
    const prev = typeof prevPeriod?.[key] === 'number' ? prevPeriod[key] : null;
    if (cur == null) return null;
    return { label, value: formatWithCurrency(cur, currency), previousValue: formatWithCurrency(prev, currency), yoy: calcYoy(cur, prev), isBold };
  };

  const bsRows: any[] = Array.isArray(bsSeries) ? bsSeries : [];
  bsRows.sort((a: any, b: any) => new Date(a.date).getTime() - new Date(b.date).getTime());
  const lastBs = bsRows[bsRows.length - 1];
  const prevBs = bsRows.length > 1 ? bsRows[bsRows.length - 2] : null;
  const balanceSheet: FinancialStatementRow[] = lastBs
    ? [
        { label: 'ASSETS', value: '', isSection: true },
        statementRow(lastBs, prevBs, 'Cash & Equivalents', 'cashAndCashEquivalents'),
        statementRow(lastBs, prevBs, 'Total Current Assets', 'currentAssets', true),
        statementRow(lastBs, prevBs, 'Total Assets', 'totalAssets', true),
        { label: 'LIABILITIES', value: '', isSection: true },
        statementRow(lastBs, prevBs, 'Total Current Liabilities', 'currentLiabilities', true),
        statementRow(lastBs, prevBs, 'Total Liabilities', 'totalLiabilitiesNetMinorityInterest', true),
        { label: 'EQUITY', value: '', isSection: true },
        statementRow(lastBs, prevBs, 'Total Stockholder Equity', 'stockholdersEquity', true),
      ].filter((x): x is FinancialStatementRow => x != null)
    : [];

  const cfRows: any[] = Array.isArray(cfSeries) ? cfSeries : [];
  cfRows.sort((a: any, b: any) => new Date(a.date).getTime() - new Date(b.date).getTime());
  const lastCf = cfRows[cfRows.length - 1];
  const prevCf = cfRows.length > 1 ? cfRows[cfRows.length - 2] : null;
  const cashFlow: FinancialStatementRow[] = lastCf
    ? [
        { label: 'OPERATING ACTIVITIES', value: '', isSection: true },
        statementRow(lastCf, prevCf, 'Cash from Operations', 'operatingCashFlow', true),
        { label: 'INVESTING ACTIVITIES', value: '', isSection: true },
        statementRow(lastCf, prevCf, 'Capital Expenditures', 'capitalExpenditure'),
        statementRow(lastCf, prevCf, 'Cash from Investing', 'investingCashFlow', true),
        { label: 'FINANCING ACTIVITIES', value: '', isSection: true },
        statementRow(lastCf, prevCf, 'Cash from Financing', 'financingCashFlow', true),
        { label: 'NET CHANGE', value: '', isSection: true },
        statementRow(lastCf, prevCf, 'Net Change in Cash', 'changesInCash', true),
      ].filter((x): x is FinancialStatementRow => x != null)
    : [];

  // ── Quarterly income history ───────────────────────────────────────────────
  const qRows: any[] = r.incomeStatementHistoryQuarterly?.incomeStatementHistory || [];
  qRows.sort((a: any, b: any) => new Date(a.endDate).getTime() - new Date(b.endDate).getTime());
  const quarterlyHistory: QuarterlyDataPoint[] = qRows
    .filter((row: any) => typeof row.totalRevenue === 'number')
    .map((row: any) => {
      const rev  = row.totalRevenue as number;
      const ni   = typeof row.netIncome === 'number' ? row.netIncome : undefined;
      const opEx = typeof row.totalOperatingExpenses === 'number' ? row.totalOperatingExpenses : undefined;
      const d = new Date(row.endDate);
      const period = `${d.toLocaleString('en-US', { month: 'short' }).toUpperCase()} ${d.getFullYear()}`;
      return {
        period,
        revenue: rev,
        revenueFormatted: formatWithCurrency(rev, currency),
        operatingExpense: opEx,
        netIncome: ni,
        netProfitMargin: ni != null && rev > 0 ? parseFloat(((ni / rev) * 100).toFixed(2)) : undefined,
      };
    });

  return {
    companyInfo, currency, revenueHistory, marginHistory, plStatement,
    balanceSheet: balanceSheet.length ? balanceSheet : undefined,
    cashFlow: cashFlow.length ? cashFlow : undefined,
    quarterlyHistory: quarterlyHistory.length ? quarterlyHistory : undefined,
  };
}

// ── Fetch quarterly data ───────────────────────────────────────────────────────

export async function fetchQuarterlyFinancials(searchString: string): Promise<QuarterlyDataPoint[]> {
  const url = `${FINANCE_API_BASE}/ScrapQuarterAnalysisData?searchString=${searchString}`;
  // 60 s timeout — Puppeteer-based API can be slow to launch the browser
  const res  = await fetchWithTimeout(url, 60_000);
  if (!res.ok) throw new Error(`Finance API quarterly: HTTP ${res.status}`);
  const data = await readJsonBodyLimited<QuarterlyAPIResponse>(res);

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

  const pEbitda = prev ? parseFinanceValue(prev.EBITDA) : null;
  const pNetMar = prev ? prev['Net profit margin'] : null;

  const rows: FinancialStatementRow[] = [
    { label: 'INCOME SUMMARY', value: '', isSection: true },
    { label: 'Revenue',             value: formatWithCurrency(rev, currency),   previousValue: formatWithCurrency(pRev, currency),   yoy: calcYoy(rev, pRev),     isBold: true },
    { label: 'Operating Expense',   value: formatWithCurrency(opex, currency),  previousValue: formatWithCurrency(pOpex, currency),  yoy: calcYoy(opex, pOpex) },
    { label: 'Operating Income',    value: formatWithCurrency(opInc, currency), previousValue: formatWithCurrency(pOpInc, currency), yoy: calcYoy(opInc, pOpInc), isBold: true },
    ...(opInc != null && rev ? [{ label: 'Operating Margin', value: `${((opInc / rev) * 100).toFixed(1)}%`, previousValue: pOpInc != null && pRev ? `${((pOpInc / pRev) * 100).toFixed(1)}%` : undefined }] : []),
    ...(ebitda != null ? [{ label: 'EBITDA', value: formatWithCurrency(ebitda, currency), previousValue: formatWithCurrency(pEbitda, currency) }] : []),
    { label: 'NET RESULTS', value: '', isSection: true },
    { label: 'Net Income',          value: formatWithCurrency(ni, currency),    previousValue: formatWithCurrency(pNi, currency),    yoy: calcYoy(ni, pNi),       isBold: true },
    ...(netMar && netMar !== EM_DASH ? [{ label: 'Net Profit Margin', value: `${parseFloat(netMar).toFixed(1)}%`, previousValue: pNetMar && pNetMar !== EM_DASH ? `${parseFloat(pNetMar).toFixed(1)}%` : undefined }] : []),
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

// Check if query is an acronym formed from the initials of the company name
function acronymMatchesName(query: string, name: string): boolean {
  const q = query.toUpperCase().trim();
  if (!/^[A-Z]{2,6}$/.test(q)) return false;
  const words = name.trim().split(/\s+/).filter((w) => /[A-Za-z]/.test(w[0]));
  const initials = words.map((w) => w[0].toUpperCase()).join('');
  return initials === q || (initials.startsWith(q) && q.length >= 2);
}

// Strip everything except letters/digits (any script) so spacing/punctuation
// variants ("JP Morgan" vs "JPMorgan", "Co." vs "Co") compare equal. Uses
// Unicode property escapes rather than [a-z0-9] so non-Latin company names
// (e.g. Japanese, Arabic, Cyrillic) aren't reduced to an empty string —
// that would make companyNameLooselyMatches() always report "no match" and
// reject perfectly valid data for any internationally-named company.
function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

/**
 * Sanity-check that a fetched company name (from Yahoo/Google Finance) actually
 * corresponds to the requested company name, before its financials are trusted.
 * Needed because ticker sources like claudeLookupTicker (an LLM guess) carry no
 * built-in verification — unlike detectTicker's own scoreQuote() matching — so a
 * hallucinated or wrong-company ticker would otherwise silently return someone
 * else's real financials with no indication anything was off.
 * Deliberately loose (normalized substring/prefix/acronym match) to tolerate
 * legal-suffix and formatting differences ("Alphabet Inc." vs "Alphabet"),
 * not a precision check.
 */
export function companyNameLooselyMatches(requestedName: string, fetchedName: string | undefined): boolean {
  if (!fetchedName) return false;

  // Yahoo/Google Finance company names are always Latin-script, even for
  // companies whose name the user entered in another script (e.g. "トヨタ自動車"
  // vs the fetched "Toyota Motor Corp") — no normalization can make those
  // strings overlap. Rejecting on that basis would discard genuinely correct
  // data purely because of the script mismatch, not because the ticker is
  // wrong. Treat a non-Latin request as unverifiable-by-text and defer to
  // whatever verification the ticker source itself already did, rather than
  // failing closed.
  if (!/[a-zA-Z]/.test(requestedName)) return true;

  const reqNorm = normalizeName(requestedName);
  const fetchedNorm = normalizeName(fetchedName);
  if (!reqNorm || !fetchedNorm) return false;
  if (reqNorm === fetchedNorm) return true;
  // Substring match — but only when the shorter string covers a meaningful
  // share of the longer one. Without this guard, a short/generic requested
  // name that happens to be the literal leading word of a completely
  // unrelated company's full legal name (e.g. "Croma" is a true prefix of
  // "Croma Security Solutions Group plc", an unrelated UK locksmith/security
  // firm, not the Tata-owned Indian electronics retailer the user meant)
  // would pass this check every time — no name-only heuristic can tell those
  // apart since they share the identical first word. This can't be fully
  // fixed by name matching alone (see companyIdentityConfirmed for the
  // domain-based check that actually resolves this), but requiring the
  // match to cover a real share of the string closes the worst cases and
  // fails closed (defers to research fallback) rather than silently
  // accepting a coin-flip match.
  const longer = Math.max(reqNorm.length, fetchedNorm.length);
  const shorter = Math.min(reqNorm.length, fetchedNorm.length);
  if ((fetchedNorm.includes(reqNorm) || reqNorm.includes(fetchedNorm)) && shorter / longer >= 0.5) return true;
  const reqFirstWordNorm = normalizeName(requestedName.trim().split(/\s+/)[0] || '');
  if (reqFirstWordNorm.length >= 3 && fetchedNorm.includes(reqFirstWordNorm) && reqFirstWordNorm.length / fetchedNorm.length >= 0.5) return true;
  if (acronymMatchesName(requestedName, fetchedName)) return true;
  return false;
}

/**
 * Authoritative identity check: if the user supplied a company domain AND the
 * fetched company data discloses its own website, compare domains directly —
 * this has essentially zero false-positive risk (unlike fuzzy name matching,
 * which fundamentally cannot distinguish two different companies that happen
 * to share a name/prefix, like the Croma case above) and is decisive in both
 * directions: a domain match confirms identity outright even if the fuzzy
 * name check would have failed (e.g. a company that rebranded its trading
 * name), and a domain MISMATCH rejects outright even if the fuzzy name check
 * would have passed. Falls back to companyNameLooselyMatches only when no
 * domain signal is available on one or both sides.
 */
export function companyIdentityConfirmed(params: {
  requestedName: string;
  requestedDomain?: string;
  fetchedName?: string;
  fetchedWebsite?: string;
}): boolean {
  const { requestedName, requestedDomain, fetchedName, fetchedWebsite } = params;
  const reqDomain = normalizeDomain(requestedDomain);
  const fetchedDomain = normalizeDomain(fetchedWebsite);
  if (reqDomain && fetchedDomain) {
    // Compare only the registrable "core" label (before the first dot of the
    // normalized hostname) so "croma.com" vs a fetched "www.croma.com"/
    // "croma.co.in" style variant still matches on the part that actually
    // identifies the business, while a genuinely different domain
    // (croma.com vs cssgplc.com) is rejected outright.
    return reqDomain.split('.')[0] === fetchedDomain.split('.')[0];
  }
  return companyNameLooselyMatches(requestedName, fetchedName);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function scoreQuote(q: any, companyName: string, domainHint: string): number {
  const fullName = ((q.shortname || q.longname || '') as string);
  const qName    = fullName.toLowerCase();
  const qNameNorm = normalizeName(fullName);
  const qSym     = ((q.symbol || '') as string).toLowerCase();
  // Base symbol without exchange suffix (e.g. "tcs.ns" → "tcs")
  const qSymBase = qSym.split('.')[0];
  const nameLow  = companyName.toLowerCase();
  const nameLowFirstWordNorm = normalizeName(nameLow.split(' ')[0]);
  let s = 0;

  // US exchange is a small tiebreaker, not a dominant signal
  if (isUSExchangeQuote(q)) s += 8;

  // Exact / prefix / substring name match — normalized to ignore spacing
  // and punctuation differences (e.g. Yahoo's "JP Morgan Chase & Co." vs
  // query "JPMorgan Chase" would otherwise score zero on a real match).
  if (qNameNorm === normalizeName(nameLow)) s += 40;
  else if (qNameNorm.startsWith(nameLowFirstWordNorm)) s += 15;
  else if (qNameNorm.includes(nameLowFirstWordNorm)) s += 8;

  // Acronym match: "TCS" → "Tata Consultancy Services" gets a strong bonus
  if (acronymMatchesName(companyName, fullName)) s += 30;

  // Domain hint: match against base symbol AND company name
  // Use base symbol (without exchange suffix) to avoid false positive where
  // "tcs" hint matches Tecsys symbol "tcs" but misses TCS.NS base "tcs"
  if (domainHint) {
    if (qSymBase === domainHint) s += 12; // reduced — symbol match alone is weak
    if (qName.includes(domainHint)) s += 15; // name match is stronger signal
  }

  return s;
}

/**
 * Normalize a user-supplied domain into a bare hostname: strips protocol,
 * path/query/fragment, port, and leading "www." (case-insensitively),
 * lowercased. Without this, inputs like "https://www.Example.com/about" fed
 * straight into a naive `.replace(/^www\./, '')` produce garbage hints
 * ("https://www") that silently degrade ticker matching rather than erroring
 * loudly — worth normalizing once, centrally, rather than trusting every
 * call site to handle raw user input.
 */
export function normalizeDomain(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  let d = raw.trim();
  if (!d) return undefined;
  d = d.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, ''); // strip protocol
  d = d.split(/[/?#]/)[0];                              // strip path/query/fragment
  d = d.replace(/^www\./i, '');                         // strip leading www (case-insensitive)
  d = d.replace(/:\d+$/, '');                           // strip port
  d = d.toLowerCase().replace(/\.$/, '');                // lowercase, strip trailing dot
  return d || undefined;
}

export async function detectTicker(
  companyName: string,
  domain?: string
): Promise<{ ticker: string; exchange: string } | null> {
  const normalizedDomain = normalizeDomain(domain);
  const domainHint = normalizedDomain ? normalizedDomain.split('.')[0] : '';
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

  const best      = equities[0];
  const bestScore = scoreQuote(best, companyName, domainHint);
  // A broad/generic query (e.g. just the first word of a multi-word company
  // name, pushed onto `queries` above) can return a plausible-looking but
  // unrelated top result with a very low score — nothing in scoreQuote's
  // weighting requires an actual name/domain/acronym match to "win", it just
  // has to be the highest of whatever candidates came back. Reject outright
  // rather than return a low-confidence guess; the caller falls through to
  // the Claude lookup / private-company path instead.
  if (bestScore < 8) {
    console.warn(`[yahooFinance] detectTicker: best match for "${companyName}" scored too low (${bestScore}) — treating as not found`);
    return null;
  }

  const exchange = best.exchDisp || best.exchange || '';
  return { ticker: best.symbol as string, exchange };
}
