import { v4 as uuidv4 } from 'uuid';
import { ThemeInput, ThemeResult } from '../types';
import { researchCompanyThemes } from './parallelAI';
import { synthesizeThemes } from './claudeAI';

// ── In-memory job store ───────────────────────────────────────────────────────

const jobs = new Map<string, ThemeResult>();

const JOB_TTL_MS = 2 * 60 * 60 * 1000;
const cleanupTimer = setInterval(() => {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs.entries()) {
    if (new Date(job.createdAt).getTime() < cutoff) {
      jobs.delete(id);
    }
  }
}, 30 * 60 * 1000);
cleanupTimer.unref();

export function getThemeJob(jobId: string): ThemeResult | undefined {
  return jobs.get(jobId);
}

export function createThemeJob(): string {
  const jobId = uuidv4();
  jobs.set(jobId, {
    jobId,
    status: 'pending',
    progress: 0,
    createdAt: new Date().toISOString(),
  });
  return jobId;
}

function updateThemeJob(jobId: string, update: Partial<ThemeResult>) {
  const current = jobs.get(jobId);
  if (current) {
    jobs.set(jobId, { ...current, ...update });
  }
}

// ── SSE subscriber registry ───────────────────────────────────────────────────

type SSECallback = (event: string, data: unknown) => void;
const subscribers = new Map<string, SSECallback[]>();

export function subscribeToThemeJob(jobId: string, cb: SSECallback) {
  const existing = subscribers.get(jobId) || [];
  subscribers.set(jobId, [...existing, cb]);
}

export function unsubscribeFromThemeJob(jobId: string, cb: SSECallback) {
  const existing = subscribers.get(jobId) || [];
  subscribers.set(jobId, existing.filter((fn) => fn !== cb));
}

function emit(jobId: string, event: string, data: unknown) {
  const cbs = subscribers.get(jobId) || [];
  cbs.forEach((cb) => cb(event, data));
}

// ── Main themes runner ────────────────────────────────────────────────────────

export async function runThemesAnalysis(jobId: string, input: ThemeInput): Promise<void> {
  const step = (msg: string, progress: number) => {
    updateThemeJob(jobId, { currentStep: msg, progress, status: 'researching' });
    emit(jobId, 'progress', { currentStep: msg, progress });
  };

  try {
    updateThemeJob(jobId, {
      companyName: input.companyName,
      themeType: input.themeType,
    });

    step(`Researching ${input.companyName}...`, 10);

    const research = await researchCompanyThemes(input.companyName, input.themeType);

    step('Synthesizing themes...', 65);
    updateThemeJob(jobId, { status: 'synthesizing' });
    emit(jobId, 'progress', { progress: 65, currentStep: 'Synthesizing themes...' });

    const rows = await synthesizeThemes(input, research);

    const completed: Partial<ThemeResult> = {
      status: 'complete',
      progress: 100,
      currentStep: 'Complete',
      rows,
      completedAt: new Date().toISOString(),
    };

    updateThemeJob(jobId, completed);
    emit(jobId, 'result', { ...jobs.get(jobId) });
  } catch (err) {
    const raw = err instanceof Error ? err.message : 'Unknown error';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const status = (err as any)?.status;
    const friendly =
      status === 529 || /overloaded/i.test(raw)
        ? 'Anthropic API is temporarily overloaded. Please retry in a minute.'
        : status === 429 || /rate limit/i.test(raw)
        ? 'Rate limit hit on the AI provider. Please wait a moment and retry.'
        : raw;
    updateThemeJob(jobId, { status: 'error', error: friendly, progress: 0 });
    emit(jobId, 'error', { error: friendly });
  }
}
