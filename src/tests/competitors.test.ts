import request from 'supertest';
import app from '../app';
import * as parallelAI from '../services/parallelAI';
import * as claudeAI from '../services/claudeAI';

// The route grounds Claude in a live research pass first, so both services
// have to be mocked. An earlier version of this suite mocked only
// parallelAI.discoverCompetitors — a function this route no longer calls —
// which left the real Claude call in place and the test hanging on the
// route's 40s research timer until Jest gave up.
jest.mock('../services/parallelAI');
jest.mock('../services/claudeAI');

const mockCompetitors = [
  { name: 'Boeing Distribution', description: 'Aerospace parts distributor', relevanceScore: 9 },
  { name: 'Satair', description: 'Airbus subsidiary, parts distribution', relevanceScore: 8 },
  { name: 'AAR Corp', description: 'Aviation services and supply chain', relevanceScore: 7 },
];

describe('POST /api/competitors', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (parallelAI.researchCompanyOverview as jest.Mock).mockResolvedValue('research text');
    (claudeAI.discoverCompetitorsFast as jest.Mock).mockResolvedValue(mockCompetitors);
  });

  it('returns competitors for valid input', async () => {
    const res = await request(app)
      .post('/api/competitors')
      .send({ targetCompany: 'Incora', industryContext: 'Aerospace supply chain distribution' });

    expect(res.status).toBe(200);
    expect(res.body.competitors).toHaveLength(3);
    expect(res.body.competitors[0].name).toBe('Boeing Distribution');
    expect(res.body.count).toBe(3);
  });

  it('returns 400 when targetCompany is missing', async () => {
    const res = await request(app)
      .post('/api/competitors')
      .send({ industryContext: 'Aerospace' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/targetCompany/);
  });

  // industryContext used to be required. It is now deliberately optional:
  // Peer Benchmarking's setup wizard never collected it and was silently
  // 400ing on every call as a result. Missing input is auto-detected rather
  // than rejected, so this asserts the current contract.
  it('accepts a missing industryContext and reports it as auto-detected', async () => {
    const res = await request(app)
      .post('/api/competitors')
      .send({ targetCompany: 'Incora' });

    expect(res.status).toBe(200);
    expect(res.body.industryContext).toBe('(auto-detected)');
    expect(res.body.competitors).toHaveLength(3);
  });

  it('returns 400 when input is too long', async () => {
    const res = await request(app)
      .post('/api/competitors')
      .send({
        targetCompany: 'A'.repeat(201),
        industryContext: 'Aerospace',
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/too long/i);
  });

  // Research failure alone is non-fatal — the route falls back to training
  // knowledge — so a 500 requires the Claude discovery call itself to fail.
  it('returns 500 when competitor discovery throws', async () => {
    (claudeAI.discoverCompetitorsFast as jest.Mock).mockRejectedValue(
      new Error('Parallel.AI unavailable')
    );

    const res = await request(app)
      .post('/api/competitors')
      .send({ targetCompany: 'Incora', industryContext: 'Aerospace' });

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/Parallel\.AI unavailable/);
  });

  it('still returns competitors when the research pass fails', async () => {
    (parallelAI.researchCompanyOverview as jest.Mock).mockRejectedValue(new Error('research down'));

    const res = await request(app)
      .post('/api/competitors')
      .send({ targetCompany: 'Incora', industryContext: 'Aerospace' });

    expect(res.status).toBe(200);
    expect(res.body.competitors).toHaveLength(3);
  });
});
