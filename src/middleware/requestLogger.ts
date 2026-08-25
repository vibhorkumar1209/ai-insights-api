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

  console.log(`[http] → ${req.method} ${req.originalUrl} ip=${ip} ua="${ua}"${bodySummary}`);

  res.on('finish', () => {
    console.log(`[http] ← ${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - start}ms ip=${ip}`);
  });

  next();
}
