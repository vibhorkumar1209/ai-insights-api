import request from 'supertest';
import app from '../app';
import * as parallelAI from '../services/parallelAI';

jest.mock('../services/parallelAI');

const mockCompetitors = [
  { name: 'Boeing Distribution', description: 'Aerospace parts distributor', relevanceScore: 9 },
  { name: 'Satair', description: 'Airbus subsidiary, parts distribution', relevanceScore: 8 },
  { name: 'AAR Corp', description: 'Aviation services and supply chain', relevanceScore: 7 },
];

describe('POST /api/competitors', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns competitors for valid input', async () => {
    (parallelAI.discoverCompetitors as jest.Mock).mockResolvedValue(mockCompetitors);

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

  it('returns 400 when industryContext is missing', async () => {
    const res = await request(app)
      .post('/api/competitors')
      .send({ targetCompany: 'Incora' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/industryContext/);
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

  it('returns 500 when Parallel.AI throws', async () => {
    (parallelAI.discoverCompetitors as jest.Mock).mockRejectedValue(
      new Error('Parallel.AI unavailable')
    );

    const res = await request(app)
      .post('/api/competitors')
      .send({ targetCompany: 'Incora', industryContext: 'Aerospace' });

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/Parallel\.AI unavailable/);
  });
});
