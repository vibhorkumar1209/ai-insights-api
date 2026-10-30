import rateLimit from 'express-rate-limit';
import { timingSafeEqual } from 'crypto';
import type { Request, Response, NextFunction } from 'express';

// Reject new AI jobs when heap exceeds threshold — prevents OOM crash.
//
// The 250MB default is sized for Render's 512MB instance. It was previously
// hardcoded, which made the guard untestable: under Jest, process.memoryUsage()
// reports the test runner's heap (~375MB), not a server's, so every request in
// every route test was rejected with a 503 before reaching its handler.
// Threshold is now configurable, and the value is read per-request so tests can
// set it without depending on module import order.
const DEFAULT_MAX_HEAP_MB = 250;

function maxHeapMb(): number {
  const raw = process.env.MEMORY_GUARD_MAX_HEAP_MB;
  if (!raw) return DEFAULT_MAX_HEAP_MB;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_HEAP_MB;
}

export function memoryGuard(_req: Request, res: Response, next: NextFunction) {
  const heapMB = process.memoryUsage().heapUsed / 1024 / 1024;
  if (heapMB > maxHeapMb()) {
    console.warn(`[memoryGuard] heap ${heapMB.toFixed(0)}MB — rejecting request`);
    res.status(503).json({ error: 'Server busy, please retry in 30 seconds.', retryAfter: 30 });
    return;
  }
  next();
}

// ── Rate-limit key ───────────────────────────────────────────────────────────
// The app reaches this API through its own server (the /api/backend proxy on
// Vercel), so every app visitor arrives from Vercel's egress IPs. Keyed on
// req.ip, they would all share one bucket — 50 AI runs an hour across the whole
// app. The proxy forwards the visitor's IP as the first x-forwarded-for entry and
// proves itself with the internal token. That entry is trusted only alongside a
// valid token: an outside caller can write anything into x-forwarded-for, and
// letting it pick its own key would let it dodge the limit. The token is checked
// here rather than via isInternalRequest so a forged Origin header never earns a
// caller-chosen key, whatever the redaction layer currently accepts.
function hasInternalToken(req: Request): boolean {
  const expected = process.env.INTERNAL_API_TOKEN;
  const supplied = req.get('x-internal-token');
  if (!expected || !supplied) return false;
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function rateLimitKey(req: Request): string {
  if (hasInternalToken(req)) {
    const visitor = req.get('x-forwarded-for')?.split(',')[0]?.trim();
    if (visitor) return visitor;
  }
  return req.ip || 'unknown';
}

const windowMs = parseInt(process.env.RATE_LIMIT_WINDOW_MS || '1800000', 10); // 30 min
const max = parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '120', 10);

export const apiLimiter = rateLimit({
  windowMs,
  max,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: rateLimitKey,
  // Skip rate limiting for job status polling and SSE streams — these are
  // high-frequency reads that don't consume meaningful server resources.
  skip: (req) => req.method === 'GET' && /\/(stream|[0-9a-f-]{36})$/.test(req.path),
  message: {
    error: 'Too many requests. Please wait before trying again.',
    retryAfter: Math.ceil(windowMs / 1000),
  },
});

// Stricter limiter for expensive AI endpoints
export const aiLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 50,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: rateLimitKey,
  message: {
    error: 'AI analysis rate limit reached. Maximum 50 analyses per hour.',
    retryAfter: 3600,
  },
});
