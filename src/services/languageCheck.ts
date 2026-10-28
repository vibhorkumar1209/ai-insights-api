import { claudeCreateDirect, FAST_MODEL } from './claudeAI';

// Language check: the last step before any module's output is published.
// Every finished report passes through here (see middleware/languageCheck.ts),
// so the business writing rules hold for all modules, including ones added
// later, without touching each module's prompts.
//
// Two layers:
//   1. cleanDeterministic: removes dashes and banned phrases. Cheap, always runs,
//      on every prose string.
//   2. rewriteProse: an LLM rewrite of the longer prose strings into short,
//      direct business sentences. Any rewrite that drops a number, changes
//      length too much, or comes back malformed is discarded, so the original
//      (deterministically cleaned) text is kept instead.

// Keys whose values are identifiers, labels, enums or links, never prose.
const SKIP_KEYS = new Set([
  'id', 'jobId', 'apiJobId', 'battlecardId', 'status', 'error', 'currentStep', 'type', 'entityType', 'themeType',
  'moduleType', 'companyName', 'targetCompany', 'name', 'entityName', 'domain', 'companyDomain', 'userDomain',
  'website', 'url', 'urls', 'link', 'links', 'linkedin', 'linkedinUrl', 'webpageUrl', 'source', 'sources',
  'sourceUrl', 'budgetSources', 'citations', 'ticker', 'symbol', 'currency', 'date', 'createdAt', 'completedAt',
  'startedAt', 'updatedAt', 'fiscalYear', 'year', 'period', 'dataSource', 'gapLevel', 'color', 'chartType',
  'logo', 'email', 'phone', 'hq', 'headquarters',
]);

const URLISH = /^(https?:\/\/|www\.)\S+$|^[\w.-]+\.[a-z]{2,}(\/\S*)?$|^\S+@\S+$/i;

type Rep = string | ((m: string, g1?: string) => string);
const forms = (base: string, past = base + 'd') => (_m: string, g = '') =>
  ({ '': base, e: base, s: base + 's', es: base + 's', ed: past, d: past, ing: base.replace(/e$/, '') + 'ing' } as Record<string, string>)[g.toLowerCase()] ?? base;

const BANNED: Array<[RegExp, Rep]> = [
  [/\bdelv(e|es|ed|ing) into\b/gi, forms('examine')],
  [/\bdelv(e|es|ed|ing)\b/gi, forms('examine')],
  [/\b(?:is |stands as )?a testament to\b/gi, 'shows'],
  [/\btestament\b/gi, 'proof'],
  [/\bfurthermore\b/gi, 'also'],
  [/\bmeticulously\b/gi, 'carefully'],
  [/\bvital role\b/gi, 'key role'],
  [/\bin conclusion\b/gi, 'overall'],
  [/\bunderscor(e|es|ed|ing)\b/gi, forms('highlight', 'highlighted')],
  [/\bparamount\b/gi, 'essential'],
  [/\bfoster(s|ed|ing)?\b/gi, forms('build', 'built')],
  [/\bnavigat(e|es|ed|ing)\b/gi, forms('manage')],
  [/\blandscapes?\b/gi, 'environment'],
  [/\bbespoke\b/gi, 'custom'],
  [/\btapestry\b/gi, 'mix'],
  // Lowercase only: "Microsoft Dynamics" and "Boston Dynamics" are names.
  [/\bdynamic pricing\b/g, 'variable pricing'],
  [/\bdynamics\b/g, 'forces'],
  [/\bdynamic\b/g, 'fast-changing'],
  [/\blook no further than\b/gi, 'consider'],
  [/\blook no further\b/gi, 'start here'],
  [/\bcritically important\b/gi, 'essential'],
];

function matchCase(src: string, out: string): string {
  return /^[A-Z]/.test(src) ? out[0].toUpperCase() + out.slice(1) : out;
}

export function cleanDeterministic(text: string): string {
  let t = text;
  // Number and date ranges keep a plain hyphen: 2020–2025 -> 2020-2025.
  t = t.replace(/(\d)\s*[–—]\s*(\d)/g, '$1-$2');
  // A spaced dash or an em dash joining words becomes a comma.
  t = t.replace(/\s+[–—]\s+|—/g, ', ');
  t = t.replace(/–/g, '-');
  t = t.replace(/\s+--\s+/g, ', ');
  for (const [re, rep] of BANNED) {
    t = t.replace(re, (m: string, g1?: unknown) => matchCase(m, typeof rep === 'string' ? rep : rep(m, typeof g1 === 'string' ? g1 : '')));
  }
  return t.replace(/,\s*,/g, ',').replace(/ {2,}/g, ' ');
}

function isProse(key: string | undefined, value: string): boolean {
  if (key && SKIP_KEYS.has(key)) return false;
  const v = value.trim();
  return v.includes(' ') && !URLISH.test(v);
}

