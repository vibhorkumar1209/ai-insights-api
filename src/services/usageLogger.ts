// Real Gemini usage logging — replaces the char-length/4 cost estimates used
// in ad-hoc cost analyses with actual `usageMetadata` figures Gemini returns
// on every response. In-memory only (same tradeoff as the job stores
// elsewhere in this codebase — wiped on redeploy), but each entry is also
// written to stdout as a single structured JSON line so it survives in
// Render's log retention even across restarts, and can be piped into any
// log aggregator later without changing this module.

export interface GeminiUsageEntry {
  timestamp: string;
  source: string; // module/function that made the call, e.g. "firmographic.revenueLookup"
  model: string;
  promptTokenCount: number;
  candidatesTokenCount: number;
  totalTokenCount: number;
  groundingUsed: boolean; // google_search tool → incurs the per-request grounding fee
}

const MAX_ENTRIES = 5000;
const entries: GeminiUsageEntry[] = [];

export function logGeminiUsage(params: {
  source: string;
  model: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  usageMetadata: any;
  groundingUsed: boolean;
}): void {
  const { source, model, usageMetadata, groundingUsed } = params;
  const entry: GeminiUsageEntry = {
    timestamp: new Date().toISOString(),
    source,
    model,
    promptTokenCount: Number(usageMetadata?.promptTokenCount) || 0,
    candidatesTokenCount: Number(usageMetadata?.candidatesTokenCount) || 0,
    totalTokenCount: Number(usageMetadata?.totalTokenCount) || 0,
    groundingUsed,
  };

  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries.shift();

  // Structured single-line log — grep-able as `[gemini-usage]` in Render logs.
  console.log('[gemini-usage]', JSON.stringify(entry));
}

export function getGeminiUsageEntries(): GeminiUsageEntry[] {
  return entries;
}

export interface GeminiUsageSummary {
  source: string;
  calls: number;
  promptTokens: number;
  candidatesTokens: number;
  totalTokens: number;
  groundedCalls: number;
}

// Aggregates logged entries by source. Cost isn't computed here — pricing
// changes independently of usage — so callers combine this with current
// per-token/per-grounded-request rates themselves.
export function getGeminiUsageSummary(): GeminiUsageSummary[] {
  const bySource = new Map<string, GeminiUsageSummary>();
  for (const e of entries) {
    const existing = bySource.get(e.source) || {
      source: e.source,
      calls: 0,
      promptTokens: 0,
      candidatesTokens: 0,
      totalTokens: 0,
      groundedCalls: 0,
    };
    existing.calls += 1;
    existing.promptTokens += e.promptTokenCount;
    existing.candidatesTokens += e.candidatesTokenCount;
    existing.totalTokens += e.totalTokenCount;
    if (e.groundingUsed) existing.groundedCalls += 1;
    bySource.set(e.source, existing);
  }
  return Array.from(bySource.values()).sort((a, b) => b.totalTokens - a.totalTokens);
}
