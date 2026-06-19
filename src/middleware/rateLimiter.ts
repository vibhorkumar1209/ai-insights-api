import rateLimit from 'express-rate-limit';
import type { Request, Response, NextFunction } from 'express';

// Reject new AI jobs when heap exceeds threshold — prevents OOM crash
export function memoryGuard(_req: Request, res: Response, next: NextFunction) {
  const heapMB = process.memoryUsage().heapUsed / 1024 / 1024;
  if (heapMB > 250) {
    console.warn(`[memoryGuard] heap ${heapMB.toFixed(0)}MB — rejecting request`);
    res.status(503).json({ error: 'Server busy, please retry in 30 seconds.', retryAfter: 30 });
    return;
  }
  next();
}

const windowMs = parseInt(process.env.RATE_LIMIT_WINDOW_MS || '1800000', 10); // 30 min
const max = parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '120', 10);

export const apiLimiter = rateLimit({
  windowMs,
  max,
  standardHeaders: true,
  legacyHeaders: false,
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
  message: {
    error: 'AI analysis rate limit reached. Maximum 50 analyses per hour.',
    retryAfter: 3600,
  },
});