// A string worth an LLM rewrite: real sentences, not a label or a table.
function isRewritable(value: string): boolean {
  const v = value.trim();
  return v.length >= 80 && v.length <= 6000 && v.split(/\s+/).length >= 12 && !/\n\s*\|/.test(v);
}

type Visit = (key: string | undefined, value: string) => string;

function mapStrings(node: unknown, visit: Visit, key?: string): unknown {
  if (typeof node === 'string') return visit(key, node);
  if (Array.isArray(node)) return node.map((n) => mapStrings(n, visit, key));
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      out[k] = SKIP_KEYS.has(k) ? v : mapStrings(v, visit, k);
    }
    return out;
  }
  return node;
}

export function cleanPayloadDeterministic<T>(payload: T): T {
  return mapStrings(payload, (k, v) => (isProse(k, v) ? cleanDeterministic(v) : v)) as T;
}

export const LANGUAGE_CHECK_PROMPT = `You are the language check for a business intelligence product. Every report passes through you before it is published. Rewrite each text so it reads as if a busy, precise executive wrote it.

RULES
1. Short, active sentences. No long multi-clause statements. Vary sentence length; avoid symmetric, rhythmic phrasing. Let the text read like an internal memo.
2. Plain, specific business words. Say things directly. No corporate filler phrases.
3. Never use em dashes, en dashes or parenthetical asides.
4. Never use: delve, testament, furthermore, meticulously, vital role, in conclusion, underscore, paramount, foster, navigate, landscape, bespoke, tapestry, dynamic, look no further, critically important. Use simple verbs instead: use, show, help, build, manage.
5. Stay fully professional and error free. No slang, no typos.
6. Keep every fact, figure, name, date, percentage, currency amount and technical term exactly. Do not add facts. Do not drop facts.
7. Keep markdown, bullet markers and line breaks where they appear. Keep the language of the input.

INPUT: a JSON array of strings.
OUTPUT: only a JSON array of the rewritten strings, same length, same order. No commentary.`;

const numbers = (s: string) => (s.match(/\d[\d,.]*\d|\d/g) ?? []).map((n) => n.replace(/[,.]$/, ''));

// Accept a rewrite only when it is safe to publish in place of the original.
export function acceptRewrite(original: string, rewrite: unknown): string | null {
  if (typeof rewrite !== 'string' || !rewrite.trim()) return null;
  const ratio = rewrite.length / original.length;
  if (ratio < 0.4 || ratio > 1.5) return null;
  const have = rewrite.replace(/,(?=\d{3}\b)/g, '');
  for (const n of numbers(original)) {
    if (!have.includes(n.replace(/,(?=\d{3}\b)/g, ''))) return null;
  }
  return rewrite;
}

function parseArray(raw: string): unknown[] | null {
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const BATCH_CHARS = 9000;
const CONCURRENCY = 4;

async function rewriteBatch(texts: string[]): Promise<(string | null)[]> {
  try {
    const raw = await claudeCreateDirect(
      LANGUAGE_CHECK_PROMPT, JSON.stringify(texts),
      Math.min(16000, Math.ceil(texts.join('').length / 2.5) + 1000),
      FAST_MODEL, 120_000, 0.3, 'languageCheck',
    );
    const out = parseArray(raw);
    if (!out || out.length !== texts.length) return texts.map(() => null);
    return texts.map((t, i) => acceptRewrite(t, out[i]));
  } catch (err) {
    console.warn('[languageCheck] rewrite batch failed:', err instanceof Error ? err.message : err);
    return texts.map(() => null);
  }
}

export interface LanguageCheckStats { strings: number; rewritten: number; rejected: number }

export async function languageCheck<T>(payload: T): Promise<{ payload: T; stats: LanguageCheckStats }> {
  const cleaned = cleanPayloadDeterministic(payload);

  const targets: string[] = [];
  mapStrings(cleaned, (k, v) => {
    if (isProse(k, v) && isRewritable(v) && !targets.includes(v)) targets.push(v);
    return v;
  });

  const batches: string[][] = [];
  let cur: string[] = [];
  let size = 0;
  for (const t of targets) {
    if (cur.length && size + t.length > BATCH_CHARS) { batches.push(cur); cur = []; size = 0; }
    cur.push(t); size += t.length;
  }
  if (cur.length) batches.push(cur);

  const results = new Map<string, string>();
  for (let i = 0; i < batches.length; i += CONCURRENCY) {
    const group = batches.slice(i, i + CONCURRENCY);
    const outs = await Promise.all(group.map(rewriteBatch));
    group.forEach((b, bi) => b.forEach((t, ti) => {
      const r = outs[bi][ti];
      if (r) results.set(t, cleanDeterministic(r));
    }));
  }

  const final = mapStrings(cleaned, (k, v) => (isProse(k, v) ? results.get(v) ?? v : v)) as T;
  return { payload: final, stats: { strings: targets.length, rewritten: results.size, rejected: targets.length - results.size } };
}
