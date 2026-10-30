import { redactForExternal, stripInlineCitations, isInternalRequest } from '../middleware/externalRedaction';
import type { Request } from 'express';

const req = (headers: Record<string, string>) => ({ get: (h: string) => headers[h.toLowerCase()] }) as unknown as Request;

describe('external redaction', () => {
  it('treats the app as internal and server callers as external', () => {
    expect(isInternalRequest(req({ origin: 'https://ai-insights-app-six.vercel.app' }))).toBe(true);
    expect(isInternalRequest(req({ referer: 'http://localhost:3000/reports' }))).toBe(true);
    expect(isInternalRequest(req({}))).toBe(false);
    expect(isInternalRequest(req({ origin: 'https://evil.vercel.app' }))).toBe(false);
  });

  it('drops source and methodology fields but keeps the output', () => {
    const out = redactForExternal({
      jobId: 'j', status: 'complete', currentStep: 'Fetching revenue from Yahoo Finance…', dataSource: 'Yahoo Finance',
      rows: [{ theme: 'Tariffs', description: 'Imports fell to 14% (SEC ARS FY2025).', source: 'https://sec.gov/x' }],
      marketSizing: { value: '$957B', methodology: 'Top-down', dataPoints: [{ source: 'a' }] },
      tactics: [{ rationale: 'Lead with cost.' }], linkedinUrl: 'https://linkedin.com/company/x',
    });
    expect(out).toEqual({
      jobId: 'j', status: 'complete', currentStep: 'Complete',
      rows: [{ theme: 'Tariffs', description: 'Imports fell to 14%.' }],
      marketSizing: { value: '$957B' },
      tactics: [{ rationale: 'Lead with cost.' }], linkedinUrl: 'https://linkedin.com/company/x',
    });
  });

  it('strips inline citations without touching ordinary parentheses', () => {
    expect(stripInlineCitations('Deal could close soon (GuruFocus, Oct 2026).')).toBe('Deal could close soon.');
    expect(stripInlineCitations('CEO said so (Steel Market Update, Jan 2025) in January.')).toBe('CEO said so in January.');
    expect(stripInlineCitations('Revenue (FY2025) rose 5% (up from 3%).')).toBe('Revenue (FY2025) rose 5% (up from 3%).');
  });

  it('removes provider names from progress text', () => {
    expect(redactForExternal({ status: 'running', currentStep: 'Researching niche industry topics via Parallel.AI…' }))
      .toEqual({ status: 'running', currentStep: 'Researching niche industry topics…' });
    expect(redactForExternal({ status: 'error', error: 'Anthropic API 529: overloaded' }))
      .toEqual({ status: 'error', error: 'The request could not be completed. Start a new request.' });
  });
});

describe('redactSseChunk', () => {
  it('redacts the JSON in data lines and keeps other lines', () => {
    const { redactSseChunk } = require('../middleware/externalRedaction');
    const out = redactSseChunk('event: result\ndata: {"jobId":"j1","sources":["x"],"summary":"Up (SEC 10-K FY2025)."}\n\n');
    expect(out).toBe('event: result\ndata: {"jobId":"j1","summary":"Up."}\n\n');
    expect(redactSseChunk(': keepalive\n\n')).toBe(': keepalive\n\n');
  });

  it('hides pattern-matched fields, source columns and spend model buckets', () => {
    const out = redactForExternal({
      scope: { industry: 'Retail', searchQueries: ['q'] }, rankingSourceUrl: 'https://x', revenueSourceType: 'Filing',
      table: { title: 'Deals', headers: ['Deal', 'Value', 'Source'], rows: [['A', '$1B', 'Reuters, 2025']] },
      itSpend: { region: 'EU', total: 5 }, geo: [{ region: 'Europe', share: 30 }],
    });
    expect(out).toEqual({
      scope: { industry: 'Retail' },
      table: { title: 'Deals', headers: ['Deal', 'Value'], rows: [['A', '$1B']] },
      itSpend: { total: 5 }, geo: [{ region: 'Europe', share: 30 }],
    });
  });
});

describe('hasMcpKey', () => {
  const { hasMcpKey } = require('../middleware/externalRedaction');
  const req = (h: Record<string, string>) => ({ get: (n: string) => h[n.toLowerCase()] }) as any;
  it('accepts listed keys via x-api-key or Bearer, rejects others', () => {
    process.env.MCP_API_KEYS = 'k1, k2';
    expect(hasMcpKey(req({ 'x-api-key': 'k2' }))).toBe(true);
    expect(hasMcpKey(req({ authorization: 'Bearer k1' }))).toBe(true);
    expect(hasMcpKey(req({ 'x-api-key': 'bad' }))).toBe(false);
    expect(hasMcpKey(req({}))).toBe(false);
    delete process.env.MCP_API_KEYS;
  });
});
