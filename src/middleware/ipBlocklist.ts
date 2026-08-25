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
    .map(normalizeIp)
    .filter(Boolean);
  return new Set([...DEFAULT_BLOCKED_IPS.map(normalizeIp), ...fromEnv]);
}

const blockedIps = loadBlockedIps();

// Strips the IPv6-mapped-IPv4 prefix ("::ffff:20.204.232.87" -> "20.204.232.87")
// and any port suffix, so a blocklist entry written as a plain IPv4 string
// still matches however the runtime happens to represent it.
function normalizeIp(raw: string): string {
  return raw.trim().replace(/^::ffff:/i, '').replace(/^\[|\]$/g, '');
}

export function ipBlocklist(req: Request, res: Response, next: NextFunction): void {
  // Check EVERY IP in the forwarded chain, not just req.ip.
  //
  // The first version of this middleware compared only req.ip and silently
  // failed to block anything: app.ts sets `trust proxy` to 1 (trust a single
  // hop), but Render's edge puts more than one hop in front of the app, so
  // req.ip resolves to an intermediate proxy address rather than the real
  // client IP that Render's own access logs report. The blocked IP was
  // therefore never the value being compared, and the offending requests
  // kept sailing through with a 202 instead of a 403.
  //
  // Rather than re-tune `trust proxy` (which would change how
  // express-rate-limit keys clients app-wide — a riskier, wider blast
  // radius), match against the whole X-Forwarded-For chain plus req.ip and
  // the raw socket address. A blocked client can't avoid appearing
  // somewhere in that set.
  const forwarded = (req.get('x-forwarded-for') || '')
    .split(',')
    .map(normalizeIp)
    .filter(Boolean);

  const candidates = [
    ...forwarded,
    normalizeIp(req.ip || ''),
    normalizeIp(req.socket.remoteAddress || ''),
  ].filter(Boolean);

  const hit = candidates.find((ip) => blockedIps.has(ip));
  if (hit) {
    console.warn(`[ipBlocklist] blocked ${req.method} ${req.originalUrl} from ${hit}`);
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  next();
}
