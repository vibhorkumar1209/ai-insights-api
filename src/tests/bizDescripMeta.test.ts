import { stripLeadingNarration, stripBizDescripMeta } from '../services/claudeAI';

// The model sometimes reports its own self-check ahead of the profile. That
// text was being published as part of the business description.
describe('biz descrip meta stripping', () => {
  const profile = 'Acme Corp makes industrial pumps for water utilities across North America. It was founded in 1985.';

  it('removes the word count line and "Here is the profile:" lead', () => {
    const raw = `Word count is 180, within the 100-200 limit. Here is the profile:\n\n${profile}`;
    expect(stripLeadingNarration(raw)).toBe(profile);
  });

  it('handles the lead on a single line with the profile', () => {
    expect(stripBizDescripMeta(`Here is the profile: ${profile}`)).toBe(profile);
  });

  it('removes a trailing word count note', () => {
    expect(stripBizDescripMeta(`${profile}\n\n(Word count: 142)`)).toBe(profile);
    expect(stripBizDescripMeta(`${profile} (142 words)`)).toBe(profile);
  });

  it('leaves a clean profile untouched', () => {
    expect(stripLeadingNarration(profile)).toBe(profile);
  });

  it('does not strip prose that merely mentions words', () => {
    const t = 'Acme publishes a dictionary of 90,000 words. It serves schools.';
    expect(stripLeadingNarration(t)).toBe(t);
  });
});
