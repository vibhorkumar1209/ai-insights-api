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

// ── Caller auto-labeling ─────────────────────────────────────────────────────
// Claude (claudeCreateDirect) and Parallel.AI (runResearch) are each called
// from 30+ sites across claudeAI.ts/parallelAI.ts — threading an explicit
// `source` param through every one is the same mechanical work already done
// for Gemini, at 3x the surface area. Instead, both call sites use the
// immediate caller's function name from the stack trace as the label. Works
// for both `async function foo()` declarations and `const foo = async () =>`
// — the two patterns used throughout this codebase — verified empirically;
// V8 does not guarantee this for anonymous/inline arrow functions (e.g. ones
// passed directly to `.map()`), which will show up as "<anonymous>" instead
// of a useful label. An explicit `source` argument, when the caller supplies
// one (as Gemini's region-chunk queries do via each query's own `label`),
// always takes precedence over the auto-detected name.
export function getCallerLabel(skipFrames = 3): string {
  const stack = new Error().stack || '';
  const lines = stack.split('\n');
  const callerLine = lines[skipFrames] || lines[skipFrames - 1] || '';
  const match = callerLine.match(/at (?:async )?(\S+)/);
  return match ? match[1] : 'unknown';
}

// ── Claude (Anthropic) usage ─────────────────────────────────────────────────

export interface ClaudeUsageEntry {
  timestamp: string;
  source: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

const claudeEntries: ClaudeUsageEntry[] = [];

export function logClaudeUsage(params: {
  source: string;
  model: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  usage: any;
}): void {
  const { source, model, usage } = params;
  const entry: ClaudeUsageEntry = {
    timestamp: new Date().toISOString(),
    source,
    model,
    inputTokens: Number(usage?.input_tokens) || 0,
    outputTokens: Number(usage?.output_tokens) || 0,
    cacheCreationInputTokens: Number(usage?.cache_creation_input_tokens) || 0,
    cacheReadInputTokens: Number(usage?.cache_read_input_tokens) || 0,
  };
  claudeEntries.push(entry);
  if (claudeEntries.length > MAX_ENTRIES) claudeEntries.shift();
  console.log('[claude-usage]', JSON.stringify(entry));
}

export function getClaudeUsageEntries(): ClaudeUsageEntry[] {
  return claudeEntries;
}

export interface ClaudeUsageSummary {
  source: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

export function getClaudeUsageSummary(): ClaudeUsageSummary[] {
  const bySource = new Map<string, ClaudeUsageSummary>();
  for (const e of claudeEntries) {
    const existing = bySource.get(e.source) || {
      source: e.source,
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    };
    existing.calls += 1;
    existing.inputTokens += e.inputTokens;
    existing.outputTokens += e.outputTokens;
    existing.cacheCreationInputTokens += e.cacheCreationInputTokens;
    existing.cacheReadInputTokens += e.cacheReadInputTokens;
    bySource.set(e.source, existing);
  }
  return Array.from(bySource.values()).sort((a, b) => b.outputTokens - a.outputTokens);
}

// ── Parallel.AI usage ─────────────────────────────────────────────────────────
// Parallel bills per successfully-completed task run (flat rate by processor
// tier), not per token — there is no token count to log. What's worth
// capturing empirically instead of assuming from static code: how many task
// runs actually fire per module (conditional fallbacks like
// runResearchWithGoogleFallback mean the real count varies per report) and
// whether each one succeeded (failed runs aren't billed, per Parallel's docs).

export interface ParallelUsageEntry {
  timestamp: string;
  source: string;
  processor: string;
  success: boolean;
  durationMs: number;
}

const parallelEntries: ParallelUsageEntry[] = [];

export function logParallelUsage(params: {
  source: string;
  processor: string;
  success: boolean;
  durationMs: number;
}): void {
  const entry: ParallelUsageEntry = { timestamp: new Date().toISOString(), ...params };
  parallelEntries.push(entry);
  if (parallelEntries.length > MAX_ENTRIES) parallelEntries.shift();
  console.log('[parallel-usage]', JSON.stringify(entry));
}

export function getParallelUsageEntries(): ParallelUsageEntry[] {
  return parallelEntries;
}

export interface ParallelUsageSummary {
  source: string;
  calls: number;
  billedCalls: number; // successful only — failed runs aren't billed
  failedCalls: number;
}

export function getParallelUsageSummary(): ParallelUsageSummary[] {
  const bySource = new Map<string, ParallelUsageSummary>();
  for (const e of parallelEntries) {
    const existing = bySource.get(e.source) || { source: e.source, calls: 0, billedCalls: 0, failedCalls: 0 };
    existing.calls += 1;
    if (e.success) existing.billedCalls += 1;
    else existing.failedCalls += 1;
    bySource.set(e.source, existing);
  }
  return Array.from(bySource.values()).sort((a, b) => b.billedCalls - a.billedCalls);
}
