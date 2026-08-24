import fetch from 'node-fetch';
import { BenchmarkDimension } from '@ai-insights/types';

const CHECK_TIMEOUT_MS = 6_000;
const MAX_CONCURRENT_CHECKS = 6;

async function fetchWithTimeout(url: string, method: 'HEAD' | 'GET', timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method,
      redirect: 'follow',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      signal: controller.signal as any,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RefractOneLinkCheck/1.0)' },
    });
  } finally {
    clearTimeout(timer);
  }
}

/** Real HTTP check — a URL only survives if it resolves to a live, non-error page. */
async function isUrlLive(url: string): Promise<boolean> {
  try {
    new URL(url); // throws on malformed URLs (Claude occasionally truncates one)
  } catch {
    return false;
  }
  try {
    // Many news/IR sites reject HEAD (405/403) — fall back to GET before giving up.
    const head = await fetchWithTimeout(url, 'HEAD', CHECK_TIMEOUT_MS);
    if (head.ok) return true;
    if (head.status !== 405 && head.status !== 403) return false;
  } catch {
    // HEAD can fail even for live URLs (some CDNs); still try GET below.
  }
  try {
    const get = await fetchWithTimeout(url, 'GET', CHECK_TIMEOUT_MS);
    return get.ok;
  } catch {
    return false;
  }
}

async function checkAllLive(urls: string[]): Promise<Map<string, boolean>> {
  const results = new Map<string, boolean>();
  const unique = Array.from(new Set(urls));
  for (let i = 0; i < unique.length; i += MAX_CONCURRENT_CHECKS) {
    const batch = unique.slice(i, i + MAX_CONCURRENT_CHECKS);
    const checked = await Promise.all(batch.map(async (u) => [u, await isUrlLive(u)] as const));
    checked.forEach(([u, ok]) => results.set(u, ok));
  }
  return results;
}

const URL_REGEX = /https?:\/\/[^\s|)"]+[^\s|).,;:"]/g;

/**
 * Strips any URL from a Claude-generated "source" string that doesn't
 * actually resolve live (dead link, 404, DNS failure, etc.) — LLM-cited
 * source URLs are frequently plausible-looking but non-existent, and the
 * UI renders these as clickable links, so an unchecked one is a broken
 * link shown to the user. Leaves non-URL text (e.g. "Company press
 * releases") untouched. Falls back to a generic label if every URL in the
 * string turns out dead.
 */
export async function filterLiveUrls(source: string | undefined, fallback = 'Company reports, press releases, and public filings'): Promise<string | undefined> {
  if (!source) return source;
  const urls = source.match(URL_REGEX) || [];
  if (urls.length === 0) return source;

  const liveness = await checkAllLive(urls);
  let cleaned = source;
  for (const url of urls) {
    if (!liveness.get(url)) {
      cleaned = cleaned.split(url).join('').trim();
    }
  }
  // Tidy up now-dangling separators/labels left behind after removing dead
  // URLs — a label like "Reuters coverage of X 2023:" with no digits-only
  // restriction, since source years/report codes (FY2024, 2023) are common
  // and the original [A-Za-z ]+ char class silently left those dangling.
  cleaned = cleaned
    .split('|')
    .map((part) => part.replace(/[^:|]*:\s*$/, '').trim())
    .filter((part) => part.length > 0)
    .join(' | ')
    .trim();

  return cleaned || fallback;
}

/**
 * Batch helper for arrays of rows that each carry a `source` field.
 * `fallback` is used only when a row's source string existed but every URL
 * in it turned out dead; pass '' for callers where "no source" should mean
 * the field disappears rather than showing generic placeholder text.
 */
export async function filterLiveUrlsOnRows<T extends { source?: string }>(
  rows: T[],
  fallback = 'Company reports, press releases, and public filings'
): Promise<T[]> {
  return Promise.all(
    rows.map(async (row) => ({ ...row, source: await filterLiveUrls(row.source, fallback) }))
  );
}

/**
 * Peer Benchmarking's Table 1 carries a source per grid cell (target company
 * column + one per peer column, for every dimension) rather than one source
 * per row — flattens all cells, live-checks each in one batched pass, then
 * reassembles the table. '' fallback: drop a cell's source entirely rather
 * than injecting placeholder text into a small table cell.
 */
export async function filterLiveUrlsOnBenchmarkTable(
  table: BenchmarkDimension[]
): Promise<BenchmarkDimension[]> {
  return Promise.all(
    table.map(async (dim) => {
      const peerNames = Object.keys(dim.peers);
      const [targetCompany, peerCells] = await Promise.all([
        (async () => ({ ...dim.targetCompany, source: await filterLiveUrls(dim.targetCompany.source, '') }))(),
        Promise.all(
          peerNames.map(async (name) => [
            name,
            { ...dim.peers[name], source: await filterLiveUrls(dim.peers[name].source, '') },
          ] as const)
        ),
      ]);
      return { ...dim, targetCompany, peers: Object.fromEntries(peerCells) };
    })
  );
}
