import request from 'supertest';
import app from '../app';

// Hitting the bare host returned {"error":"Route not found"}, which reads as a
// dead service when the API is healthy — nothing was mounted at "/". The index
// derives its module list from the router stack rather than a hand-kept array,
// so this pins that derivation actually works (a bad regex would silently
// yield an empty list, which still returns 200 and looks fine).

describe('GET /', () => {
  it('returns a service index instead of 404', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.body.service).toBe('ai-insights-api');
    expect(res.body.status).toBe('ok');
  });

  it('lists the mounted api modules', async () => {
    const res = await request(app).get('/');
    const { modules, moduleCount } = res.body;

    expect(Array.isArray(modules)).toBe(true);
    // Empty would mean the router-stack parsing broke.
    expect(modules.length).toBeGreaterThan(25);
    expect(moduleCount).toBe(modules.length);

    for (const p of ['/api/reports', '/api/industry-report', '/api/peers', '/api/biz-descrip', '/api/usage']) {
      expect(modules).toContain(p);
    }
    // Paths must be clean, with no leftover regexp escaping.
    for (const p of modules) expect(p).toMatch(/^\/api\/[a-z0-9-]+$/);
  });

  it('still 404s an unknown path', async () => {
    const res = await request(app).get('/definitely-not-a-route');
    expect(res.status).toBe(404);
  });
});
