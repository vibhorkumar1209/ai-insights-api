/**
 * Financial Modeling Prep (FMP) API Service
 * Primary source for P&L, Balance Sheet, Cash Flow, and company profile data.
 * Falls back to Yahoo Finance / custom Finance API if FMP fails.
 */

import fetch from 'node-fetch';
import {
  RevenueDataPoint,
  MarginDataPoint,
  FinancialStatementRow,
  CompanyInfo,
  QuarterlyDataPoint,
} from '@ai-insights/types';

const FMP_API_KEY = process.env.FMP_API_KEY || '1d16301a73791aa9231a3e2d60147fca';
const FMP_BASE = 'https://financialmodelingprep.com/stable';
const TIMEOUT_MS = 30_000;

// ── Helper: fetch with timeout ────────────────────────────────────────────────

async function fmpFetch<T>(path: string, retries = 2): Promise<T> {
  const url = `${FMP_BASE}${path}${path.includes('?') ? '&' : '?'}apikey=${FMP_API_KEY}`;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: controller.signal as never });
      if (res.status === 429) {
        clearTimeout(timer);
        if (attempt < retries) {
          await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
          continue;
        }
        throw new Error(`FMP API 429: rate limit exceeded`);
      }
      if (!res.ok) throw new Error(`FMP API ${res.status}: ${res.statusText}`);
      const data = await res.json();
      if (data && typeof data === 'object' && 'Error Message' in (data as Record<string, unknown>)) {
        throw new Error(`FMP API error: ${(data as Record<string, string>)['Error Message']}`);
      }
      return data as T;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error('FMP API: max retries exceeded');
}

// ── Format helpers ────────────────────────────────────────────────────────────

const CURRENCY_SYMBOLS: Record<string, string> = {
  // North America
  USD: '$', CAD: 'C$', MXN: 'MX$',
  // South America
  BRL: 'R$', ARS: 'AR$', CLP: 'CL$', COP: 'CO$', PEN: 'S/ ', UYU: '$U ', VES: 'Bs. ', BOB: 'Bs. ', PYG: '₲ ', GYD: 'GY$',
  // Europe
  EUR: '€', GBP: '£', CHF: 'CHF ', SEK: 'kr ', NOK: 'kr ', DKK: 'kr ',
  PLN: 'zł ', CZK: 'Kč ', HUF: 'Ft ', RON: 'lei ', BGN: 'лв ', HRK: 'kn ',
  RSD: 'din ', UAH: '₴', RUB: '₽', TRY: '₺', ISK: 'kr ', BAM: 'KM ',
  ALL: 'L ', MKD: 'den ', GEL: '₾', AMD: '֏ ', AZN: '₼', MDL: 'L ',
  // Asia-Pacific
  JPY: '¥', CNY: '¥', HKD: 'HK$', TWD: 'NT$', KRW: '₩', SGD: 'S$',
  INR: '₹', PKR: '₨ ', BDT: '৳ ', LKR: 'Rs ', NPR: 'Rs ', BTN: 'Nu ',
  IDR: 'Rp ', MYR: 'RM ', THB: '฿', PHP: '₱', VND: '₫', MMK: 'K ',
  KHR: '៛ ', LAK: '₭ ', BND: 'B$', MOP: 'MOP$', MNT: '₮ ',
  AUD: 'A$', NZD: 'NZ$', FJD: 'FJ$', PGK: 'K ', WST: 'WS$',
  KZT: '₸ ', UZS: 'so\'m ', KGS: 'с ', TJS: 'SM ', TMT: 'T ',
  // Middle East
  AED: 'AED ', SAR: 'SAR ', QAR: 'QAR ', KWD: 'KWD ', BHD: 'BD ',
  OMR: 'OMR ', JOD: 'JD ', ILS: '₪', IRR: '﷼ ', IQD: 'IQD ', SYP: 'SP ',
  LBP: 'LL ', YER: 'YR ',
  // Africa
  ZAR: 'R ', NGN: '₦', KES: 'KSh ', GHS: 'GH₵ ', EGP: 'E£ ', MAD: 'MAD ',
  TND: 'DT ', DZD: 'DA ', ETB: 'Br ', UGX: 'USh ', TZS: 'TSh ', XOF: 'CFA ',
  XAF: 'FCFA ', MUR: 'Rs ', RWF: 'RF ', ZMW: 'ZK ', BWP: 'P ', NAD: 'N$',
  MZN: 'MT ', AOA: 'Kz ', CDF: 'FC ', MGA: 'Ar ',
};

function currencySymbol(currency: string): string {
  return CURRENCY_SYMBOLS[currency?.toUpperCase()] ?? `${currency} `;
}

function formatCurrency(val: number | null | undefined, currency = 'USD'): string {
  if (val == null) return 'N/A';
  const sym = currencySymbol(currency);
  const abs = Math.abs(val);
  const sign = val < 0 ? '-' : '';
  if (abs >= 1e12) return `${sign}${sym}${(abs / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${sign}${sym}${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}${sym}${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}${sym}${(abs / 1e3).toFixed(1)}K`;
  return `${sign}${sym}${abs.toFixed(0)}`;
}

