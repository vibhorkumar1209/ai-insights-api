import { loadJson, saveJsonDebounced } from './persistentStore';

// Shared duplicate-submission guard for every job-creating module.
//
// Business Description was found to have been hit 200+ times for the exact
// same company within ~30 minutes in production — whatever the cause (a
// real user resubmitting, a script, a bot), every one of those was a wasted
// Claude/Parallel.AI/Gemini call for an answer already in flight or already
// sitting in the job store. That fix was originally written bespoke, one-off,
// inside businessDescriptionService.ts. This generalizes it so every module
// that creates an async job gets the same protection with one call at the
// route layer, keyed on the module + the exact request payload rather than
// requiring each service to hand-write its own key function.

const DEFAULT_WINDOW_MS = 3 * 60 * 1000;

interface DedupeEntry {
  jobId: string;
  expiresAt: number;
}

const recentByKey = new Map<string, DedupeEntry>();

// Persisted so the window survives a restart. Without this, the first
// request after every deploy started fresh AI work regardless of how
// recently an identical one had been deduped — and with autoDeploy on every
// push, that was defeating the protection exactly when it mattered most.
// No-ops unless REDIS_URL or DATA_DIR is configured (see persistentStore.ts).
const DEDUPE_STORE_KEY = 'job-dedupe-v1';

function snapshotDedupe(): Record<string, DedupeEntry> {
  return Object.fromEntries(recentByKey);
}

function scheduleDedupeSave(): void {
  // Short debounce: this state is only useful if it's current at the moment
  // a restart happens, and the payload is tiny.
  saveJsonDebounced(DEDUPE_STORE_KEY, snapshotDedupe, 2000);
}

/** Rehydrate the dedupe window at startup. Expired entries are discarded. */
export async function restoreDedupeFromStore(): Promise<void> {
  const snapshot = await loadJson<Record<string, DedupeEntry>>(DEDUPE_STORE_KEY);
  if (!snapshot) return;

  const now = Date.now();
  let restored = 0;
  for (const [key, entry] of Object.entries(snapshot)) {
    if (entry && typeof entry.jobId === 'string' && typeof entry.expiresAt === 'number' && entry.expiresAt > now) {
      recentByKey.set(key, entry);
      restored++;
    }
  }
  if (restored > 0) console.log(`[jobDedupe] restored ${restored} live dedupe entries from persistent store`);
}

export function getDedupeFlushTarget(): { key: string; getValue: () => unknown } {
  return { key: DEDUPE_STORE_KEY, getValue: snapshotDedupe };
}

// Deterministic JSON stringify (sorted object keys) so two requests with the
// same fields in a different order still dedupe against each other.
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

// Prevents recentByKey from growing unbounded across the process lifetime —
// entries are already single-purpose (one dedupe window each), so a sweep
// every few minutes is enough; nothing here is hot-path critical.
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of recentByKey.entries()) {
    if (entry.expiresAt <= now) recentByKey.delete(key);
  }
}, 5 * 60 * 1000).unref();

/**
 * Wraps a module's job-creation call with a dedupe check: an identical
 * request (same moduleType + same request payload, deep-equal regardless of
 * key order) within `windowMs` of a still-usable prior job returns that
 * job's id instead of starting new AI work. "Still usable" means the prior
 * job hasn't errored — an errored job is evicted immediately so a retry of
 * a genuinely failed request isn't blocked.
 *
 * Usage at the route layer (uniform regardless of whether the module's own
 * createXJob(...) takes the input or not — that's handled by the startNew
 * closure):
 *
 *   const { jobId, isNew } = dedupeJobStart(
 *     'business-themes',
 *     input,
 *     (id) => getThemeJob(id)?.status,
 *     (status) => status === 'error',
 *     () => createThemeJob(),
 *   );
 *   if (isNew) {
 *     registerJobStart('business-themes', jobId, extractLabel(req.body));
 *     runThemesAnalysis(jobId, input).catch(...);
 *   }
 *   res.status(202).json({ jobId });
 */
export function dedupeJobStart<TStatus>(
  moduleType: string,
  input: unknown,
  getStatus: (jobId: string) => TStatus | undefined,
  isError: (status: TStatus) => boolean,
  startNew: () => string,
  windowMs: number = DEFAULT_WINDOW_MS
): { jobId: string; isNew: boolean } {
  const key = `${moduleType}|${stableStringify(input)}`;
  const now = Date.now();
  const existing = recentByKey.get(key);

  if (existing && existing.expiresAt > now) {
    const status = getStatus(existing.jobId);
    if (status !== undefined && !isError(status)) {
      return { jobId: existing.jobId, isNew: false };
    }
    recentByKey.delete(key);
  }

  const jobId = startNew();
  recentByKey.set(key, { jobId, expiresAt: now + windowMs });
  scheduleDedupeSave();
  return { jobId, isNew: true };
}
