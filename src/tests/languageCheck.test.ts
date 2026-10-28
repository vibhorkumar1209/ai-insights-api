import { cleanDeterministic, cleanPayloadDeterministic, acceptRewrite } from '../services/languageCheck';

describe('language check', () => {
  it('removes dashes but keeps number ranges', () => {
    expect(cleanDeterministic('Revenue grew — despite headwinds — by 8%')).toBe('Revenue grew, despite headwinds, by 8%');
    expect(cleanDeterministic('FY2020–2025 plan')).toBe('FY2020-2025 plan');
    expect(cleanDeterministic('data-driven teams')).toBe('data-driven teams');
  });

  it('replaces banned words and keeps grammar', () => {
    expect(cleanDeterministic('Furthermore, we delved into the landscape.')).toBe('Also, we examined the environment.');
    expect(cleanDeterministic('This underscores a vital role and fostered growth.')).toBe('This highlights a key role and built growth.');
    expect(cleanDeterministic('Navigating paramount risks')).toBe('Managing essential risks');
    expect(cleanDeterministic('Runs on Microsoft Dynamics 365 with dynamic pricing')).toBe('Runs on Microsoft Dynamics 365 with variable pricing');
  });

  it('leaves ids, links and names alone', () => {
    const out = cleanPayloadDeterministic({ jobId: 'a—b', source: 'https://x.com/a–b', description: 'Strong — growing', rows: [{ name: 'A — B', impact: 'High — rising' }] });
    expect(out).toEqual({ jobId: 'a—b', source: 'https://x.com/a–b', description: 'Strong, growing', rows: [{ name: 'A — B', impact: 'High, rising' }] });
  });

  it('rejects rewrites that drop figures or change length too much', () => {
    const orig = 'Revenue reached $4,512 million in FY2025, up 12.5% from the prior year as volumes rose.';
    expect(acceptRewrite(orig, 'Revenue hit $4,512 million in FY2025. It rose 12.5% on higher volumes.')).not.toBeNull();
    expect(acceptRewrite(orig, 'Revenue hit $4.5 billion in FY2025. It rose 12.5% on higher volumes.')).toBeNull();
    expect(acceptRewrite(orig, 'Up.')).toBeNull();
    expect(acceptRewrite(orig, 42)).toBeNull();
  });
});