function calcYoY(current: number | null | undefined, previous: number | null | undefined): string | undefined {
  if (current == null || previous == null || previous === 0) return undefined;
  const pct = ((current - previous) / Math.abs(previous)) * 100;
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
}

// ── FMP types ─────────────────────────────────────────────────────────────────

interface FMPIncomeStatement {
  date: string; fiscalYear: string; reportedCurrency: string;
  revenue: number; costOfRevenue: number; grossProfit: number;
  researchAndDevelopmentExpenses: number;
  sellingGeneralAndAdministrativeExpenses: number;
  operatingExpenses: number; operatingIncome: number;
  ebitda: number; netIncome: number; eps: number; epsDiluted: number;
  incomeBeforeTax: number; incomeTaxExpense: number;
  depreciationAndAmortization: number;
  [key: string]: unknown;
}

interface FMPBalanceSheet {
  date: string; fiscalYear: string; reportedCurrency: string;
  cashAndCashEquivalents: number; shortTermInvestments: number;
  cashAndShortTermInvestments: number; netReceivables: number;
  inventory: number; totalCurrentAssets: number;
  propertyPlantEquipmentNet: number; goodwill: number;
  intangibleAssets: number; totalAssets: number;
  accountPayables: number; shortTermDebt: number;
  totalCurrentLiabilities: number; longTermDebt: number;
  totalLiabilities: number; totalStockholdersEquity: number;
  totalLiabilitiesAndTotalEquity: number;
  retainedEarnings: number; commonStock: number;
  [key: string]: unknown;
}

interface FMPCashFlow {
  date: string; fiscalYear: string; reportedCurrency: string;
  netIncome: number; depreciationAndAmortization: number;
  stockBasedCompensation: number; changeInWorkingCapital: number;
  netCashProvidedByOperatingActivities: number;
  investmentsInPropertyPlantAndEquipment: number;
  netCashProvidedByInvestingActivities: number;
  commonStockRepurchased: number; commonDividendsPaid: number;
  netCashProvidedByFinancingActivities: number;
  operatingCashFlow: number; capitalExpenditure: number;
  freeCashFlow: number; netChangeInCash: number;
  [key: string]: unknown;
}

interface FMPProfile {
  symbol: string; companyName: string; currency: string;
  exchange: string; exchangeFullName: string;
  marketCap: number; price: number; beta: number;
  range: string; lastDividend: number; averageVolume: number;
  ceo: string; sector: string; industry: string;
  website: string; description: string; country: string;
  fullTimeEmployees: string; ipoDate: string;
  [key: string]: unknown;
}

interface FMPSearchResult {
  symbol: string; name: string; currency: string;
  exchange: string; exchangeFullName: string;
}

// ── Global Exchange Extensions Mapping ────────────────────────────────────────
/**
 * Map of stock exchanges with their ticker extensions
 * Used to search FMP with multiple exchange variants when a ticker is identified
 */
const EXCHANGE_EXTENSIONS = [
  // United States (no extension)
  { country: 'United States', exchange: 'NASDAQ / NYSE / AMEX', extension: '', example: 'AAPL' },
  // Canada
  { country: 'Canada', exchange: 'TSX', extension: '.TO', example: 'T.TO' },
  { country: 'Canada', exchange: 'TSXV', extension: '.V', example: 'CVE.V' },
  // Europe
  { country: 'United Kingdom', exchange: 'LSE', extension: '.L', example: 'BP.L' },
  { country: 'Germany', exchange: 'XETRA', extension: '.DE', example: 'SAP.DE' },
  { country: 'France', exchange: 'Euronext Paris', extension: '.PA', example: 'MC.PA' },
  { country: 'Netherlands', exchange: 'Euronext Amsterdam', extension: '.AS', example: 'ASML.AS' },
  { country: 'Switzerland', exchange: 'SIX Swiss Exchange', extension: '.SW', example: 'NESN.SW' },
  // Asia Pacific
  { country: 'Hong Kong', exchange: 'HKEX', extension: '.HK', example: '0700.HK' },
  { country: 'Japan', exchange: 'TSE', extension: '.T', example: '7203.T' },
  { country: 'Australia', exchange: 'ASX', extension: '.AX', example: 'BHP.AX' },
  { country: 'India', exchange: 'NSE', extension: '.NS', example: 'RELIANCE.NS' },
  { country: 'India', exchange: 'BSE', extension: '.BO', example: '500325.BO' },
  // China
  { country: 'China', exchange: 'Shanghai Stock Exchange', extension: '.SS', example: '600519.SS' },
  { country: 'China', exchange: 'Shenzhen Stock Exchange', extension: '.SZ', example: '000001.SZ' },
  // LATAM
  { country: 'Brazil', exchange: 'B3 (Bovespa)', extension: '.SA', example: 'PETR4.SA' },
  { country: 'Mexico', exchange: 'Bolsa Mexicana de Valores (BMV)', extension: '.MX', example: 'AMXL.MX' },
  { country: 'Colombia', exchange: 'Bolsa de Valores de Colombia (BVC)', extension: '.CL', example: 'ECOPETROL.CL' },
  { country: 'Chile', exchange: 'Bolsa de Santiago', extension: '.SN', example: 'FALABELLA.SN' },
  { country: 'Argentina', exchange: 'Bolsa de Comercio de Buenos Aires (BCBA)', extension: '.BA', example: 'YPF.BA' },
  { country: 'Peru', exchange: 'Bolsa de Valores de Lima (BVL)', extension: '.LM', example: 'BVN.LM' },
];

