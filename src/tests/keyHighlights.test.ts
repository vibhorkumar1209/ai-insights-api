import { toBulletArray } from '../services/claudeAI';

// The Financial Analysis "keyHighlights" sections came back in two JSON shapes
// for the same field: an array of bullets (Format 1, the one to keep) or one
// newline-joined string (Format 2). Fixtures below are taken from a real pair
// of responses for the same company.

describe('toBulletArray', () => {
  it('turns a Format 2 newline string into a Format 1 array', () => {
    const format2 = '• Recovery hinges on carrier capex re-acceleration\n• Cloud Software and Services growth seen as the key catalyst\n• Network API monetization is an emerging growth vector';
    expect(toBulletArray(format2)).toEqual([
      '• Recovery hinges on carrier capex re-acceleration',
      '• Cloud Software and Services growth seen as the key catalyst',
      '• Network API monetization is an emerging growth vector',
    ]);
  });

  it('leaves a Format 1 array exactly as it was', () => {
    const format1 = [
      '• Revenue decline is decelerating, from -5.9% in 2024 to -4.5% in 2025',
      '• Cloud Software and Services stabilization at +0.1% growth',
    ];
    expect(toBulletArray(format1)).toEqual(format1);
  });

  it('adds the bullet prefix when the model omitted it', () => {
    expect(toBulletArray(['Margins expanding', 'Debt falling'])).toEqual(['• Margins expanding', '• Debt falling']);
  });

  it('normalises other bullet markers to the one Format 1 uses', () => {
    expect(toBulletArray('- one\n* two\n1. three\n2) four\n– five')).toEqual(['• one', '• two', '• three', '• four', '• five']);
  });

  it('does not double a bullet that is already there', () => {
    expect(toBulletArray(['• already bulleted'])).toEqual(['• already bulleted']);
  });

  it('drops blank lines and non-string items', () => {
    expect(toBulletArray('• a\n\n   \n• b')).toEqual(['• a', '• b']);
    expect(toBulletArray(['• a', null, 5, '', '• b'])).toEqual(['• a', '• b']);
  });

  it('keeps a negative number at the start of a bullet intact', () => {
    // A leading "-" is stripped as a bullet marker only when followed by a space.
    expect(toBulletArray(['-4.5% revenue decline'])).toEqual(['• -4.5% revenue decline']);
  });

  it('returns an empty array for missing input, never a string', () => {
    for (const v of [undefined, null, '', {}, 42]) expect(toBulletArray(v)).toEqual([]);
  });
});

import { parseJsonRepairingQuotes } from '../services/claudeAI';

// Ericsson's financial analysis fell back to templated boilerplate because the
// model wrote unescaped quotes inside a string — `The "Other" category` — and
// the whole 13,176-character response failed to parse at one character.
describe('parseJsonRepairingQuotes', () => {
  it('recovers the exact production failure', () => {
    const broken = '{"segmentInsight": "Down 15% to SEK 16.0B. The "Other" category, at 16% of sales, also declined 5%.", "geoInsight": "ok"}';
    expect(() => JSON.parse(broken)).toThrow();
    expect(parseJsonRepairingQuotes(broken)).toEqual({
      segmentInsight: 'Down 15% to SEK 16.0B. The "Other" category, at 16% of sales, also declined 5%.',
      geoInsight: 'ok',
    });
  });

  it('repairs several quoted words in one response', () => {
    const broken = '{"a": "the "Networks" and "Enterprise" segments", "b": ["x "y" z"]}';
    expect(parseJsonRepairingQuotes(broken)).toEqual({ a: 'the "Networks" and "Enterprise" segments', b: ['x "y" z'] });
  });

  it('returns valid JSON unchanged', () => {
    const ok = '{"a": "already \\"escaped\\" fine", "n": -4.5}';
    expect(parseJsonRepairingQuotes(ok)).toEqual(JSON.parse(ok));
  });

  it('still throws on JSON that is broken in some other way', () => {
    expect(() => parseJsonRepairingQuotes('{"a": 1,, "b": 2}')).toThrow();
    expect(() => parseJsonRepairingQuotes('{"a": [1, 2')).toThrow();
  });
});
