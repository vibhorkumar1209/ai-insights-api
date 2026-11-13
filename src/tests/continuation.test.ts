import { isCreditExhausted, queueAutoContinue, checkCredits, _setCreditProbeForTests, _autoContinueQueue } from '../services/continuation';

describe('credit detection', () => {
  it('recognises provider credit errors', () => {
    expect(isCreditExhausted(new Error('Anthropic API 400: Your credit balance is too low to access the Anthropic API'))).toBe(true);
    expect(isCreditExhausted(new Error('Parallel API 402 Payment Required'))).toBe(true);
    expect(isCreditExhausted(new Error('Anthropic API 529: overloaded'))).toBe(false);
  });
});

describe('auto-continue', () => {
  it('waits while credits are out and resumes every queued report once they are back', async () => {
    const resumed: string[] = [];
    let credits = false;
    _setCreditProbeForTests(async () => { if (!credits) throw new Error('Your credit balance is too low'); });
    queueAutoContinue('m', 'a', () => resumed.push('a'));
    queueAutoContinue('m', 'b', () => resumed.push('b'));

    expect(await checkCredits()).toBe(false);
    expect(resumed).toEqual([]);

    credits = true;
    expect(await checkCredits()).toBe(true);
    expect(resumed.sort()).toEqual(['a', 'b']);
    expect(_autoContinueQueue()).toEqual([]);
  });
});
