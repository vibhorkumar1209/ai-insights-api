import type { Request, Response, NextFunction } from 'express';

// This app previously had no request-level logging at all — every log line
// in production was internal (usage tracking, warnings from a specific
// service call), so when an endpoint got hit far more often than expected
// (see: Business Description being called 200+ times for the same company
// within ~30 minutes) there was no way to tell whether the caller was a
// browser, a script, or an external monitor, since nothing recorded the
// request itself (method, path, IP, User-Agent). Logs every request once,
// after body parsing so POST payloads can be included — kept short and
// truncated since this runs on every request on a 512MB instance.
// GET polling of a job snapshot or SSE stream happens every few seconds per
// in-progress job — logging every one would drown out the far rarer, far
// more diagnostically useful POST-that-starts-a-job lines. Same skip
// pattern already used by apiLimiter in rateLimiter.ts.
const SKIP_PATTERN = /\/(stream|[0-9a-f-]{36})$/;

// Header values that must never be written to logs, matched by header NAME.
// Presence is still recorded (useful for attribution — e.g. knowing a call
// carried an APIM subscription key at all) but the value is redacted.
const SENSITIVE_HEADER = /(authorization|cookie|api[-_]?key|subscription[-_]?key|token|secret|password)/i;

// Headers worth capturing on job-creating POSTs to attribute a caller.
// The important one is x-forwarded-for: when a request reaches this API via
// an intermediary (e.g. the RefractOne .NET API on Azure, which calls this
// host as its configured RefractInsightApi.BaseUrl), the ORIGINAL client IP
// is often still present at the head of that chain even though req.ip only
// reflects the last hop. Without this, an upstream caller is invisible here
// and looks identical to the intermediary calling on its own initiative.
const ATTRIBUTION_HEADERS = [
  'x-forwarded-for',
  'x-real-ip',
  'x-client-ip',
  'origin',
  'referer',
  'x-request-id',
  'x-correlation-id',
];

function attributionSummary(req: Request): string {
  const parts: string[] = [];
  const seen = new Set<string>();

  for (const name of ATTRIBUTION_HEADERS) {
    const value = req.get(name);
    seen.add(name);
    if (!value) continue;
    parts.push(`${name}="${value.slice(0, 200)}"`);
  }

  // Any other x-* header — custom headers added by an intermediary or gateway
  // are exactly where a caller identity tends to hide.
  for (const [name, raw] of Object.entries(req.headers)) {
    if (!name.startsWith('x-') || seen.has(name)) continue;
    const value = Array.isArray(raw) ? raw.join(',') : String(raw ?? '');
    if (!value) continue;
    parts.push(`${name}=${SENSITIVE_HEADER.test(name) ? '<present:redacted>' : `"${value.slice(0, 200)}"`}`);
  }

  for (const name of ['authorization', 'ocp-apim-subscription-key']) {
    if (req.get(name)) parts.push(`${name}=<present:redacted>`);
  }

  return parts.length ? ` ${parts.join(' ')}` : '';
}

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  if (req.method === 'GET' && SKIP_PATTERN.test(req.path)) {
    next();
    return;
  }

  const start = Date.now();
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const ua = (req.get('user-agent') || 'unknown').slice(0, 120);

  let bodySummary = '';
  if ((req.method === 'POST' || req.method === 'PUT') && req.body && typeof req.body === 'object') {
    try {
      bodySummary = ` body=${JSON.stringify(req.body).slice(0, 300)}`;
    } catch { /* ignore */ }
  }

  // Attribution headers only on POST/PUT — the job-creating calls worth
  // tracing. GETs are high-volume polling and would just add noise.
  const attribution = (req.method === 'POST' || req.method === 'PUT') ? attributionSummary(req) : '';

  console.log(`[http] → ${req.method} ${req.originalUrl} ip=${ip} ua="${ua}"${bodySummary}${attribution}`);

  res.on('finish', () => {
    console.log(`[http] ← ${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - start}ms ip=${ip}`);
  });

  next();
}