// ── Ticker search via FMP ─────────────────────────────────────────────────────

// Returns true if query looks like an acronym (2-6 uppercase letters, no spaces)
function isAcronym(q: string): boolean {
  return /^[A-Z]{2,6}$/.test(q.trim());
}

// Check if query is an acronym formed from the initials of the result name
// e.g. "TCS" matches "Tata Consultancy Services" (T+C+S)
function acronymMatchesName(query: string, name: string): boolean {
  const q = query.toUpperCase().trim();
  const words = name.trim().split(/\s+/).filter((w) => /[A-Za-z]/.test(w[0]));
  const initials = words.map((w) => w[0].toUpperCase()).join('');
  // full initials match
  if (initials === q) return true;
  // prefix match (e.g. "HCL" from "HCL Technologies Ltd")
  if (initials.startsWith(q) && q.length >= 2) return true;
  return false;
}

// Score how well a search result name matches the query (0–1)
function nameMatchScore(query: string, resultName: string): number {
  const q = query.toLowerCase().trim();
  const n = resultName.toLowerCase().trim();
  if (n === q) return 1.0;
  if (n.startsWith(q) || n.includes(q)) return 0.8;
  // Acronym detection: "TCS" → "Tata Consultancy Services"
  if (isAcronym(query) && acronymMatchesName(query, resultName)) return 0.85;
  // Check if all words of the query appear in the result name
  const qWords = q.split(/\s+/).filter((w) => w.length > 2);
  const matchedWords = qWords.filter((w) => n.includes(w));
  return qWords.length > 0 ? matchedWords.length / qWords.length : 0;
}

export async function fmpSearchTicker(companyName: string): Promise<string | null> {
  try {
    const results = await fmpFetch<FMPSearchResult[]>(
      `/search-name?query=${encodeURIComponent(companyName)}&limit=20`
    );
    if (!results || results.length === 0) return null;

    // Score each result: name similarity is primary signal.
    // Exchange preference is a tiebreaker only — strong name match wins regardless of exchange.
    const MAJOR_EXCHANGES = [
      // Global majors
      'NASDAQ', 'NYSE', 'AMEX', 'LSE', 'NSE', 'BSE', 'TSX', 'XETRA', 'TSE', 'HKEX', 'ASX',
      // LATAM
      'B3', 'BOVESPA', 'BMV', 'BVC', 'BOLSA DE SANTIAGO', 'BCBA', 'BVL',
    ];
    const scored = results.map((r) => {
      const nameSc = nameMatchScore(companyName, r.name);
      const exchIdx = MAJOR_EXCHANGES.findIndex((e) => r.exchange.includes(e) || r.exchangeFullName?.includes(e));
      // Exchange is a small tiebreaker (max 0.5), name match dominates (max 8.5)
      const exchSc = exchIdx >= 0 ? (MAJOR_EXCHANGES.length - exchIdx) / (MAJOR_EXCHANGES.length * 2) : 0;
      return { r, nameSc, score: nameSc * 8.5 + exchSc };
    });

    scored.sort((a, b) => b.score - a.score);
    const best = scored[0];

    // Reject if name similarity is too low (< 0.35) — likely a wrong company
    if (best.nameSc < 0.35) {
      console.warn('[FMP] Best match has low name similarity:', best.r.name, 'for query:', companyName);
      return null;
    }

    console.log('[FMP] Ticker identified:', best.r.symbol, `(${best.r.name})`, 'score:', best.score.toFixed(2), 'for:', companyName);
    return best.r.symbol;
  } catch (err) {
    console.warn('[FMP] Ticker search failed:', err);
    return null;
  }
}

// Domain-based ticker lookup — most precise when user provides company website
export async function fmpSearchByDomain(domain: string): Promise<string | null> {
  try {
    // Normalise: strip protocol, www, trailing slashes
    const cleanDomain = domain.replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0].toLowerCase();
    const results = await fmpFetch<FMPProfile[]>(`/v4/company/profile?url=${encodeURIComponent(cleanDomain)}`);
    if (!results || results.length === 0) return null;
    const hit = results[0];
    console.log('[FMP] Domain lookup found:', hit.symbol, `(${hit.companyName}) via ${cleanDomain}`);
    return hit.symbol || null;
  } catch {
    return null;
  }
}

