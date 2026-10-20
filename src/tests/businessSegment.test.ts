import { normalizeUrl, makeUrlVerifier, sanitizeDossier, sanitizeBattlecard } from '../services/businessSegmentAI';

const input = { companyName: 'Acme Holdings', companyDomain: 'acme.com', linkedinUrl: 'https://www.linkedin.com/company/acme' };

describe('URL honesty', () => {
  it('normalizes scheme, www, country linkedin hosts, query and trailing slash', () => {
    expect(normalizeUrl('HTTPS://www.Acme.com/About/?utm=1#x')).toBe('acme.com/about');
    expect(normalizeUrl('https://uk.linkedin.com/in/jane-doe/')).toBe('linkedin.com/in/jane-doe');
  });

  it('only passes URLs the tools actually returned', () => {
    const verify = makeUrlVerifier(['https://www.linkedin.com/in/jane-doe']);
    expect(verify('https://linkedin.com/in/jane-doe/')).toBe('https://linkedin.com/in/jane-doe/');
    expect(verify('https://www.linkedin.com/in/john-invented')).toBe('');
    expect(verify('')).toBe('');
    expect(verify(undefined)).toBe('');
  });
});

describe('sanitizeDossier', () => {
  const observed = ['https://acme.com/wealth', 'https://www.linkedin.com/in/jane-doe'];

  it('keeps verified links and falls back to the parent for unverified ones', () => {
    const out = sanitizeDossier({
      segments: [
        { name: 'Wealth', webpageUrl: 'https://acme.com/wealth', linkedinUrl: 'https://linkedin.com/company/acme-wealth-made-up',
          leaders: [
            { name: 'Jane Doe', title: 'CEO, Wealth', linkedinUrl: 'https://www.linkedin.com/in/jane-doe', profile: 'x' },
            { name: 'Made Up', title: 'CIO', linkedinUrl: 'https://www.linkedin.com/in/made-up', profile: 'y' },
          ] },
        { name: 'Insurance', webpageUrl: 'https://acme.com/not-seen', keyProducts: ['• Term life', 'Annuities'] },
      ],
    }, observed, input);

    expect(out[0].webpageUrl).toBe('https://acme.com/wealth');
    expect(out[0].webpageRollsUp).toBe(false);
    // Invented segment LinkedIn page is rejected, parent page used and flagged.
    expect(out[0].linkedinUrl).toBe(input.linkedinUrl);
    expect(out[0].linkedinRollsUp).toBe(true);
    expect(out[0].leaders[0].linkedinUrl).toBe('https://www.linkedin.com/in/jane-doe');
    expect(out[0].leaders[1].linkedinUrl).toBeUndefined();

    // Unseen page on the real domain is not trusted either.
    expect(out[1].webpageUrl).toBe('https://acme.com');
    expect(out[1].webpageRollsUp).toBe(true);
    expect(out[1].keyProducts).toEqual(['Term life', 'Annuities']);
    expect(out[1].contribution).toBe('Not disclosed');
  });

  it('drops segments without a name, leaders without a title, and caps leaders at 4', () => {
    const leaders = Array.from({ length: 6 }, (_, i) => ({ name: `P${i}`, title: 'VP', profile: '' }));
    const out = sanitizeDossier({ segments: [{ name: '' }, { name: 'S', leaders: [...leaders, { name: 'NoTitle' }] }] }, [], input);
    expect(out).toHaveLength(1);
    expect(out[0].leaders).toHaveLength(4);
  });

  it('returns an empty list for malformed input rather than throwing', () => {
    expect(sanitizeDossier(null, [], input)).toEqual([]);
    expect(sanitizeDossier({ segments: 'nope' }, [], input)).toEqual([]);
  });
});

describe('sanitizeBattlecard', () => {
  it('caps opportunities at 3 and drops comparison rows without a dimension', () => {
    const out = sanitizeBattlecard({
      segmentContext: 'ctx', coreWinTheme: 'win',
      opportunityAreas: ['a', 'b', 'c', 'd'],
      comparison: [{ dimension: 'Speed', yourSolution: 'fast', competitor: 'slow' }, { yourSolution: 'x' }],
    });
    expect(out.opportunityAreas).toHaveLength(3);
    expect(out.comparison).toHaveLength(1);
  });
});

describe('parseSegmentList', () => {
  const { parseSegmentList } = require('../services/businessSegmentAI');
  it('reads the trailing JSON list', () => {
    expect(parseSegmentList('notes...\nSEGMENT_LIST_JSON: ["Wealth","Insurance"]')).toEqual(['Wealth', 'Insurance']);
  });
  it('returns an empty list when absent or malformed', () => {
    expect(parseSegmentList('no list here')).toEqual([]);
    expect(parseSegmentList('SEGMENT_LIST_JSON: [oops]')).toEqual([]);
  });
});
