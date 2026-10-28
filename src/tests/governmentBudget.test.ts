import { looksGovernmental, budgetToReport, pctChange, budgetToFirmographic } from '../services/governmentBudget';

describe('government detection pre-check', () => {
  it('flags government domains and names', () => {
    for (const [companyName, companyDomain] of [
      ['Department of Energy', 'energy.gov'],
      ['DOE', 'energy.gov'],
      ['HM Revenue & Customs', 'gov.uk'],
      ['Ministry of Electronics', 'meity.gov.in'],
      ['Some Agency', ''],
      ['City of Austin', 'austintexas.gov'],
      ['Employment and Social Development Canada', 'canada.ca'],
    ]) expect(looksGovernmental({ companyName, companyDomain })).toBe(true);
  });

  it('leaves ordinary companies alone', () => {
    for (const [companyName, companyDomain] of [
      ['Microsoft', 'microsoft.com'],
      ["The Chefs' Warehouse", 'chefswarehouse.com'],
      ['Lincoln Financial', 'lincolnfinancial.com'],
      ['Governor Software', 'governor.io'],
    ]) expect(looksGovernmental({ companyName, companyDomain })).toBe(false);
  });
});

describe('budgetToReport', () => {
  const draft = {
    fiscalYear: 'FY2026', previousFiscalYear: 'FY2025', currency: 'USD',
    totalHistory: [{ year: 'FY2025', amount: 50e9 }, { year: 'FY2024', amount: 48e9 }, { year: 'FY2026', amount: 52e9 }],
    breakdown: [
      { name: 'Office of Science', amount: 8e9, priorAmount: 8.2e9 },
      { name: 'NNSA', amount: 24e9, priorAmount: 22e9 },
      { name: 'Bad row' },
      { name: 'Defense Nuclear Nonproliferation (within NNSA)', amount: 2e9 },
    ],
    spendingType: [{ type: 'Discretionary', amount: 48e9, priorAmount: 46e9 }, { type: 'Mandatory', amount: 4e9, priorAmount: 4e9 }],
    keyHighlights: { overallPerformance: ['• up 4%'], factorsDrivingGrowth: '• NNSA\n• Science' },
    sources: ['https://www.energy.gov/budget', 'https://invented.example/x'],
  };
  const r = budgetToReport(draft, ['https://www.energy.gov/budget/']);

  it('puts budget authority by fiscal year in the revenue history, oldest first, with YoY', () => {
    expect(r.revenueHistory!.map((h) => h.year)).toEqual(['FY2024', 'FY2025', 'FY2026']);
    expect(r.revenueHistory![2].revenueFormatted).toBe('$52.00B');
    expect(r.revenueHistory![2].yoyGrowth).toBe(4);
  });

  it('puts the sub-agency breakdown in the segment table, largest first, with share and YoY', () => {
    expect(r.segmentRevenue!.map((s) => s.segment)).toEqual(['NNSA', 'Office of Science']);
    expect(r.segmentRevenue![0].percentage).toBe(75);
    expect(r.segmentRevenue![0].yoyGrowth).toBe('+9.1%');
    expect(r.segmentRevenue![1].yoyGrowth).toBe('-2.4%');
  });

  it('puts mandatory vs discretionary in the second breakdown', () => {
    expect(r.geoRevenue!.map((g) => [g.region, g.percentage])).toEqual([['Discretionary', 92.3], ['Mandatory', 7.7]]);
  });

  it('builds a budget summary comparing the two fiscal years', () => {
    const total = r.plStatement!.find((p) => p.label === 'Total Enacted Budget Authority')!;
    expect(total).toMatchObject({ value: '$52.00B', previousValue: '$50.00B', yoy: '+4.0%' });
    expect(r.plStatement![0].label).toBe('Budget Summary (FY2026 vs FY2025)');
  });

  it('marks the entity as government, normalises highlights, keeps only retrieved sources', () => {
    expect(r.entityType).toBe('government');
    expect(r.fiscalYear).toBe('FY2026');
    expect(r.keyHighlights!.factorsDrivingGrowth).toEqual(['• NNSA', '• Science']);
    expect(r.budgetSources).toEqual(['https://www.energy.gov/budget']);
  });

  it('computes percentage change safely', () => {
    expect(pctChange(110, 100)).toBe(10);
    expect(pctChange(1, 0)).toBeUndefined();
    expect(pctChange(undefined, 5)).toBeUndefined();
  });
});

describe('budgetToFirmographic', () => {
  const report = budgetToReport({
    fiscalYear: 'FY2026', currency: 'USD',
    totalHistory: [{ year: 'FY2025', amount: 50e9 }, { year: 'FY2026', amount: 52e9 }],
    breakdown: [{ name: 'NNSA', amount: 24e9, priorAmount: 22e9 }, { name: 'Science', amount: 8e9 }],
    spendingType: [{ type: 'Discretionary', amount: 48e9 }, { type: 'Mandatory', amount: 4e9 }],
  }, []);
  const f = budgetToFirmographic(report);

  it('fills the revenue fields with the enacted budget', () => {
    expect(f).toMatchObject({
      entityType: 'government', latestRevenue: '$52.00B', revenueYear: 'FY2026',
      previousRevenue: '$50.00B', previousYear: 'FY2025', yoyGrowth: 4, revenueSourceType: 'Enacted government budget',
    });
  });

  it('summarises the largest budget lines and the spending split', () => {
    expect(f.revenueDrivers).toBe('Largest budget lines (FY2026): NNSA: $24.00B (+9.1% YoY); Science: $8.00B.');
    expect(f.regionalBreakdown).toBe('Mandatory vs discretionary: Discretionary: $48.00B (92.3%); Mandatory: $4.00B (7.7%).');
  });
});