// ── Multi-Exchange Ticker Search ───────────────────────────────────────────────
/**
 * Search FMP with ticker variants across all global exchanges
 * Returns the first variant that returns data
 */
export async function fmpSearchTickerAcrossExchanges(baseTicker: string): Promise<string | null> {
  if (!baseTicker) return null;

  console.log('[FMP] Searching for ticker across global exchanges:', baseTicker);

  // Create ticker variants with all extensions
  const tickerVariants = EXCHANGE_EXTENSIONS.map(ex => ({
    variant: ex.extension ? `${baseTicker}${ex.extension}` : baseTicker,
    country: ex.country,
    exchange: ex.exchange,
    extension: ex.extension,
  }));

  // Try each variant, return first successful match
  for (const variant of tickerVariants) {
    try {
      const profile = await fmpFetch<FMPProfile[]>(`/profile?symbol=${encodeURIComponent(variant.variant)}`);

      if (profile && profile.length > 0 && profile[0].symbol) {
        console.log('[FMP] ✓ Found ticker variant:', variant.variant,
          `(${variant.country} - ${variant.exchange})`);
        return variant.variant;
      }
    } catch (err) {
      // Try next variant silently
      console.log(`[FMP] ✗ Variant not found: ${variant.variant} - trying next...`);
    }
  }

  console.warn('[FMP] No ticker variants found across any exchange for:', baseTicker);
  return null;
}

// ── Company profile ───────────────────────────────────────────────────────────

export async function fmpFetchProfile(symbol: string): Promise<{ companyInfo: CompanyInfo; currency: string } | null> {
  try {
    const profiles = await fmpFetch<FMPProfile[]>(`/profile?symbol=${encodeURIComponent(symbol)}`);
    if (!profiles || profiles.length === 0) return null;
    const p = profiles[0];
    return {
      currency: p.currency || 'USD',
      companyInfo: {
        name: p.companyName,
        exchange: p.exchangeFullName || p.exchange,
        marketCap: p.marketCap ? formatCurrency(p.marketCap, p.currency) : undefined,
        peRatio: undefined, // not directly in profile
        dividendYield: p.lastDividend ? `${p.lastDividend.toFixed(2)}%` : undefined,
        yearRange: p.range || undefined,
        ceo: p.ceo || undefined,
        founded: p.ipoDate ? `IPO: ${p.ipoDate}` : undefined,
        headquarters: p.country || undefined,
        website: p.website || undefined,
        employees: p.fullTimeEmployees || undefined,
        about: p.description?.slice(0, 500) || undefined,
      },
    };
  } catch (err) {
    console.warn('[FMP] Profile fetch failed:', err);
    return null;
  }
}

// ── Income Statement → P&L + Revenue/Margin History ───────────────────────────

