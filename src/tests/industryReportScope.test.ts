import request from 'supertest';
import app from '../app';
import { segmentLabel, playerName, playerShare } from '../services/claudeAI';

// A live run of "IT and OT in the US Water Industry" completed with
// status 'complete', progress 100, sections: [] and failedSections: 12, every
// one reading "Cannot read properties of null (reading 'label')". The scope
// carried null segment entries; reading `.label` off them threw while building
// each section's prompt, so all 12 failed identically — after a full research
// pass had already been paid for — and the job still reported success.
//
// Segments are keyed by `label` and players by `name`, which is exactly the
// asymmetry an API caller trips over.

describe('scope entry accessors', () => {
  it('reads a label or name off well-formed entries', () => {
    expect(segmentLabel({ label: 'By Technology Type' })).toBe('By Technology Type');
    expect(playerName({ name: 'Xylem Inc' })).toBe('Xylem Inc');
    expect(playerShare({ name: 'Xylem Inc', marketShare: '12%' })).toBe('12%');
  });

  it('accepts the other spelling, since callers mix the two up', () => {
    expect(segmentLabel({ name: 'By Geography' })).toBe('By Geography');
    expect(playerName({ label: 'Itron Inc' })).toBe('Itron Inc');
  });

  it('accepts a bare string', () => {
    expect(segmentLabel('By Product')).toBe('By Product');
    expect(playerName('Veolia')).toBe('Veolia');
  });

  it('returns empty rather than throwing on null, undefined or shapeless input', () => {
    for (const bad of [null, undefined, {}, 42, []]) {
      expect(() => segmentLabel(bad)).not.toThrow();
      expect(() => playerName(bad)).not.toThrow();
      expect(segmentLabel(bad)).toBe('');
      expect(playerName(bad)).toBe('');
    }
    expect(playerShare(null)).toBe('N/A');
    expect(playerShare({ name: 'x' })).toBe('N/A');
  });
});

describe('POST /api/industry-report/generate scope validation', () => {
  const scope = { industry: 'Water Utilities', geography: 'United States' };

  it('rejects null segment entries instead of failing 12 minutes later', async () => {
    const res = await request(app)
      .post('/api/industry-report/generate')
      .send({ scope, selectedSegments: [null, null], selectedPlayers: [] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/selectedSegments\[0\]/);
    expect(res.body.error).toMatch(/"label"/);
  });

  it('names the offending index so the caller can find it', async () => {
    const res = await request(app)
      .post('/api/industry-report/generate')
      .send({ scope, selectedSegments: [{ label: 'ok' }, { nope: 1 }], selectedPlayers: [] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/selectedSegments\[1\]/);
  });

  it('rejects players missing a name', async () => {
    const res = await request(app)
      .post('/api/industry-report/generate')
      .send({ scope, selectedSegments: [], selectedPlayers: [{ description: 'no name' }] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/selectedPlayers\[0\]/);
    expect(res.body.error).toMatch(/"name"/);
  });

  it('rejects a non-array selection', async () => {
    const res = await request(app)
      .post('/api/industry-report/generate')
      .send({ scope, selectedSegments: 'By Technology', selectedPlayers: [] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/must be an array/);
  });

  it('still requires a scope with an industry', async () => {
    const res = await request(app).post('/api/industry-report/generate').send({ selectedSegments: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/scope with industry/);
  });
});
