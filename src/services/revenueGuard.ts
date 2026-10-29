import { detectTicker, fetchYahooQuoteSummaryFinancials, companyIdentityConfirmed, convertToUsd } from './yahooFinance';

// Revenue guard for the synchronous spend calculators. They take revenue on
// trust, so one bad input scales every figure: RefractOne sent Smurfit
// Westrock at $3,000M while it reports $31.18B, and IT spend came out 10x low.
//
// For a public company the guard looks up reported revenue (Yahoo Finance,
// identity checked against the requested name/domain). If the input is off by
// more than MAX_RATIO either way, the reported figure is used instead and the
// response says so. A private company, a failed lookup or a timeout leaves
// the input untouched: the guard can only correct, never block.
export const MAX_RATIO = 3;
const LOOKUP_TIMEOUT_MS = 10_000;
const CACHE_MS = 24 * 3600_000;

export interface RevenueCheck {
  status: 'confirmed' | 'corrected' | 'unverified';
  inputUsdMillion: number;
  usedUsdMillion: number;
  reportedUsdMillion?: number;
  reportedYear?: string;
  ticker?: string;
  source?: 'Yahoo Finance';
  message?: string;
}

interface Reported { usdMillion: number; year: string; ticker: string }
const cache = new Map<string, { at: number; value: Reported | null }>();

export function _resetRevenueGuardCache(): void { cache.clear(); }

async function lookup(companyName: string, companyDomain?: string): Promise<Reported | null> {
  const t = await detectTicker(companyName, companyDomain);
  if (!t) return null;
  const data = await fetchYahooQuoteSummaryFinancials(t.ticker);
  const latest = data.revenueHistory[data.revenueHistory.length - 1];
  if (!latest || !(latest.revenue > 0)) return null;
  if (data.companyInfo?.name && !companyIdentityConfirmed({
    requestedName: companyName, requestedDomain: companyDomain,
    fetchedName: data.companyInfo.name, fetchedWebsite: data.companyInfo.website,
  })) return null;
  return { usdMillion: convertToUsd(latest.revenue, data.currency) / 1e6, year: latest.year, ticker: t.ticker };
}

export async function reportedRevenue(companyName: string, companyDomain?: string): Promise<Reported | null> {
  const key = `${companyName.toLowerCase().trim()}|${companyDomain ?? ''}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = await Promise.race([
    lookup(companyName, companyDomain).catch(() => null),
    new Promise<null>((r) => setTimeout(() => r(null), LOOKUP_TIMEOUT_MS)),
  ]);
  cache.set(key, { at: Date.now(), value });
  return value;
}

export function compareRevenue(inputUsdMillion: number, reported: Reported | null): RevenueCheck {
  if (!reported) {
    return { status: 'unverified', inputUsdMillion, usedUsdMillion: inputUsdMillion, message: 'No reported revenue found to check against; input revenue used as given.' };
  }
  const base = {
    inputUsdMillion, reportedUsdMillion: Math.round(reported.usdMillion), reportedYear: reported.year,
    ticker: reported.ticker, source: 'Yahoo Finance' as const,
  };
  const ratio = inputUsdMillion / reported.usdMillion;
  if (ratio > MAX_RATIO || ratio < 1 / MAX_RATIO) {
    return {
      ...base, status: 'corrected', usedUsdMillion: Math.round(reported.usdMillion),
      message: `Input revenue $${Math.round(inputUsdMillion).toLocaleString('en-US')}M is ${ratio < 1 ? `${(1 / ratio).toFixed(1)}x below` : `${ratio.toFixed(1)}x above`} reported FY${reported.year} revenue of $${Math.round(reported.usdMillion).toLocaleString('en-US')}M (${reported.ticker}). Reported revenue used.`,
    };
  }
  return { ...base, status: 'confirmed', usedUsdMillion: inputUsdMillion };
}

export async function guardRevenue(companyName: string, inputUsdMillion: number, companyDomain?: string): Promise<RevenueCheck> {
  return compareRevenue(inputUsdMillion, await reportedRevenue(companyName, companyDomain));
}
