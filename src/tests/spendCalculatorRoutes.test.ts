// POST /api/spend/it and POST /api/spend/erd — the synchronous calculator routes.
// Nothing is mocked: these endpoints do no research and hit no external service, so
// the tests exercise the real table maths end-to-end through Express.
import request from 'supertest';
import app from '../app';

const AIRBUS = {
  companyName: 'Airbus',
  industry: 'Aerospace & Defence',
  geography: 'France',
  revenueUsdMillion: 73420,
};

describe('POST /api/spend/it', () => {
  it('returns the full IT payload for a valid company', async () => {
    const res = await request(app).post('/api/spend/it').send(AIRBUS);
    expect(res.status).toBe(200);
    expect(res.body.applicable).toBe(true);
    expect(res.body.revenueTier).toBe('>$5B');

    const { itSpend } = res.body;
    expect(itSpend.region).toBe('EU');
    expect(itSpend.country).toBe('France');
    expect(itSpend.companyName).toBe('Airbus');
    expect(itSpend.currencyInfo).toEqual({ currency: 'USD', revenueUSD: 73420, exchangeRateToUSD: 1 });
    expect(itSpend.trends).toHaveLength(9);
    expect(itSpend.emergingTech).toHaveLength(8);
    expect(itSpend.itBreakdown.map((n: { name: string }) => n.name)).toEqual([
      'Communications',
      'Hardware',
      'Services',
      'Software',
    ]);

    // Matches the reference output file (IT_Spend.json) for these inputs.
    const y2026 = itSpend.trends.find((t: { year: number }) => t.year === 2026);
    expect(+y2026.itSpend.toFixed(4)).toBe(2238.9429);
    expect(+y2026.itPercent.toFixed(4)).toBe(3.0495);
  });

  it('breaks the budget into 117 leaves that sum back to the headline figure', async () => {
    const res = await request(app).post('/api/spend/it').send(AIRBUS);
    const { itBreakdown } = res.body.itSpend;
    const leaves = itBreakdown.flatMap((l1: { children: { children: unknown[] }[] }) =>
      l1.children.flatMap((l2) => l2.children)
    );
    expect(leaves).toHaveLength(117);
    const total = itBreakdown.reduce((sum: number, n: { value: number }) => sum + n.value, 0);
    const y2026 = res.body.itSpend.trends.find((t: { year: number }) => t.year === 2026);
    expect(total).toBeCloseTo(y2026.itSpend, 6);
    expect(itBreakdown.reduce((sum: number, n: { percentage: number }) => sum + n.percentage, 0)).toBeCloseTo(100, 8);
  });

  it('zeroes tier-excluded line items but keeps the breakdown whole', async () => {
    const res = await request(app)
      .post('/api/spend/it')
      .send({ companyName: 'Acme SaaS', industry: 'Software', geography: 'India', revenueUsdMillion: 18 });
    expect(res.status).toBe(200);
    const { itBreakdown, emergingTech } = res.body.itSpend;
    const leaves = itBreakdown.flatMap((l1: { children: { children: { value: number }[] }[] }) =>
      l1.children.flatMap((l2) => l2.children)
    );
    expect(leaves.filter((l: { value: number }) => l.value === 0).length).toBeGreaterThan(0);
    expect(itBreakdown.reduce((sum: number, n: { percentage: number }) => sum + n.percentage, 0)).toBeCloseTo(100, 8);
    // Every emerging technology is excluded below $25M revenue.
    expect(emergingTech.every((t: { value: number }) => t.value === 0)).toBe(true);
  });

  it('defaults to the US region when HQ is omitted, without dropping the field', async () => {
    const res = await request(app)
      .post('/api/spend/it')
      .send({ companyName: 'Acme', industry: 'Retail', revenueUsdMillion: 1200 });
    expect(res.status).toBe(200);
    expect(res.body.itSpend.region).toBe('US');
    expect(res.body.itSpend.country).toBe('');
  });
});

describe('POST /api/spend/erd', () => {
  it('returns the ER&D payload for an engineering-heavy industry', async () => {
    const res = await request(app).post('/api/spend/erd').send(AIRBUS);
    expect(res.status).toBe(200);
    expect(res.body.applicable).toBe(true);

    const { erdSpend } = res.body;
    expect(erdSpend.trends).toHaveLength(9);
    const y2026 = erdSpend.trends.find((t: { year: number }) => t.year === 2026);
    expect(+y2026.erdSpend.toFixed(4)).toBe(2985.2572);
    expect(+y2026.erdPercent.toFixed(4)).toBe(4.066);

    const categories = erdSpend.erdBreakdown.flatMap((l1: { children: { children: unknown[] }[] }) =>
      l1.children.flatMap((l2) => l2.children)
    );
    expect(categories).toHaveLength(14);
    expect(
      erdSpend.erdBreakdown.reduce((sum: number, n: { value: number }) => sum + n.value, 0)
    ).toBeCloseTo(y2026.erdSpend, 6);
  });

  it('answers 200 with applicable:false for a non-ER&D industry', async () => {
    const res = await request(app)
      .post('/api/spend/erd')
      .send({ companyName: 'Zara', industry: 'Retail', geography: 'Spain', revenueUsdMillion: 38000 });
    expect(res.status).toBe(200);
    expect(res.body.applicable).toBe(false);
    expect(res.body.erdSpend).toBeUndefined();
    expect(res.body.message).toMatch(/not applicable/i);
  });
});

describe('calculator input validation', () => {
  const cases: Array<[string, Record<string, unknown>, RegExp]> = [
    ['empty body', {}, /companyName/],
    ['unknown industry', { companyName: 'Acme', industry: 'Widgets', revenueUsdMillion: 100 }, /industry/],
    ['missing revenue', { companyName: 'Acme', industry: 'Retail' }, /revenueUsdMillion/],
    ['zero revenue', { companyName: 'Acme', industry: 'Retail', revenueUsdMillion: 0 }, /revenueUsdMillion/],
    [
      'non-string geography',
      { companyName: 'Acme', industry: 'Retail', revenueUsdMillion: 100, geography: 42 },
      /geography/,
    ],
  ];

  for (const route of ['/api/spend/it', '/api/spend/erd']) {
    for (const [label, body, expected] of cases) {
      it(`rejects ${label} on POST ${route}`, async () => {
        const res = await request(app).post(route).send(body);
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(expected);
      });
    }
  }
});