export async function fmpFetchIncomeStatement(
  symbol: string, limit = 5
): Promise<{
  plStatement: FinancialStatementRow[];
  revenueHistory: RevenueDataPoint[];
  marginHistory: MarginDataPoint[];
  currency: string;
} | null> {
  try {
    const data = await fmpFetch<FMPIncomeStatement[]>(
      `/income-statement?symbol=${encodeURIComponent(symbol)}&period=annual&limit=${limit}`
    );
    if (!data || data.length === 0) return null;

    const currency = data[0].reportedCurrency || 'USD';
    const current = data[0]; // most recent
    const prev = data.length > 1 ? data[1] : null;

    // Build P&L with current + previous year
    const plStatement: FinancialStatementRow[] = [
      { label: 'INCOME SUMMARY', value: '', isSection: true },
      { label: 'Revenue', value: formatCurrency(current.revenue, currency), previousValue: prev ? formatCurrency(prev.revenue, currency) : undefined, yoy: calcYoY(current.revenue, prev?.revenue), isBold: true },
      { label: 'Cost of Revenue', value: formatCurrency(current.costOfRevenue, currency), previousValue: prev ? formatCurrency(prev.costOfRevenue, currency) : undefined, yoy: calcYoY(current.costOfRevenue, prev?.costOfRevenue) },
      { label: 'Gross Profit', value: formatCurrency(current.grossProfit, currency), previousValue: prev ? formatCurrency(prev.grossProfit, currency) : undefined, yoy: calcYoY(current.grossProfit, prev?.grossProfit), isBold: true },
      { label: 'Gross Margin', value: current.revenue ? `${((current.grossProfit / current.revenue) * 100).toFixed(1)}%` : 'N/A', previousValue: prev?.revenue ? `${((prev.grossProfit / prev.revenue) * 100).toFixed(1)}%` : undefined },
      { label: 'OPERATING EXPENSES', value: '', isSection: true },
      { label: 'R&D Expenses', value: formatCurrency(current.researchAndDevelopmentExpenses, currency), previousValue: prev ? formatCurrency(prev.researchAndDevelopmentExpenses, currency) : undefined, yoy: calcYoY(current.researchAndDevelopmentExpenses, prev?.researchAndDevelopmentExpenses) },
      { label: 'SG&A Expenses', value: formatCurrency(current.sellingGeneralAndAdministrativeExpenses, currency), previousValue: prev ? formatCurrency(prev.sellingGeneralAndAdministrativeExpenses, currency) : undefined, yoy: calcYoY(current.sellingGeneralAndAdministrativeExpenses, prev?.sellingGeneralAndAdministrativeExpenses) },
      { label: 'Total Operating Expenses', value: formatCurrency(current.operatingExpenses, currency), previousValue: prev ? formatCurrency(prev.operatingExpenses, currency) : undefined, yoy: calcYoY(current.operatingExpenses, prev?.operatingExpenses), isBold: true },
      { label: 'Operating Income', value: formatCurrency(current.operatingIncome, currency), previousValue: prev ? formatCurrency(prev.operatingIncome, currency) : undefined, yoy: calcYoY(current.operatingIncome, prev?.operatingIncome), isBold: true },
      { label: 'Operating Margin', value: current.revenue ? `${((current.operatingIncome / current.revenue) * 100).toFixed(1)}%` : 'N/A', previousValue: prev?.revenue ? `${((prev.operatingIncome / prev.revenue) * 100).toFixed(1)}%` : undefined },
      { label: 'EBITDA', value: formatCurrency(current.ebitda, currency), previousValue: prev ? formatCurrency(prev.ebitda, currency) : undefined, yoy: calcYoY(current.ebitda, prev?.ebitda), isBold: true },
      { label: 'NET RESULTS', value: '', isSection: true },
      { label: 'Income Before Tax', value: formatCurrency(current.incomeBeforeTax, currency), previousValue: prev ? formatCurrency(prev.incomeBeforeTax, currency) : undefined, yoy: calcYoY(current.incomeBeforeTax, prev?.incomeBeforeTax) },
      { label: 'Income Tax Expense', value: formatCurrency(current.incomeTaxExpense, currency), previousValue: prev ? formatCurrency(prev.incomeTaxExpense, currency) : undefined },
      { label: 'Net Income', value: formatCurrency(current.netIncome, currency), previousValue: prev ? formatCurrency(prev.netIncome, currency) : undefined, yoy: calcYoY(current.netIncome, prev?.netIncome), isBold: true },
      { label: 'Net Profit Margin', value: current.revenue ? `${((current.netIncome / current.revenue) * 100).toFixed(1)}%` : 'N/A', previousValue: prev?.revenue ? `${((prev.netIncome / prev.revenue) * 100).toFixed(1)}%` : undefined },
      { label: 'EPS (Diluted)', value: current.epsDiluted?.toFixed(2) || 'N/A', previousValue: prev?.epsDiluted?.toFixed(2) || undefined },
    ].filter((r) => r.isSection || (r.value !== 'N/A' && r.value !== '$0.00'));

    // Build revenue history (oldest first)
    const revenueHistory: RevenueDataPoint[] = [...data].reverse().map((d, i, arr) => ({
      year: d.fiscalYear || d.date.slice(0, 4),
      revenue: d.revenue,
      revenueFormatted: formatCurrency(d.revenue, currency),
      yoyGrowth: i > 0 && arr[i - 1].revenue ? ((d.revenue - arr[i - 1].revenue) / Math.abs(arr[i - 1].revenue)) * 100 : undefined,
    }));

    // Build margin history (oldest first)
    const marginHistory: MarginDataPoint[] = [...data].reverse().map((d) => ({
      year: d.fiscalYear || d.date.slice(0, 4),
      netMargin: d.revenue ? parseFloat(((d.netIncome / d.revenue) * 100).toFixed(1)) : 0,
      operatingMargin: d.revenue ? parseFloat(((d.operatingIncome / d.revenue) * 100).toFixed(1)) : 0,
    }));

    return { plStatement, revenueHistory, marginHistory, currency };
  } catch (err) {
    console.warn('[FMP] Income statement fetch failed:', err);
    return null;
  }
}

// ── Balance Sheet ─────────────────────────────────────────────────────────────

