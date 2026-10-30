import type { Request, Response, NextFunction } from 'express';

// Outside callers (RefractOne, and through it the Claude MCP) get the output
// only: no sources, citations, methodology, model or data-provider names, and
// no access to the diagnostic endpoints. The app itself still gets the full
// payload, because its own pages show source links.
//
// "The app" means a request whose Origin or Referer is the app (browser
// fetches, and window.open of a raw report), or one carrying the
// INTERNAL_API_TOKEN header (server-side calls, ops scripts). Server-to-server
// callers send neither, so they are treated as external. Origin can be forged
// by a caller that knows to; giving RefractOne its own API key is the stronger
// follow-up if that ever matters.

const APP_HOST = /^(localhost|127\.0\.0\.1|ai-insights-app[a-z0-9-]*\.vercel\.app)$/i;
const extraOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);

function hostOf(value: string | undefined): string | null {
  if (!value) return null;
  try { return new URL(value).hostname; } catch { return null; }
}

export function isInternalRequest(req: Request): boolean {
  const token = process.env.INTERNAL_API_TOKEN;
  if (token && req.get('x-internal-token') === token) return true;
  for (const header of [req.get('origin'), req.get('referer')]) {
    const host = hostOf(header);
    if (!host) continue;
    if (APP_HOST.test(host)) return true;
    if (extraOrigins.some((o) => hostOf(o) === host)) return true;
  }
  return false;
}

// Diagnostic endpoints: request bodies, model usage, raw archives. Not for outside callers.
const INTERNAL_ONLY = [/^\/api\/usage(\/|$)/, /^\/api\/reports\/[^/]+\/raw$/, /^\/api\/reports\/archive-stats$/, /^\/api\/debug-/];

// Fields that describe how an insight was built rather than the insight
// itself. Matched by pattern, case-insensitively, so a new "fooSource" or
// "researchNotes" field is hidden by default instead of leaking.
const REDACT_KEY = /source|citation|reference|methodolog|research|evidence|debug|searchquer|disclos|footnote|assumption|reasoning|validation|^notes?$|^model$|^provider$|^dataPoints$|^revenueCheck$|^revenueTier$|^adj(Total|Pct)$|^currencyInfo$|^incumbencyNote$/i;
// Model buckets that only mean something inside the spend calculator.
const REDACT_UNDER: Record<string, Set<string>> = { itSpend: new Set(['region']), erdSpend: new Set(['region']), marketingSpend: new Set(['region']) };
// Table cells are positional, so a "Source" column is dropped by header.
const SOURCE_COLUMN = /source|citation|reference/i;

