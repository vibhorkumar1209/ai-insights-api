import type { Request, Response, NextFunction } from 'express';
import { languageCheck, cleanPayloadDeterministic } from '../services/languageCheck';

// Publishing gate: every module's finished output passes the language check
// before any caller (the app, RefractOne) sees it. A module marks its job
// 'complete'; this node holds that status back as 'running' at 99% with
// currentStep "Language check" until the cleaned version is ready, then
// serves only the cleaned version. Pollers need no change.
//
// One run per report: the result is cached by job id (plus any sub-path, so a
// battlecard is checked separately from its dossier). If the rewrite fails or
// stalls, the deterministic clean (dashes, banned words) is still applied and
// the report is published rather than held forever.
const JOB_PATH = /^\/api\/[a-z0-9-]+\/(?:[a-z0-9-]+\/)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\/.*)?$/i;
const MAX_CACHE = 150;
const STALL_MS = 4 * 60_000;

interface Entry { done?: unknown; startedAt: number; source: unknown }
const cache = new Map<string, Entry>();

function remember(key: string, entry: Entry): void {
  cache.set(key, entry);
  while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value as string);
}

export function _resetLanguageCheckCache(): void { cache.clear(); }

function startCheck(key: string, body: unknown): Entry {
  const entry: Entry = { startedAt: Date.now(), source: body };
  remember(key, entry);
  languageCheck(body)
    .then(({ payload, stats }) => {
      entry.done = payload;
      console.log(`[languageCheck] ${key}: ${stats.rewritten}/${stats.strings} rewritten, ${stats.rejected} kept`);
    })
    .catch((err) => {
      entry.done = cleanPayloadDeterministic(body);
      console.warn(`[languageCheck] ${key} failed, deterministic only:`, err instanceof Error ? err.message : err);
    });
  return entry;
}

export function languageCheckGate(req: Request, res: Response, next: NextFunction): void {
  if (req.method !== 'GET' || !req.path.startsWith('/api/') || req.path.startsWith('/api/usage')) { next(); return; }
  const match = req.path.match(JOB_PATH);

  const originalJson = res.json.bind(res);
  res.json = ((body: unknown) => {
    const job = body as { status?: unknown } | null;
    if (!match || res.statusCode !== 200 || !job || typeof job !== 'object' || Array.isArray(job) || job.status !== 'complete') {
      return originalJson(res.statusCode < 400 ? cleanPayloadDeterministic(body) : body);
    }
    const key = match[1] + (match[2] ?? '');
    let entry = cache.get(key);
    if (!entry) entry = startCheck(key, body);
    if (entry.done) return originalJson(entry.done);
    if (Date.now() - entry.startedAt > STALL_MS) {
      entry.done = cleanPayloadDeterministic(body);
      return originalJson(entry.done);
    }
    return originalJson({ ...(body as object), status: 'running', progress: 99, currentStep: 'Language check' });
  }) as Response['json'];
  next();
}
