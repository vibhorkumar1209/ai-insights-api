import { sanitiseSourceAttribution, sanitiseCharts, coerceChartNumber } from '../services/claudeAI';

// sourceAttribution and charts were hardcoded to [] and never populated, so
// the UI's "Source Attribution" and "Visualizations" sections never rendered.
// Now that a model call fills them, these assert the shaping that keeps
// unusable model output from reaching the renderer: recharts receives `data`
// verbatim, and `confidence` indexes a fixed colour lookup.

describe('coerceChartNumber', () => {
  it('extracts a number from formatted currency and percent strings', () => {
    expect(coerceChartNumber('$47.2B')).toBe(47.2);
    expect(coerceChartNumber('12%')).toBe(12);
    expect(coerceChartNumber('1,200')).toBe(1200);
    expect(coerceChartNumber('-3.5')).toBe(-3.5);
    expect(coerceChartNumber(42)).toBe(42);
  });

  it('returns null when there is no usable figure', () => {
    expect(coerceChartNumber('not a number')).toBeNull();
    expect(coerceChartNumber(NaN)).toBeNull();
    expect(coerceChartNumber(null)).toBeNull();
    expect(coerceChartNumber(undefined)).toBeNull();
  });
});

describe('sanitiseSourceAttribution', () => {
  it('returns [] for anything that is not an array', () => {
    expect(sanitiseSourceAttribution(undefined)).toEqual([]);
    expect(sanitiseSourceAttribution({})).toEqual([]);
  });

  it('drops rows missing an insight or a firm', () => {
    const out = sanitiseSourceAttribution([
      { insight: 'Real finding', sourceFirm: 'McKinsey' },
      { insight: '   ', sourceFirm: 'BCG' },
      { sourceFirm: 'Bain' },
      { insight: 'No firm given' },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].sourceFirm).toBe('McKinsey');
  });

  it('defaults an unrecognised confidence to medium', () => {
    const out = sanitiseSourceAttribution([
      { insight: 'a', sourceFirm: 'f', confidence: 'VERY HIGH' },
      { insight: 'b', sourceFirm: 'f', confidence: 'High' },
      { insight: 'c', sourceFirm: 'f' },
    ]);
    expect(out.map((r) => r.confidence)).toEqual(['medium', 'high', 'medium']);
  });

  it('keeps only real http(s) urls', () => {
    const out = sanitiseSourceAttribution([
      { insight: 'a', sourceFirm: 'f', url: 'https://example.com/report' },
      { insight: 'b', sourceFirm: 'f', url: '/relative/path' },
      { insight: 'c', sourceFirm: 'f', url: 'javascript:alert(1)' },
    ]);
    expect(out[0].url).toBe('https://example.com/report');
    expect(out[1].url).toBeUndefined();
    expect(out[2].url).toBeUndefined();
  });

  it('fills missing report and date rather than emitting undefined cells', () => {
    const [row] = sanitiseSourceAttribution([{ insight: 'a', sourceFirm: 'f' }]);
    expect(row.report).toBe('Not specified');
    expect(row.publishedDate).toBe('Not specified');
  });
});

describe('sanitiseCharts', () => {
  const goodData = [
    { label: '2024', value: '$10B' },
    { label: '2025', value: '$12B' },
    { label: '2026', value: 15 },
  ];

  it('coerces formatted values to numbers so recharts can plot them', () => {
    const [chart] = sanitiseCharts([
      { type: 'bar', title: 'Market size', data: goodData, dataQuality: 'complete' },
    ]);
    expect(chart.data).toEqual([
      { label: '2024', value: 10 },
      { label: '2025', value: 12 },
      { label: '2026', value: 15 },
    ]);
  });

  it('drops charts with fewer than 3 usable points', () => {
    expect(
      sanitiseCharts([
        { type: 'bar', title: 'Too small', data: [{ label: 'a', value: 1 }, { label: 'b', value: 2 }] },
      ])
    ).toEqual([]);
  });

  it('drops a chart whose rows lose their numbers during coercion', () => {
    expect(
      sanitiseCharts([
        {
          type: 'bar',
          title: 'Unusable',
          data: [
            { label: 'a', value: 'n/a' },
            { label: 'b', value: 'unknown' },
            { label: 'c', value: 'TBD' },
          ],
        },
      ])
    ).toEqual([]);
  });

  it('discards charts the model marked insufficient', () => {
    expect(
      sanitiseCharts([{ type: 'bar', title: 'Guessed', data: goodData, dataQuality: 'insufficient' }])
    ).toEqual([]);
  });

  it('defaults an unknown type to bar and an unknown quality to partial', () => {
    const [chart] = sanitiseCharts([
      { type: 'pie', title: 'Odd type', data: goodData, dataQuality: 'excellent' },
    ]);
    expect(chart.type).toBe('bar');
    expect(chart.dataQuality).toBe('partial');
  });

  it('keeps table rows verbatim instead of forcing them numeric', () => {
    const rows = [
      { label: 'McKinsey', position: 'Bullish' },
      { label: 'BCG', position: 'Neutral' },
      { label: 'Bain', position: 'Cautious' },
    ];
    const [chart] = sanitiseCharts([{ type: 'table', title: 'Positions', data: rows }]);
    expect(chart.data).toEqual(rows);
  });

  it('returns [] for anything that is not an array', () => {
    expect(sanitiseCharts(undefined)).toEqual([]);
    expect(sanitiseCharts('nope')).toEqual([]);
  });
});
