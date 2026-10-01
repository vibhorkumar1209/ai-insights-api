import { normalizeKeyPlayerProfiles } from '../services/claudeAI';

// The Industry Report's Key Players section emitted its profiles under
// `competitorProfiles`, so every API response called the industry's companies
// "competitors". The field is now `keyPlayerProfiles`, and the model's habit
// of returning the old name is converted rather than leaked.
describe('normalizeKeyPlayerProfiles', () => {
  const profiles = [{ name: 'Xylem Inc', hqLocation: 'US', keyProducts: 'Pumps' }];

  it('moves the legacy field to the new one and removes it', () => {
    const s: Record<string, unknown> = { id: 'key_players_analysis', competitorProfiles: profiles };
    normalizeKeyPlayerProfiles(s);
    expect(s.keyPlayerProfiles).toEqual(profiles);
    expect('competitorProfiles' in s).toBe(false);
  });

  it('keeps the new field when the model already used it', () => {
    const s: Record<string, unknown> = { keyPlayerProfiles: profiles };
    normalizeKeyPlayerProfiles(s);
    expect(s.keyPlayerProfiles).toEqual(profiles);
    expect('competitorProfiles' in s).toBe(false);
  });

  it('prefers the new field if both are present, and still drops the old one', () => {
    const newer = [{ name: 'Veolia', hqLocation: 'FR', keyProducts: 'Water services' }];
    const s: Record<string, unknown> = { keyPlayerProfiles: newer, competitorProfiles: profiles };
    normalizeKeyPlayerProfiles(s);
    expect(s.keyPlayerProfiles).toEqual(newer);
    expect('competitorProfiles' in s).toBe(false);
  });

  it('falls back to the legacy list when the new field is empty', () => {
    const s: Record<string, unknown> = { keyPlayerProfiles: [], competitorProfiles: profiles };
    normalizeKeyPlayerProfiles(s);
    expect(s.keyPlayerProfiles).toEqual(profiles);
  });

  it('leaves sections without profiles untouched', () => {
    const s = { id: 'swot', swotData: {} };
    normalizeKeyPlayerProfiles(s);
    expect(s).toEqual({ id: 'swot', swotData: {} });
  });

  it('never emits the old field name anywhere in a serialized section', () => {
    const s: Record<string, unknown> = { competitorProfiles: profiles };
    normalizeKeyPlayerProfiles(s);
    expect(JSON.stringify(s)).not.toMatch(/competitor/i);
  });
});