// Inline citations inside prose: "(SEC 10-K FY2025)", "(Steel Market Update, Jan 2025)", "(GuruFocus)".
const INLINE_CITATIONS: RegExp[] = [
  /\s*\((?:[^()]*\b(?:SEC|10-K|10-Q|20-F|ARS|annual report|press release|earnings call|investor presentation|transcript|filing)\b[^()]*)\)/gi,
  /\s*\(\s*[A-Z][^()]{1,80},\s*(?:(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+)?(?:Q[1-4]\s+)?(?:FY)?(?:19|20)\d{2}\s*\)/g,
  /\s*\(\s*(?:source|sources|via|per|according to)\b[^()]*\)/gi,
  /\s*\[(?:\d+(?:,\s*\d+)*)\]/g,
];

// Progress text named data providers ("from Yahoo Finance", "via Parallel.AI").
const PROVIDERS = 'Yahoo Finance|Parallel\\.AI|Gemini|Claude|Anthropic|FMP|Financial Modeling Prep|OpenAI';
const PROVIDER_WORDS = new RegExp(`\\s*\\b(?:(?:via|from|on|using|with)\\s+)?(?:${PROVIDERS})(?![\\w.])|\\s+(?:via|using|with)\\s+AI\\b`, 'g');

export function stripInlineCitations(text: string): string {
  let t = text;
  for (const re of INLINE_CITATIONS) t = t.replace(re, '');
  return t.replace(/ +([.,;:])/g, '$1').replace(/ {2,}/g, ' ');
}

function genericStep(status: unknown, step: unknown): string | undefined {
  if (typeof step !== 'string') return undefined;
  if (status === 'complete') return 'Complete';
  if (step === 'Language check') return step;
  if (/source|citation/i.test(step)) return 'Finalising…';
  const cleaned = step.replace(PROVIDER_WORDS, '').replace(/\s+([.,…])/g, '$1').trim();
  return cleaned || 'Processing';
}

function dropSourceColumns(obj: Record<string, unknown>): Record<string, unknown> {
  const { headers, rows } = obj;
  if (!Array.isArray(headers) || !Array.isArray(rows) || !headers.every((h) => typeof h === 'string')) return obj;
  const keep = headers.map((h, i) => (SOURCE_COLUMN.test(h as string) ? -1 : i)).filter((i) => i >= 0);
  if (keep.length === headers.length) return obj;
  return {
    ...obj,
    headers: keep.map((i) => headers[i]),
    rows: rows.map((r) => (Array.isArray(r) ? keep.map((i) => r[i]) : r)),
  };
}

export function redactForExternal(node: unknown, parentKey?: string): unknown {
  if (typeof node === 'string') return stripInlineCitations(node);
  if (Array.isArray(node)) return node.map((n) => redactForExternal(n, parentKey));
  if (!node || typeof node !== 'object') return node;
  const obj = dropSourceColumns(node as Record<string, unknown>);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (REDACT_KEY.test(k) || (parentKey && REDACT_UNDER[parentKey]?.has(k))) continue;
    if (k === 'currentStep') { out[k] = genericStep(obj.status, v); continue; }
    // A failed job's error can name a provider; input validation errors stay as written.
    if (k === 'error' && typeof v === 'string' && obj.status === 'error') {
      out[k] = 'The request could not be completed. Start a new request.';
      continue;
    }
    if (k === 'jobId' || k === 'id' || /url$/i.test(k) || k === 'website' || k === 'domain') { out[k] = v; continue; }
    out[k] = redactForExternal(v, k);
  }
  return out;
}

export function redactSseChunk(chunk: string): string {
  return chunk.replace(/^data: (.*)$/gm, (line, payload: string) => {
    try { return `data: ${JSON.stringify(redactForExternal(JSON.parse(payload)))}`; } catch { return line; }
  });
}

// Outside callers (MCP, scripts) need a key from MCP_API_KEYS, as x-api-key or
// a Bearer token. /health stays open for Render's checks. Unset keeps the API open.
export function hasMcpKey(req: Request): boolean {
  const keys = (process.env.MCP_API_KEYS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const sent = req.get('x-api-key') || (req.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  return keys.length > 0 && keys.includes(sent);
}

export function externalRedaction(req: Request, res: Response, next: NextFunction): void {
  if (isInternalRequest(req)) { next(); return; }
  if (req.method !== 'OPTIONS' && req.path !== '/health' && process.env.MCP_API_KEYS && !hasMcpKey(req)) {
    res.status(401).json({ error: 'Missing or invalid API key' });
    return;
  }
  if (INTERNAL_ONLY.some((re) => re.test(req.path))) {
    res.status(404).json({ error: 'Route not found' });
    return;
  }
  const originalJson = res.json.bind(res);
  // 4xx bodies explain what was wrong with the caller's own input; leave them as written.
  res.json = ((body: unknown) => originalJson(res.statusCode >= 400 ? body : redactForExternal(body))) as Response['json'];
  // SSE routes write `data: {json}` frames directly and never pass through res.json.
  const originalWrite = res.write.bind(res) as (...args: unknown[]) => boolean;
  res.write = ((chunk: unknown, ...rest: unknown[]) => {
    const type = String(res.getHeader('content-type') || '');
    if (type.includes('text/event-stream') && (typeof chunk === 'string' || Buffer.isBuffer(chunk))) {
      chunk = redactSseChunk(chunk.toString());
    }
    return originalWrite(chunk, ...rest);
  }) as Response['write'];
  next();
}
