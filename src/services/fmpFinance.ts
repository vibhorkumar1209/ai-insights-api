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

async function fmpFetch<T>(path: string): Promise<T> {
  const url = `${FMP_BASE}${path}${path.includes('?') ? '&' : '?'}apikey=${FMP_API_KEY}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal as never });
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

// ── Format helpers ────────────────────────────────────────────────────────────

function formatCurrency(val: number | null | undefined, currency = 'USD'): string {
  if (val == null) return 'N/A';
  const sym = currency === 'GBP' ? '£' : currency === 'EUR' ? '€' : '$';
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

// ── Ticker search via FMP ─────────────────────────────────────────────────────

export async function fmpSearchTicker(companyName: string): Promise<string | null> {
  try {
    const results = await fmpFetch<FMPSearchResult[]>(
      `/search-name?query=${encodeURIComponent(companyName)}&limit=10`
    );
    if (!results || results.length === 0) return null;

    // Prefer US exchanges, then major global ones
    const preferred = ['NASDAQ', 'NYSE', 'AMEX', 'XETRA', 'LSE', 'TSX'];
    const sorted = [...results].sort((a, b) => {
      const aIdx = preferred.findIndex((e) => a.exchange.includes(e) || a.exchangeFullName.includes(e));
      const bIdx = preferred.findIndex((e) => b.exchange.includes(e) || b.exchangeFullName.includes(e));
      const aPri = aIdx >= 0 ? aIdx : 99;
      const bPri = bIdx >= 0 ? bIdx : 99;
      return aPri - bPri;
    });

    // Pick first USD exchange match, else first preferred, else first result
    const usdMatch = sorted.find((r) => r.currency === 'USD');
    return (usdMatch || sorted[0]).symbol;
  } catch (err) {
    console.warn('[FMP] Ticker search failed:', err);
    return null;
  }
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
  symbol: string, currency = 'USD'
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
    ].filter((r) => r.isSection || (r.value !== 'N/A' && r.value !== '$0.00' && r.value !== '$0'));
  } catch (err) {
    console.warn('[FMP] Balance sheet fetch failed:', err);
    return null;
  }
}

// ── Cash Flow Statement ───────────────────────────────────────────────────────

export async function fmpFetchCashFlow(
  symbol: string, currency = 'USD'
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
    ].filter((r) => r.isSection || (r.value !== 'N/A' && r.value !== '$0.00' && r.value !== '$0'));
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
