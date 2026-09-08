/**
 * Guards against hardcoded calendar years inside prompt text.
 *
 * Every module's prompts are written with whatever year happens to be current
 * at the time, and those literals then go stale silently: nothing fails, no
 * test breaks, the model just quietly keeps citing an outdated base year. This
 * has now been fixed twice (Industry Report, then a sweep across every other
 * module), which is the signal that it needs a guard rather than another fix.
 *
 * The worst instance found was a Consulting Intelligence research query asking
 * for material "from 2022-2025" — a hard cap below the current year on every
 * search that module issued, silently overriding the recency directive in the
 * same prompt.
 *
 * The check parses each file and inspects ONLY string and template literals,
 * so comments, numeric constants and dates in identifiers are all ignored by
 * construction rather than by regex heuristics. Years must be interpolated
 * (`${new Date().getFullYear()}`, `${getBaseYear()}`, …) so they track the
 * calendar. Where a fixed year is genuinely correct, add it to ALLOWED below
 * with a reason.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

const SRC = path.join(__dirname, '..');

// Directories whose string literals are not sent to a model.
const SKIP_DIRS = new Set(['tests', 'node_modules', 'dist']);

const YEAR = /\b(19|20)\d{2}\b/;

/**
 * Fixed years that are correct as written. Each entry is matched as a
 * substring of the offending literal, and must carry a reason.
 */
const ALLOWED: Array<{ fragment: string; reason: string }> = [
  { fragment: '2023-06-01', reason: 'Anthropic API version header — a pinned API version, not a date' },
  { fragment: 'claude-haiku-4-5-20251001', reason: 'Model identifier' },
  { fragment: '2022-2030', reason: 'IT/ERD spend calculator — fixed span of the underlying source dataset' },
  { fragment: '2026-07', reason: 'Provenance note naming the date a source dataset was supplied' },
  { fragment: '2026-08', reason: 'Provenance note naming the date a source dataset was supplied' },
  {
    fragment: 'The company - founded in 1968 - operates globally',
    reason: 'Punctuation example in WRITING_DIRECTIVE — illustrates dash usage, not a data year',
  },
  {
    fragment: 'write dates as "2024 to 2025" not "2024–2025"',
    reason: 'Date-formatting example — illustrates the en-dash rule, and changing the years would not change the lesson',
  },
  {
    fragment: '"revenueHistoryExtracted"',
    reason: 'Extraction schema shape — the model copies years out of the supplied Yahoo Finance data, it does not source them',
  },
  {
    fragment: 'was founded between 1700 and 1999',
    reason: 'Business Timeline milestone bucketing — a deliberately fixed historical cutoff',
  },
  {
    fragment: '"foundedYear": "year, e.g. 1981"',
    reason: 'Founding-year field example — a founding year is historical by definition',
  },
];

function isAllowed(text: string): boolean {
  return ALLOWED.some((a) => text.includes(a.fragment));
}

function collectFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) collectFiles(path.join(dir, entry.name), out);
    } else if (entry.name.endsWith('.ts')) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

interface Finding {
  file: string;
  line: number;
  text: string;
}

function findHardcodedYears(file: string): Finding[] {
  const source = fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ES2020, true);
  const findings: Finding[] = [];

  const visit = (node: ts.Node): void => {
    const isLiteral =
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node);

    if (isLiteral) {
      const text = (node as ts.LiteralLikeNode).text;
      if (YEAR.test(text) && !isAllowed(text)) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        // Report the matched year with surrounding context, not the head of
        // the literal — prompt literals run to thousands of characters and the
        // offending year is rarely near the start.
        const flat = text.replace(/\s+/g, ' ');
        const at = flat.search(YEAR);
        findings.push({
          file: path.relative(SRC, file),
          line: line + 1,
          text: `…${flat.slice(Math.max(0, at - 70), at + 70).trim()}…`,
        });
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sf);
  return findings;
}

describe('prompt recency', () => {
  it('has no hardcoded calendar years in prompt strings', () => {
    const findings = collectFiles(SRC).flatMap(findHardcodedYears);

    if (findings.length > 0) {
      const report = findings
        .map((f) => `  ${f.file}:${f.line}\n    "${f.text}"`)
        .join('\n');
      throw new Error(
        `Found ${findings.length} hardcoded year(s) in prompt strings.\n\n` +
          `${report}\n\n` +
          `Hardcoded years go stale as the calendar advances and silently ` +
          `contradict the recency directives.\n` +
          `Interpolate instead: \${new Date().getFullYear()}, \${getBaseYear()}, ` +
          `\${currentYearRangeLabel()}.\n` +
          `If a fixed year is genuinely correct, add it to ALLOWED in ${path.basename(__filename)} with a reason.`
      );
    }
  });
});