export async function fmpFetchBalanceSheet(
  symbol: string, currency = ''
): Promise<FinancialStatementRow[] | null> {
  try {
    const data = await fmpFetch<FMPBalanceSheet[]>(
      `/balance-sheet-statement?symbol=${encodeURIComponent(symbol)}&period=annual&limit=2`
    );
    if (!data || data.length === 0) return null;

    const cur = data[0];
    const prev = data.length > 1 ? data[1] : null;
    const c = currency || cur.reportedCurrency || 'USD';

    return [
      { label: 'ASSETS', value: '', isSection: true },
      { label: 'Cash & Cash Equivalents', value: formatCurrency(cur.cashAndCashEquivalents, c), previousValue: prev ? formatCurrency(prev.cashAndCashEquivalents, c) : undefined, yoy: calcYoY(cur.cashAndCashEquivalents, prev?.cashAndCashEquivalents) },
      { label: 'Short-Term Investments', value: formatCurrency(cur.shortTermInvestments, c), previousValue: prev ? formatCurrency(prev.shortTermInvestments, c) : undefined, yoy: calcYoY(cur.shortTermInvestments, prev?.shortTermInvestments) },
      { label: 'Net Receivables', value: formatCurrency(cur.netReceivables, c), previousValue: prev ? formatCurrency(prev.netReceivables, c) : undefined, yoy: calcYoY(cur.netReceivables, prev?.netReceivables) },
      { label: 'Inventory', value: formatCurrency(cur.inventory, c), previousValue: prev ? formatCurrency(prev.inventory, c) : undefined, yoy: calcYoY(cur.inventory, prev?.inventory) },
      { label: 'Total Current Assets', value: formatCurrency(cur.totalCurrentAssets, c), previousValue: prev ? formatCurrency(prev.totalCurrentAssets, c) : undefined, yoy: calcYoY(cur.totalCurrentAssets, prev?.totalCurrentAssets), isBold: true },
      { label: 'Property, Plant & Equipment', value: formatCurrency(cur.propertyPlantEquipmentNet, c), previousValue: prev ? formatCurrency(prev.propertyPlantEquipmentNet, c) : undefined, yoy: calcYoY(cur.propertyPlantEquipmentNet, prev?.propertyPlantEquipmentNet) },
      { label: 'Goodwill', value: formatCurrency(cur.goodwill, c), previousValue: prev ? formatCurrency(prev.goodwill, c) : undefined, yoy: calcYoY(cur.goodwill, prev?.goodwill) },
      { label: 'Total Assets', value: formatCurrency(cur.totalAssets, c), previousValue: prev ? formatCurrency(prev.totalAssets, c) : undefined, yoy: calcYoY(cur.totalAssets, prev?.totalAssets), isBold: true },
      { label: 'LIABILITIES', value: '', isSection: true },
      { label: 'Accounts Payable', value: formatCurrency(cur.accountPayables, c), previousValue: prev ? formatCurrency(prev.accountPayables, c) : undefined, yoy: calcYoY(cur.accountPayables, prev?.accountPayables) },
      { label: 'Short-Term Debt', value: formatCurrency(cur.shortTermDebt, c), previousValue: prev ? formatCurrency(prev.shortTermDebt, c) : undefined, yoy: calcYoY(cur.shortTermDebt, prev?.shortTermDebt) },
      { label: 'Total Current Liabilities', value: formatCurrency(cur.totalCurrentLiabilities, c), previousValue: prev ? formatCurrency(prev.totalCurrentLiabilities, c) : undefined, yoy: calcYoY(cur.totalCurrentLiabilities, prev?.totalCurrentLiabilities), isBold: true },
      { label: 'Long-Term Debt', value: formatCurrency(cur.longTermDebt, c), previousValue: prev ? formatCurrency(prev.longTermDebt, c) : undefined, yoy: calcYoY(cur.longTermDebt, prev?.longTermDebt) },
      { label: 'Total Liabilities', value: formatCurrency(cur.totalLiabilities, c), previousValue: prev ? formatCurrency(prev.totalLiabilities, c) : undefined, yoy: calcYoY(cur.totalLiabilities, prev?.totalLiabilities), isBold: true },
      { label: 'EQUITY', value: '', isSection: true },
      { label: 'Retained Earnings', value: formatCurrency(cur.retainedEarnings, c), previousValue: prev ? formatCurrency(prev.retainedEarnings, c) : undefined, yoy: calcYoY(cur.retainedEarnings, prev?.retainedEarnings) },
      { label: 'Total Stockholders Equity', value: formatCurrency(cur.totalStockholdersEquity, c), previousValue: prev ? formatCurrency(prev.totalStockholdersEquity, c) : undefined, yoy: calcYoY(cur.totalStockholdersEquity, prev?.totalStockholdersEquity), isBold: true },
      { label: 'Total Liabilities & Equity', value: formatCurrency(cur.totalLiabilitiesAndTotalEquity, c), previousValue: prev ? formatCurrency(prev.totalLiabilitiesAndTotalEquity, c) : undefined, yoy: calcYoY(cur.totalLiabilitiesAndTotalEquity, prev?.totalLiabilitiesAndTotalEquity), isBold: true },
    ].filter((r) => r.isSection || (r.value !== 'N/A' && !r.value?.match(/^-?[^\d]*0(\.00)?$/)));
  } catch (err) {
    console.warn('[FMP] Balance sheet fetch failed:', err);
    return null;
  }
}

// ── Cash Flow Statement ───────────────────────────────────────────────────────

