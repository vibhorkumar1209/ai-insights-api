import { compareRevenue } from '../services/revenueGuard';

const reported = { usdMillion: 31180, year: '2025', ticker: 'SW' };

describe('revenue guard', () => {
  it('replaces revenue that is far off the reported figure', () => {
    const c = compareRevenue(3000, reported);
    expect(c.status).toBe('corrected');
    expect(c.usedUsdMillion).toBe(31180);
    expect(c.message).toContain('10.4x below');
    expect(compareRevenue(400000, reported).status).toBe('corrected');
  });

  it('keeps revenue within 3x of the reported figure', () => {
    expect(compareRevenue(28000, reported)).toMatchObject({ status: 'confirmed', usedUsdMillion: 28000 });
    expect(compareRevenue(12000, reported).status).toBe('confirmed');
  });

  it('uses the input as given when nothing is reported', () => {
    expect(compareRevenue(3000, null)).toMatchObject({ status: 'unverified', usedUsdMillion: 3000 });
  });
});
