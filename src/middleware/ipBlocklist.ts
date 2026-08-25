import type { Request, Response, NextFunction } from 'express';

// Confirmed via Render's HTTP access logs: 20.204.232.87 has been hammering
// POST /api/business-description continuously (dozens of requests visible
// in a single log page, most within milliseconds of each other) with an
// empty User-Agent and never once following up with a GET to poll the job
// it supposedly created — a real browser or a legitimate integration always
// sends a User-Agent and, for this endpoint, always polls for its result.
// That combination (no UA, no result retrieval, sustained high frequency)
// is a bot/scanner signature, not a misconfigured client. Blocking outright
// rather than relying on rate limiting alone: express.json() runs before
// apiLimiter/aiLimiter in the middleware chain, so a request that fails
// during body parsing never reaches either limiter — this sits above all
// of that, before any parsing or route logic runs.
//
// Configurable via BLOCKED_IPS (comma-separated) so an IP can be added or
// removed without a code change — the hardcoded default below covers the
// one already confirmed.
const DEFAULT_BLOCKED_IPS = ['20.204.232.87'];

function loadBlockedIps(): Set<string> {
  const fromEnv = (process.env.BLOCKED_IPS || '')
    .split(',')
    .map((ip) => ip.trim())
    .filter(Boolean);
  return new Set([...DEFAULT_BLOCKED_IPS, ...fromEnv]);
}

const blockedIps = loadBlockedIps();

export function ipBlocklist(req: Request, res: Response, next: NextFunction): void {
  const ip = req.ip || req.socket.remoteAddress || '';
  if (blockedIps.has(ip)) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  next();
}
