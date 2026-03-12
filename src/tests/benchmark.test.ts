import request from 'supertest';
import app from '../app';
import * as benchmarkService from '../services/benchmarkService';

jest.mock('../services/benchmarkService');

const validPayload = {
  userOrganization: 'EdgeVerve',
  targetCompany: 'Incora',
  industryContext: 'Aerospace supply chain distribution',
  selectedCompetitors: ['Boeing Distribution', 'Satair', 'AAR Corp'],
};

describe('POST /api/benchmark', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (benchmarkService.createJob as jest.Mock).mockReturnValue('test-job-id');
    (benchmarkService.runBenchmark as jest.Mock).mockResolvedValue(undefined);
  });

  it('accepts valid input and returns 202 with jobId', async () => {
    const res = await request(app).post('/api/benchmark').send(validPayload);
    expect(res.status).toBe(202);
    expect(res.body.jobId).toBe('test-job-id');
  });

  it('returns 400 when required fields are missing', async () => {
    const res = await request(app)
      .post('/api/benchmark')
      .send({ userOrganization: 'EdgeVerve' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/required/);
  });

  it('returns 400 when selectedCompetitors is empty', async () => {
    const res = await request(app)
      .post('/api/benchmark')
      .send({ ...validPayload, selectedCompetitors: [] });

    expect(res.status).toBe(400);
  });

  it('returns 400 when more than 5 competitors provided', async () => {
    const res = await request(app)
      .post('/api/benchmark')
      .send({
        ...validPayload,
        selectedCompetitors: ['A', 'B', 'C', 'D', 'E', 'F'],
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/5 competitors/);
  });

  it('starts benchmark asynchronously after accepting request', async () => {
    await request(app).post('/api/benchmark').send(validPayload);
    // runBenchmark is called async, give event loop a tick
    await new Promise((r) => setTimeout(r, 10));
    expect(benchmarkService.runBenchmark).toHaveBeenCalledWith('test-job-id', expect.objectContaining({
      userOrganization: 'EdgeVerve',
      targetCompany: 'Incora',
    }));
  });
});

describe('GET /api/benchmark/:jobId', () => {
  it('returns job when found', async () => {
    const mockJob = {
      jobId: 'test-job-id',
      status: 'researching',
      progress: 40,
      createdAt: new Date().toISOString(),
    };
    (benchmarkService.getJob as jest.Mock).mockReturnValue(mockJob);

    const res = await request(app).get('/api/benchmark/test-job-id');
    expect(res.status).toBe(200);
    expect(res.body.jobId).toBe('test-job-id');
    expect(res.body.status).toBe('researching');
  });

  it('returns 404 when job not found', async () => {
    (benchmarkService.getJob as jest.Mock).mockReturnValue(undefined);

    const res = await request(app).get('/api/benchmark/nonexistent-id');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Job not found');
  });
});

describe('GET /api/benchmark/:jobId/stream', () => {
  it('returns 404 for unknown job', async () => {
    (benchmarkService.getJob as jest.Mock).mockReturnValue(undefined);

    const res = await request(app).get('/api/benchmark/nonexistent/stream');
    expect(res.status).toBe(404);
  });

  it('streams SSE for completed job', async () => {
    const completedJob = {
      jobId: 'done-job',
      status: 'complete',
      progress: 100,
      createdAt: new Date().toISOString(),
    };
    (benchmarkService.getJob as jest.Mock).mockReturnValue(completedJob);

    const res = await request(app).get('/api/benchmark/done-job/stream');
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    expect(res.text).toContain('event: result');
    expect(res.text).toContain('done-job');
  });
});
