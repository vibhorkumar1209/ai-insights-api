import type { Request, Response, NextFunction } from 'express';

// Text pasted from LinkedIn and similar sites carries characters that do not
// render: a zero-width space arrived inside "The Chefs'​ Warehouse" from the
// RefractOne API. It looks identical to the clean name but is a different
// string, so it slips past duplicate detection, splits Report History labels,
// and reaches the prompts. Cleaned here once, for every module, before any
// route reads the body.
//
// Removes zero-width and formatting characters (Unicode category Cf: zero-width
// space and joiners, BOM, word joiner, soft hyphen, bidi marks) and turns
// non-breaking and other exotic spaces into a plain space.
const INVISIBLE = /[\p{Cf}]/gu;
const ODD_SPACE = /[   -   　]/g;

export function cleanText(s: string): string {
  return s.replace(INVISIBLE, '').replace(ODD_SPACE, ' ');
}

function cleanDeep(v: unknown, depth = 0): unknown {
  if (typeof v === 'string') return cleanText(v);
  if (depth > 6 || !v || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => cleanDeep(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = cleanDeep(x, depth + 1);
  return out;
}

export function stripInvisible(req: Request, _res: Response, next: NextFunction): void {
  if (req.body && typeof req.body === 'object') req.body = cleanDeep(req.body);
  next();
}
