// Resuming a report that stopped part-way.
//
// Multi-part reports (Industry Report sections, Outsourcing / GCC Sales Play
// chunks, IT Jobs regions) used to lose everything, or silently ship with
// parts missing, when an AI provider failed mid-run; the usual cause was the
// API credit balance running out. Each of those modules now keeps the parts it
// finished, marks the job canContinue, and exposes POST /:jobId/continue,
// which generates only the missing parts and appends them in order. Nothing
// already written is regenerated or repeated.

const CREDIT_PATTERN = /credit balance|credits ran out|insufficient[_ ](credit|fund|balance|quota)|out of credits|payment required|billing|quota exceeded|exceeded your current quota|\b402\b/i;

export function isCreditExhausted(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return CREDIT_PATTERN.test(msg);
}

export const CONTINUE_HINT = 'Choose Continue to finish it from where it stopped.';

export function incompleteMessage(err: unknown): string {
  if (isCreditExhausted(err)) {
    return `AI credits ran out before the report finished. Add credits, then ${CONTINUE_HINT.charAt(0).toLowerCase()}${CONTINUE_HINT.slice(1)}`;
  }
  return `The report stopped before it finished. ${CONTINUE_HINT}`;
}

/** Fields every resumable job carries. */
export interface ResumableState {
  canContinue?: boolean;
  incompleteReason?: string;
}

export type ContinueOutcome =
  | { ok: true; started: boolean }
  | { ok: false; status: 404 | 409; error: string };

/** Shared guard: what a /continue request may act on. */
export function checkContinuable(job: { status: string; canContinue?: boolean } | undefined): ContinueOutcome | null {
  if (!job) return { ok: false, status: 404, error: 'Job not found' };
  if (job.status !== 'complete' && job.status !== 'error') {
    return { ok: false, status: 409, error: 'The report is still being generated.' };
  }
  if (!job.canContinue) return { ok: true, started: false };
  return null;
}

// ── Auto-continue ───────────────────────────────────────────────────────────
// A report that stopped because the credits ran out is queued here. While the
// queue is non-empty, a one-token Claude call every PROBE_MS checks whether
// credits are back (a fraction of a cent per check); the first success resumes
// every queued report. Entries older than MAX_WAIT_MS are dropped: the report
// is still there to continue by hand. The queue is in memory, so a restart
// empties it.
const PROBE_MS = 5 * 60 * 1000;
const MAX_WAIT_MS = 24 * 60 * 60 * 1000;

interface Waiting { module: string; queuedAt: number; resume: () => void }
const waiting = new Map<string, Waiting>();
let timer: NodeJS.Timeout | null = null;
let probing = false;

type Probe = () => Promise<void>;
let probeImpl: Probe = async () => {
  // Lazy import keeps this module free of the Claude client for unit tests.
  const { claudeCreateDirect, FAST_MODEL } = await import('./claudeAI');
  await claudeCreateDirect('Reply with OK.', 'OK', 1, FAST_MODEL, 20_000, 0, 'creditProbe');
};

export function _setCreditProbeForTests(p: Probe): void { probeImpl = p; }
export function _autoContinueQueue(): string[] { return [...waiting.keys()]; }

export function isWaitingForCredits(jobId: string): boolean { return waiting.has(jobId); }

export function queueAutoContinue(module: string, jobId: string, resume: () => void): void {
  waiting.set(jobId, { module, queuedAt: Date.now(), resume });
  console.log(`[autoContinue] ${module} ${jobId} queued until credits are back`);
  if (!timer) {
    timer = setInterval(() => { void checkCredits(); }, PROBE_MS);
    timer.unref();
  }
}

export function dropAutoContinue(jobId: string): void {
  waiting.delete(jobId);
  if (waiting.size === 0 && timer) { clearInterval(timer); timer = null; }
}

export async function checkCredits(): Promise<boolean> {
  if (probing || waiting.size === 0) return false;
  probing = true;
  try {
    const now = Date.now();
    for (const [id, w] of waiting) if (now - w.queuedAt > MAX_WAIT_MS) dropAutoContinue(id);
    if (waiting.size === 0) return false;
    try {
      await probeImpl();
    } catch (err) {
      if (!isCreditExhausted(err)) console.warn('[autoContinue] credit check failed:', err instanceof Error ? err.message : err);
      return false;
    }
    const ready = [...waiting.entries()];
    console.log(`[autoContinue] credits are back, continuing ${ready.length} report(s)`);
    for (const [id, w] of ready) {
      dropAutoContinue(id);
      try { w.resume(); } catch (err) { console.error(`[autoContinue] ${w.module} ${id} failed to resume:`, err); }
    }
    return true;
  } finally {
    probing = false;
  }
}
