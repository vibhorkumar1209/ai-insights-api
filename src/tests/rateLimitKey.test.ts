// The app's Vercel proxy forwards every visitor from Vercel's egress IPs, so the
// limiters must key token-carrying requests on the visitor IP the proxy forwards —
// and must never let an outside caller choose its own key.
import type { Request } from 'express';
import { rateLimitKey } from '../middleware/rateLimiter';

const TOKEN = 'test-internal-token-0123456789';

function req(headers: Record<string, string>, ip = '10.0.0.9'): Request {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { ip, get: (name: string) => lower[name.toLowerCase()] } as unknown as Request;
}

describe('rateLimitKey', () => {
  const saved = process.env.INTERNAL_API_TOKEN;
  beforeEach(() => { process.env.INTERNAL_API_TOKEN = TOKEN; });
  afterAll(() => { process.env.INTERNAL_API_TOKEN = saved; });

  it('keys an app request on the visitor IP the proxy forwards', () => {
    const r = req({ 'x-internal-token': TOKEN, 'x-forwarded-for': '203.0.113.7, 76.76.21.9' });
    expect(rateLimitKey(r)).toBe('203.0.113.7');
  });

  it('gives two visitors behind the same proxy IP separate buckets', () => {
    const a = req({ 'x-internal-token': TOKEN, 'x-forwarded-for': '203.0.113.7' }, '76.76.21.9');
    const b = req({ 'x-internal-token': TOKEN, 'x-forwarded-for': '198.51.100.4' }, '76.76.21.9');
    expect(rateLimitKey(a)).not.toBe(rateLimitKey(b));
  });

  it('ignores x-forwarded-for from a caller without the token', () => {
    const r = req({ 'x-forwarded-for': '1.2.3.4' }, '10.0.0.9');
    expect(rateLimitKey(r)).toBe('10.0.0.9');
  });

  it('ignores a wrong token, including one of the same length', () => {
    const wrong = TOKEN.replace(/.$/, 'X');
    const r = req({ 'x-internal-token': wrong, 'x-forwarded-for': '1.2.3.4' }, '10.0.0.9');
    expect(rateLimitKey(r)).toBe('10.0.0.9');
  });

  it('does not trust a forged app Origin', () => {
    const r = req({ origin: 'https://ai-insights-app-six.vercel.app', 'x-forwarded-for': '1.2.3.4' }, '10.0.0.9');
    expect(rateLimitKey(r)).toBe('10.0.0.9');
  });

  it('falls back to req.ip when no token is configured on the server', () => {
    delete process.env.INTERNAL_API_TOKEN;
    const r = req({ 'x-internal-token': TOKEN, 'x-forwarded-for': '1.2.3.4' }, '10.0.0.9');
    expect(rateLimitKey(r)).toBe('10.0.0.9');
  });
});
