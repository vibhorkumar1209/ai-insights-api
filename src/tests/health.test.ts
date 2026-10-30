import request from 'supertest';
import app from '../app';

describe('GET /health', () => {
  it('tells outside callers only that it is up and which build', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['commit', 'status']);
    expect(res.body.status).toBe('ok');
  });

  it('gives the app the full diagnostics', async () => {
    const res = await request(app).get('/health').set('Origin', 'https://ai-insights-app-six.vercel.app');
    expect(res.body.timestamp).toBeDefined();
    expect(res.body.persistenceBackend).toBeDefined();
  });
});

describe('404 handler', () => {
  it('returns 404 for unknown routes', async () => {
    const res = await request(app).get('/unknown-route');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Route not found');
  });
});
