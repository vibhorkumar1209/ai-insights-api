import yahooFinance from 'yahoo-finance2';
import {
  RevenueDataPoint,
  MarginDataPoint,
  FinancialStatementRow,
} from '../types';

// Suppress yahoo-finance2 console warnings in production
try {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (yahooFinance as any).setGlobalConfig?.({ validation: { logOptionsErrors: false } });
} catch { /* ignore */ }

// ── Format helpers ─────────────────────────────────────────────────────────────

function formatCurrency(raw: number | undefined | null): string {
  if (raw == null || isNaN(raw)) return 'N/A';
  const abs = Math.abs(raw);
  const sign = raw < 0 ? '-' : '';
  if (abs >= 1e12) return `${sign}$${(abs / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
  return `${sign}$${raw.toLocaleString()}`;
}

function formatPct(num: number | undefined | null, denom: number | undefined | null): string {
  if (num == null || denom == null || denom === 0 || isNaN(num) || isNaN(denom)) return 'N/A';
  return `${((num / denom) * 100).toFixed(1)}%`;
}

function calcYoy(current: number | undefined | null, previous: number | undefined | null): string | undefined {
  if (current == null || previous == null || previous === 0) return undefined;
  const pct = ((current - previous) / Math.abs(previous)) * 100;
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
}

function getYear(endDate: unknown): string {
  try {
    if (endDate instanceof Date) return String(endDate.getFullYear());
    if (typeof endDate === 'object' && endDate !== null) {
      const raw = (endDate as { raw?: number; fmt?: string }).raw;
      if (raw) return String(new Date(raw * 1000).getFullYear());
    }
    return String(new Date().getFullYear());
  } catch {
    return String(new Date().getFullYear());
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rawVal(field: any): number | null {
  if (field == null) return null;
  if (typeof field === 'number') return field;
  if (typeof field === 'object' && 'raw' in field) {
    const v = (field as { raw: number }).raw;
    return typeof v === 'number' ? v : null;
  }
  return null;
}

// ── Ticker detection ───────────────────────────────────────────────────────────

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
  // Accept unknown/empty type if symbol looks like a clean ticker (1-5 uppercase letters)
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

// Run a single yahoo search query and return filtered equity results
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

// Score a quote for relevance — higher = better match
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function scoreQuote(q: any, companyName: string, domainHint: string): number {
  const qName = ((q.shortname || q.longname || '') as string).toLowerCase();
  const qSym  = ((q.symbol || '') as string).toLowerCase();
  const nameLower = companyName.toLowerCase();
  let s = 0;

  if (isUSExchangeQuote(q)) s += 15;                            // US exchange bonus

  if (qName === nameLower) s += 30;                              // exact name match
  else if (qName.startsWith(nameLower.split(' ')[0])) s += 10;  // starts with first word
  else if (qName.includes(nameLower.split(' ')[0])) s += 5;     // contains first word

  if (domainHint) {
    if (qSym === domainHint) s += 20;                            // ticker === domain root
    if (qName.includes(domainHint)) s += 10;                     // name contains domain root
  }

  return s;
}

export async function detectTicker(
  companyName: string,
  domain?: string
): Promise<{ ticker: string; exchange: string } | null> {
  const domainHint = domain ? domain.replace(/^www\./, '').split('.')[0].toLowerCase() : '';
  const words = companyName.trim().split(/\s+/);

  // Build a prioritised list of search queries to try
  const queries: string[] = [companyName];
  if (words.length > 2) queries.push(words.slice(0, 2).join(' '));
  if (words.length > 1) queries.push(words[0]);
  // If domain looks like a short ticker (≤5 chars), try it directly
  if (domainHint && domainHint.length <= 5) queries.push(domainHint.toUpperCase());

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let equities: any[] = [];

  for (const query of queries) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const found: any[] = await runSearch(query);
    if (found.length > 0) {
      equities = found;
      break; // stop at the first query that yields equity results
    }
  }
  if (equities.length === 0) return null;

  // Sort by score descending and pick the best
  equities.sort((a, b) => scoreQuote(b, companyName, domainHint) - scoreQuote(a, companyName, domainHint));

  const best = equities[0];
  const exchange: string = best.exchDisp || best.exchange || '';

  // Sanity check: if we got results but no US equity at all, accept the best global one
  return { ticker: best.symbol as string, exchange };
}

// ── Full financial data fetch ─────────────────────────────────────────────────

interface YahooFinancials {
  revenueHistory: RevenueDataPoint[];
  marginHistory: MarginDataPoint[];
  plStatement: FinancialStatementRow[];
  balanceSheet: FinancialStatementRow[];
  cashFlow: FinancialStatementRow[];
}

export async function fetchFinancials(ticker: string): Promise<YahooFinancials> {
  const summary = await yahooFinance.quoteSummary(ticker, {
    modules: [
      'incomeStatementHistory',
      'balanceSheetHistory',
      'cashflowStatementHistory',
    ],
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const incomeStmts: any[] =
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ((summary as any).incomeStatementHistory?.incomeStatementHistory || []).slice(0, 5).reverse();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bsStmts: any[] =
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ((summary as any).balanceSheetHistory?.balanceSheetStatements || []);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cfStmts: any[] =
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ((summary as any).cashflowStatementHistory?.cashflowStatements || []);

  // ── Revenue + Margin history ─────────────────────────────────────────────────
  const revenueHistory: RevenueDataPoint[] = [];
  const marginHistory: MarginDataPoint[] = [];

  incomeStmts.forEach((stmt, idx) => {
    const rev = rawVal(stmt.totalRevenue);
    const ni = rawVal(stmt.netIncomeApplicableToCommonShares ?? stmt.netIncome);
    const opInc = rawVal(stmt.operatingIncome ?? stmt.ebit);
    const year = getYear(stmt.endDate);

    if (rev != null) {
      const prevRev = idx > 0 ? rawVal(incomeStmts[idx - 1].totalRevenue) : null;
      const yoyNum = prevRev ? ((rev - prevRev) / Math.abs(prevRev)) * 100 : undefined;

      revenueHistory.push({
        year,
        revenue: rev,
        revenueFormatted: formatCurrency(rev),
        yoyGrowth: yoyNum != null ? parseFloat(yoyNum.toFixed(1)) : undefined,
      });

      marginHistory.push({
        year,
        netMargin: ni != null ? parseFloat(((ni / rev) * 100).toFixed(1)) : 0,
        operatingMargin: opInc != null ? parseFloat(((opInc / rev) * 100).toFixed(1)) : 0,
      });
    }
  });

  // ── P&L Statement (most recent year) ────────────────────────────────────────
  // incomeStmts are reversed (oldest→newest), so last element is most recent
  const currentIncome = incomeStmts[incomeStmts.length - 1];
  const prevIncome = incomeStmts.length > 1 ? incomeStmts[incomeStmts.length - 2] : null;
  const plStatement = buildPL(currentIncome, prevIncome);

  // ── Balance Sheet (most recent) ─────────────────────────────────────────────
  const balanceSheet = buildBS(bsStmts[0]);

  // ── Cash Flow (most recent) ──────────────────────────────────────────────────
  const cashFlow = buildCF(cfStmts[0], incomeStmts[incomeStmts.length - 1]);

  return { revenueHistory, marginHistory, plStatement, balanceSheet, cashFlow };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildPL(stmt: any, prev: any): FinancialStatementRow[] {
  if (!stmt) return [];
  const r = (f: string) => rawVal(stmt[f]);
  const p = (f: string) => (prev ? rawVal(prev[f]) : null);
  const rev = r('totalRevenue');

  const rows: FinancialStatementRow[] = [
    { label: 'Revenue', value: formatCurrency(rev), yoy: calcYoy(rev, p('totalRevenue')), isBold: true },
    { label: 'Cost of Revenue', value: formatCurrency(r('costOfRevenue')), yoy: calcYoy(r('costOfRevenue'), p('costOfRevenue')) },
    { label: 'Gross Profit', value: formatCurrency(r('grossProfit')), yoy: calcYoy(r('grossProfit'), p('grossProfit')), isBold: true },
    { label: 'Gross Margin', value: formatPct(r('grossProfit'), rev) },
    { label: 'OPERATING EXPENSES', value: '', isSection: true },
    { label: 'R&D Expenses', value: formatCurrency(r('researchDevelopment')), yoy: calcYoy(r('researchDevelopment'), p('researchDevelopment')) },
    { label: 'SG&A Expenses', value: formatCurrency(r('sellingGeneralAdministrative')), yoy: calcYoy(r('sellingGeneralAdministrative'), p('sellingGeneralAdministrative')) },
    { label: 'Total Operating Expenses', value: formatCurrency(r('totalOperatingExpenses')), isBold: true },
    { label: 'Operating Income (EBIT)', value: formatCurrency(r('operatingIncome') ?? r('ebit')), yoy: calcYoy(r('operatingIncome') ?? r('ebit'), p('operatingIncome') ?? p('ebit')), isBold: true },
    { label: 'Operating Margin', value: formatPct(r('operatingIncome') ?? r('ebit'), rev) },
    { label: 'BELOW THE LINE', value: '', isSection: true },
    { label: 'Interest Expense', value: formatCurrency(r('interestExpense')) },
    { label: 'Other Income / (Expense)', value: formatCurrency(r('totalOtherIncomeExpenseNet')) },
    { label: 'Income Before Tax', value: formatCurrency(r('incomeBeforeTax')), yoy: calcYoy(r('incomeBeforeTax'), p('incomeBeforeTax')), isBold: true },
    { label: 'Income Tax Expense', value: formatCurrency(r('incomeTaxExpense')) },
    { label: 'Net Income', value: formatCurrency(r('netIncomeApplicableToCommonShares') ?? r('netIncome')), yoy: calcYoy(r('netIncomeApplicableToCommonShares') ?? r('netIncome'), p('netIncomeApplicableToCommonShares') ?? p('netIncome')), isBold: true },
    { label: 'Net Margin', value: formatPct(r('netIncomeApplicableToCommonShares') ?? r('netIncome'), rev) },
  ];
  return rows.filter((row) => row.value !== 'N/A' || row.isSection || row.isBold);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildBS(stmt: any): FinancialStatementRow[] {
  if (!stmt) return [];
  const r = (f: string) => rawVal(stmt[f]);

  return [
    { label: 'ASSETS', value: '', isSection: true },
    { label: 'Cash & Equivalents', value: formatCurrency(r('cash')) },
    { label: 'Short-term Investments', value: formatCurrency(r('shortTermInvestments')) },
    { label: 'Accounts Receivable', value: formatCurrency(r('netReceivables')) },
    { label: 'Inventory', value: formatCurrency(r('inventory')) },
    { label: 'Total Current Assets', value: formatCurrency(r('totalCurrentAssets')), isBold: true },
    { label: 'Property, Plant & Equipment', value: formatCurrency(r('propertyPlantEquipment')) },
    { label: 'Long-term Investments', value: formatCurrency(r('longTermInvestments')) },
    { label: 'Total Assets', value: formatCurrency(r('totalAssets')), isBold: true },
    { label: 'LIABILITIES & EQUITY', value: '', isSection: true },
    { label: 'Accounts Payable', value: formatCurrency(r('accountsPayable')) },
    { label: 'Short-term Debt', value: formatCurrency(r('shortLongTermDebt')) },
    { label: 'Total Current Liabilities', value: formatCurrency(r('totalCurrentLiabilities')), isBold: true },
    { label: 'Long-term Debt', value: formatCurrency(r('longTermDebt')) },
    { label: 'Total Liabilities', value: formatCurrency(r('totalLiab')), isBold: true },
    { label: 'Retained Earnings', value: formatCurrency(r('retainedEarnings')) },
    { label: 'Total Stockholder Equity', value: formatCurrency(r('totalStockholderEquity')), isBold: true },
    { label: 'Total Liab. & Equity', value: formatCurrency(r('totalAssets')), isBold: true },
  ].filter((row) => row.value !== 'N/A' || row.isSection || row.isBold);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildCF(stmt: any, income: any): FinancialStatementRow[] {
  if (!stmt) return [];
  const r = (f: string) => rawVal(stmt[f]);
  const ri = (f: string) => (income ? rawVal(income[f]) : null);

  return [
    { label: 'OPERATING ACTIVITIES', value: '', isSection: true },
    { label: 'Net Income', value: formatCurrency(r('netIncome') ?? ri('netIncomeApplicableToCommonShares')) },
    { label: 'Depreciation & Amortisation', value: formatCurrency(r('depreciation')) },
    { label: 'Change in Working Capital', value: formatCurrency(r('changeToOperatingActivities')) },
    { label: 'Total Cash from Operations', value: formatCurrency(r('totalCashFromOperatingActivities')), isBold: true },
    { label: 'INVESTING ACTIVITIES', value: '', isSection: true },
    { label: 'Capital Expenditures', value: formatCurrency(r('capitalExpenditures')) },
    { label: 'Investments', value: formatCurrency(r('investments')) },
    { label: 'Total Cash from Investing', value: formatCurrency(r('totalCashflowsFromInvestingActivities')), isBold: true },
    { label: 'FINANCING ACTIVITIES', value: '', isSection: true },
    { label: 'Dividends Paid', value: formatCurrency(r('dividendsPaid')) },
    { label: 'Net Borrowings', value: formatCurrency(r('netBorrowings')) },
    { label: 'Stock Repurchases', value: formatCurrency(r('repurchaseOfStock')) },
    { label: 'Total Cash from Financing', value: formatCurrency(r('totalCashFromFinancingActivities')), isBold: true },
    { label: 'Net Change in Cash', value: formatCurrency(r('changeInCash')), isBold: true },
  ].filter((row) => row.value !== 'N/A' || row.isSection || row.isBold);
}
