import { adaptForModel, SONNET5_TOKENIZER_RATIO } from '../services/claudeAI';

// Sonnet 5 differs from Sonnet 4.6 in three ways that each break a naive
// model-string swap: it 400s on sampling params, it thinks by default (eating
// the output budget invisibly), and its tokenizer produces ~1.5x the tokens
// for the same text, so every max_tokens sized for 4.6 truncates earlier.

describe('adaptForModel', () => {
  const base = { model: 'claude-sonnet-5', max_tokens: 10000, temperature: 0.1, top_p: 0.9, top_k: 40, messages: [] };

  it('strips the sampling params Sonnet 5 rejects', () => {
    const out = adaptForModel(base) as Record<string, unknown>;
    expect(out.temperature).toBeUndefined();
    expect(out.top_p).toBeUndefined();
    expect(out.top_k).toBeUndefined();
  });

  it('disables adaptive thinking', () => {
    expect((adaptForModel(base) as Record<string, unknown>).thinking).toEqual({ type: 'disabled' });
  });

  it('scales max_tokens so the budget buys the same amount of text', () => {
    expect(adaptForModel(base).max_tokens).toBe(Math.ceil(10000 * SONNET5_TOKENIZER_RATIO));
  });

  it('never exceeds the model output ceiling', () => {
    expect(adaptForModel({ ...base, max_tokens: 60000 }).max_tokens).toBe(64000);
  });

  it('leaves other models completely untouched', () => {
    for (const model of ['claude-sonnet-4-6', 'claude-haiku-4-5-20251001']) {
      const body = { ...base, model };
      expect(adaptForModel(body)).toBe(body);
    }
  });

  it('does not invent a max_tokens when none was given', () => {
    const { max_tokens, ...noMax } = base;
    void max_tokens;
    expect('max_tokens' in (adaptForModel(noMax) as Record<string, unknown>)).toBe(false);
  });
});
