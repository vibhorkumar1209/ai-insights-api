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

import { finalAnswerText } from '../services/claudeAI';

// The first production Biz Descrip research run returned a description that
// opened with "I have good coverage. Let me finalize the profile." — the
// model's narration between tool calls, joined in with the actual answer.
describe('finalAnswerText', () => {
  it('drops narration written between tool calls', () => {
    const content = [
      { type: 'text', text: 'Let me search for this company.' },
      { type: 'server_tool_use', name: 'web_search' },
      { type: 'web_search_tool_result', content: [] },
      { type: 'text', text: 'I have good coverage. Let me finalize the profile.' },
      { type: 'server_tool_use', name: 'web_fetch' },
      { type: 'web_fetch_tool_result', content: {} },
      { type: 'text', text: 'Acme makes widgets.' },
    ];
    expect(finalAnswerText(content)).toBe('Acme makes widgets.');
  });

  it('keeps every text block when no tools were used', () => {
    expect(finalAnswerText([{ type: 'text', text: 'One. ' }, { type: 'text', text: 'Two.' }])).toBe('One. Two.');
  });

  it('joins multiple text blocks after the last tool step', () => {
    const content = [
      { type: 'server_tool_use' }, { type: 'web_search_tool_result' },
      { type: 'text', text: 'Part one. ' }, { type: 'text', text: 'Part two.' },
    ];
    expect(finalAnswerText(content)).toBe('Part one. Part two.');
  });

  it('returns empty when the turn ended on a tool step', () => {
    expect(finalAnswerText([{ type: 'text', text: 'Searching…' }, { type: 'server_tool_use' }])).toBe('');
  });
});

import { stripLeadingNarration } from '../services/claudeAI';

describe('stripLeadingNarration', () => {
  it('removes the exact narration seen in production', () => {
    const out = stripLeadingNarration('I have good coverage. Let me finalize the profile.\n\nChicago Auto Body Parts is an Addison, Illinois based retailer.');
    expect(out).toBe('Chicago Auto Body Parts is an Addison, Illinois based retailer.');
  });

  it('removes several stacked narration paragraphs', () => {
    expect(stripLeadingNarration('Let me search.\n\nOkay, found it.\n\nAcme makes widgets.')).toBe('Acme makes widgets.');
  });

  it('never touches a real third-person profile', () => {
    const profile = 'Acme Corp makes industrial widgets.\n\nIt serves customers in the Midwest.';
    expect(stripLeadingNarration(profile)).toBe(profile);
  });

  it('keeps a long first paragraph even if it opens with "I"', () => {
    const long = 'I ' + 'word '.repeat(30) + '\n\nSecond paragraph.';
    expect(stripLeadingNarration(long)).toBe(long.trim());
  });

  it('never strips the only paragraph, so a sentinel or one-paragraph answer survives', () => {
    expect(stripLeadingNarration('No business description can be ascertained.')).toBe('No business description can be ascertained.');
  });
});
