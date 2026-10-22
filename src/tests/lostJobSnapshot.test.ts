import express from 'express';
import request from 'supertest';
import { lostJobSnapshot, LOST_JOB_MESSAGE } from '../middleware/lostJobSnapshot';
import { archiveCompletedReport } from '../services/reportRegistry';

// RefractOne's .NET client throws on a 404 from a status endpoint and re-polls
// forever. A lost job must come back as a terminal state instead.
function app() {
  const a = express();
  a.use(lostJobSnapshot);
  a.get('/api/biz-descrip/:jobId', (req, res) => {
    if (req.params.jobId === '11111111-1111-1111-1111-111111111111') { res.json({ jobId: req.params.jobId, status: 'complete' }); return; }
    res.status(404).json({ error: 'Job not found' });
  });
  a.get('/api/biz-descrip/:jobId/stream', (_req, res) => { res.status(404).json({ error: 'Job not found' }); });
  return a;
}

const LOST = '22222222-2222-2222-2222-222222222222';

describe('lostJobSnapshot', () => {
  it('turns a lost job into a terminal error state with 200', async () => {
    const r = await request(app()).get(`/api/biz-descrip/${LOST}`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ jobId: LOST, status: 'error', progress: 0, error: LOST_JOB_MESSAGE });
  });

  it('serves an archived copy of a finished job', async () => {
    const id = '33333333-3333-3333-3333-333333333333';
    archiveCompletedReport({ moduleType: 'biz-descrip', jobId: id, label: 'Acme', createdAt: new Date().toISOString() }, { jobId: id, status: 'complete', description: 'x' }, new Date().toISOString());
    const r = await request(app()).get(`/api/biz-descrip/${id}`);
    expect(r.status).toBe(200);
    expect(r.body.description).toBe('x');
  });

  it('leaves live jobs and other paths alone', async () => {
    expect((await request(app()).get('/api/biz-descrip/11111111-1111-1111-1111-111111111111')).body.status).toBe('complete');
    expect((await request(app()).get(`/api/biz-descrip/${LOST}/stream`)).status).toBe(404);
  });
});