export async function fmpFetchCashFlow(
  symbol: string, currency = ''
): Promise<FinancialStatementRow[] | null> {
  try {
    const data = await fmpFetch<FMPCashFlow[]>(
      `/cash-flow-statement?symbol=${encodeURIComponent(symbol)}&period=annual&limit=2`
    );
    if (!data || data.length === 0) return null;

    const cur = data[0];
    const prev = data.length > 1 ? data[1] : null;
    const c = currency || cur.reportedCurrency || 'USD';

    return [
      { label: 'OPERATING ACTIVITIES', value: '', isSection: true },
      { label: 'Net Income', value: formatCurrency(cur.netIncome, c), previousValue: prev ? formatCurrency(prev.netIncome, c) : undefined, yoy: calcYoY(cur.netIncome, prev?.netIncome) },
      { label: 'Depreciation & Amortization', value: formatCurrency(cur.depreciationAndAmortization, c), previousValue: prev ? formatCurrency(prev.depreciationAndAmortization, c) : undefined, yoy: calcYoY(cur.depreciationAndAmortization, prev?.depreciationAndAmortization) },
      { label: 'Stock-Based Compensation', value: formatCurrency(cur.stockBasedCompensation, c), previousValue: prev ? formatCurrency(prev.stockBasedCompensation, c) : undefined, yoy: calcYoY(cur.stockBasedCompensation, prev?.stockBasedCompensation) },
      { label: 'Change in Working Capital', value: formatCurrency(cur.changeInWorkingCapital, c), previousValue: prev ? formatCurrency(prev.changeInWorkingCapital, c) : undefined },
      { label: 'Operating Cash Flow', value: formatCurrency(cur.operatingCashFlow, c), previousValue: prev ? formatCurrency(prev.operatingCashFlow, c) : undefined, yoy: calcYoY(cur.operatingCashFlow, prev?.operatingCashFlow), isBold: true },
      { label: 'INVESTING ACTIVITIES', value: '', isSection: true },
      { label: 'Capital Expenditure', value: formatCurrency(cur.capitalExpenditure, c), previousValue: prev ? formatCurrency(prev.capitalExpenditure, c) : undefined, yoy: calcYoY(Math.abs(cur.capitalExpenditure), prev ? Math.abs(prev.capitalExpenditure) : null) },
      { label: 'Net Cash from Investing', value: formatCurrency(cur.netCashProvidedByInvestingActivities, c), previousValue: prev ? formatCurrency(prev.netCashProvidedByInvestingActivities, c) : undefined, isBold: true },
      { label: 'FINANCING ACTIVITIES', value: '', isSection: true },
      { label: 'Share Buybacks', value: formatCurrency(cur.commonStockRepurchased, c), previousValue: prev ? formatCurrency(prev.commonStockRepurchased, c) : undefined },
      { label: 'Dividends Paid', value: formatCurrency(cur.commonDividendsPaid, c), previousValue: prev ? formatCurrency(prev.commonDividendsPaid, c) : undefined },
      { label: 'Net Cash from Financing', value: formatCurrency(cur.netCashProvidedByFinancingActivities, c), previousValue: prev ? formatCurrency(prev.netCashProvidedByFinancingActivities, c) : undefined, isBold: true },
      { label: 'SUMMARY', value: '', isSection: true },
      { label: 'Free Cash Flow', value: formatCurrency(cur.freeCashFlow, c), previousValue: prev ? formatCurrency(prev.freeCashFlow, c) : undefined, yoy: calcYoY(cur.freeCashFlow, prev?.freeCashFlow), isBold: true },
      { label: 'Net Change in Cash', value: formatCurrency(cur.netChangeInCash, c), previousValue: prev ? formatCurrency(prev.netChangeInCash, c) : undefined, isBold: true },
    ].filter((r) => r.isSection || (r.value !== 'N/A' && !r.value?.match(/^-?[^\d]*0(\.00)?$/)));
  } catch (err) {
    console.warn('[FMP] Cash flow fetch failed:', err);
    return null;
  }
}

// ── Quarterly Income Statement ────────────────────────────────────────────────

export async function fmpFetchQuarterly(
  symbol: string
): Promise<{ quarterly: QuarterlyDataPoint[]; currency: string } | null> {
  try {
    const data = await fmpFetch<FMPIncomeStatement[]>(
      `/income-statement?symbol=${encodeURIComponent(symbol)}&period=quarter&limit=4`
    );
    if (!data || data.length === 0) return null;

    const currency = data[0].reportedCurrency || 'USD';
    const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

    // Reverse to chronological order (oldest first)
    const quarterly: QuarterlyDataPoint[] = [...data].reverse().map((d) => {
      const dt = new Date(d.date);
      const month = MONTHS[dt.getMonth()] || 'N/A';
      const year = dt.getFullYear().toString();
      return {
        period: `${month} ${year}`,
        revenue: d.revenue,
        revenueFormatted: formatCurrency(d.revenue, currency),
        netIncome: d.netIncome,
        netProfitMargin: d.revenue ? parseFloat(((d.netIncome / d.revenue) * 100).toFixed(1)) : undefined,
        earningsPerShare: d.epsDiluted?.toFixed(2) || undefined,
      };
    });

    return { quarterly, currency };
  } catch (err) {
    console.warn('[FMP] Quarterly fetch failed:', err);
    return null;
  }
}

