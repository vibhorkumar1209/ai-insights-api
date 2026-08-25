import type { Request, Response, NextFunction } from 'express';

// General-purpose IP blocklist, driven entirely by the BLOCKED_IPS env var
// (comma-separated) so IPs can be added or removed without a code change or
// redeploy. No IPs are blocked by default.
//
// This previously hardcoded 20.204.232.87, which had been sending POSTs to
// /api/business-description every ~60s with an empty User-Agent. That block
// was removed at the owner's direction — the traffic is expected, not
// hostile. Repeat-submission cost is instead absorbed by the dedupe window
// in jobDedupe.ts (10 minutes for this route, see businessDescription.ts):
// identical repeat requests return the in-flight job's id rather than
// starting fresh Claude/Parallel/Gemini work, so the AI spend is capped
// regardless of how often the endpoint is called.
//
// Kept in place (rather than deleted) because it sits above body parsing in
// the middleware chain — express.json() runs before apiLimiter/aiLimiter, so
// a request that errors during parsing never reaches either limiter. If an
// IP ever does need blocking, BLOCKED_IPS is the fastest lever.
const DEFAULT_BLOCKED_IPS: string[] = [];

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
