// Repairs the most common way a model breaks otherwise-valid JSON: a double
// quote inside a string value that was never escaped, e.g.
//   "segmentInsight": "The "Other" category declined 5%"
// JSON.parse reads `"The "` as the whole string and then fails on `Other`.
// Ericsson's financial analysis hit exactly this at character 11,792 of a
// complete 13,176-character answer, and the entire response was discarded in
// favour of templated fallback text.
//
// Lives in utils so parallelAI.ts (Gemini) can use it too — parallelAI cannot
// import claudeAI.ts without a circular import.
//
// The repair follows the parser's own error: the quote just before the
// failure point is the one that ended the string too early, so it is escaped
// and parsing is retried. Each pass fixes one stray quote, so a quoted word
// (an opening and a closing quote) takes two. Bounded, and only ever runs on
// text that has already failed to parse, so valid JSON is never touched.
export function parseJsonRepairingQuotes(text: string, maxRepairs = 40): unknown {
  let candidate = text;
  for (let attempt = 0; attempt <= maxRepairs; attempt++) {
    try {
      return JSON.parse(candidate);
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      const pos = Number((msg.match(/position (\d+)/) || [])[1]);
      if (!Number.isFinite(pos) || attempt === maxRepairs) throw err;
      const quote = candidate.lastIndexOf('"', pos - 1);
      // Only a quote that is not already escaped can be the culprit.
      if (quote <= 0 || candidate[quote - 1] === '\\') throw err;
      // And only when it is the stray-quote pattern: the quote is followed
      // (after nothing but spaces) by a character that can never follow a
      // closed JSON string — anything but `,` `}` `]` `:` or another quote.
      // That covers `"Other` and also a quoted term ending a sentence,
      // `"Sales and marketing".`, which grounded answers quoting filings
      // produce (Microsoft, 2026-10-14). Without this check the repair would
      // happily "fix" JSON broken some other way (a doubled comma, a missing
      // comma, a truncated array) by escaping a legitimate quote, producing
      // different, valid-looking JSON with the wrong data — worse than
      // failing, because nothing downstream would notice.
      const next = candidate[pos] || '';
      if (!/^\s*$/.test(candidate.slice(quote + 1, pos)) || !next || /[\s,}\]:"]/.test(next)) throw err;
      candidate = `${candidate.slice(0, quote)}\\"${candidate.slice(quote + 1)}`;
    }
  }
  throw new Error('unreachable');
}