// ── Revenue by Segment ──────────────────────────────────────────────────────────
// Note: FMP may not have segment data for all companies; fallback to null

interface FMPSegmentRevenue {
  date?: string;
  reportedCurrency?: string;
  segment?: string;
  revenue?: number;
  percentage?: number;
  [key: string]: unknown;
}

export async function fmpFetchSegmentRevenue(
  symbol: string, currency = ''
): Promise<{ data: any; parsed: { segment: string; revenue: string; percentage: number; yoyGrowth?: string }[] | null; currency: string } | null> {
  try {
    // Try primary endpoint: /revenue-breakdown (includes segment data)
    // This is the most common FMP endpoint for business segment breakdown
    let endpoint = `/revenue-breakdown?symbol=${encodeURIComponent(symbol)}`;
    let data: any = null;
    try {
      data = await fmpFetch<FMPSegmentRevenue[]>(endpoint);
    } catch (e) {
      console.log('[FMP] revenue-breakdown endpoint not available, trying alternate');
      // Fallback to alternate endpoint
      endpoint = `/income-statement-by-segment?symbol=${encodeURIComponent(symbol)}&period=annual&limit=1`;
      data = await fmpFetch<FMPSegmentRevenue[]>(endpoint);
    }

    if (!data || data.length === 0) {
      console.log('[FMP] No segment revenue data available for:', symbol, '— this is normal for many companies');
      return null;
    }

    // Resolve currency from data if not explicitly provided
    const resolvedCurrency = currency || data[0]?.reportedCurrency || 'USD';

    // Parse segment data into structured format
    const parsed = data
      .filter((seg: any) => seg.segment && seg.revenue)
      .map((seg: any) => ({
        segment: seg.segment || 'Unknown',
        revenue: formatCurrency(seg.revenue, resolvedCurrency),
        percentage: typeof seg.percentage === 'number' ? seg.percentage : 0,
        yoyGrowth: undefined,
      }));

    console.log('[FMP] Segment revenue data retrieved for', symbol, ':', data.length, 'records');
    return { data, parsed: parsed.length > 0 ? parsed : null, currency: resolvedCurrency };
  } catch (err) {
    console.warn('[FMP] Segment revenue fetch failed (expected for many companies):', symbol, '—', err instanceof Error ? err.message : err);
    return null;
  }
}

// ── Revenue by Geography ────────────────────────────────────────────────────────
// Note: FMP may not have geographic data for all companies; fallback to null

interface FMPGeographicRevenue {
  date?: string;
  reportedCurrency?: string;
  country?: string;
  continent?: string;
  revenue?: number;
  percentage?: number;
  [key: string]: unknown;
}

export async function fmpFetchGeographicRevenue(
  symbol: string, currency = ''
): Promise<{ data: any; parsed: { region: string; revenue: string; percentage: number; yoyGrowth?: string }[] | null; currency: string } | null> {
  try {
    // Try primary endpoint: /revenue-by-geography (includes geographic breakdown)
    // This is the most common FMP endpoint for geographic revenue breakdown
    let endpoint = `/revenue-by-geography?symbol=${encodeURIComponent(symbol)}`;
    let data: any = null;
    try {
      data = await fmpFetch<FMPGeographicRevenue[]>(endpoint);
    } catch (e) {
      console.log('[FMP] revenue-by-geography endpoint not available, trying alternate');
      // Fallback to alternate endpoint
      endpoint = `/income-statement-by-country?symbol=${encodeURIComponent(symbol)}&period=annual&limit=1`;
      data = await fmpFetch<FMPGeographicRevenue[]>(endpoint);
    }

    if (!data || data.length === 0) {
      console.log('[FMP] No geographic revenue data available for:', symbol, '— this is normal for many companies');
      return null;
    }

    // Resolve currency from data if not explicitly provided
    const resolvedCurrency = currency || data[0]?.reportedCurrency || 'USD';

    // Parse geographic data into structured format
    const parsed = data
      .filter((geo: any) => (geo.country || geo.continent || geo.region) && geo.revenue)
      .map((geo: any) => ({
        region: geo.country || geo.continent || geo.region || 'Unknown',
        revenue: formatCurrency(geo.revenue, resolvedCurrency),
        percentage: typeof geo.percentage === 'number' ? geo.percentage : 0,
        yoyGrowth: undefined,
      }));

    console.log('[FMP] Geographic revenue data retrieved for', symbol, ':', data.length, 'records');
    return { data, parsed: parsed.length > 0 ? parsed : null, currency: resolvedCurrency };
  } catch (err) {
    console.warn('[FMP] Geographic revenue fetch failed (expected for many companies):', symbol, '—', err instanceof Error ? err.message : err);
    return null;
  }
}
