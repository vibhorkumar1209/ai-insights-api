import { v4 as uuidv4 } from 'uuid';
import { JobPostingInput, JobPostingParsed, JobDescriptionParserResult } from '@ai-insights/types';
import { claudeCreateDirect } from './claudeAI';

// Pure structured-extraction transform — everything needed is already in the
// user-supplied job posting text, so this is Claude-only, no research calls.
const MODEL = 'claude-sonnet-4-6'; // matches this codebase's standard model everywhere else

// ── In-memory job store — same pattern as every other module in this app ────

const jobs = new Map<string, JobDescriptionParserResult>();
const JOB_TTL_MS = 2 * 60 * 60 * 1000;

setInterval(() => {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs.entries()) {
    if (new Date(job.createdAt).getTime() < cutoff) jobs.delete(id);
  }
}, 30 * 60 * 1000);

type SSECallback = (event: string, data: unknown) => void;
const subscribers = new Map<string, SSECallback[]>();

export function subscribeToJob(jobId: string, cb: SSECallback): void {
  const list = subscribers.get(jobId) || [];
  list.push(cb);
  subscribers.set(jobId, list);
}

export function unsubscribeFromJob(jobId: string, cb: SSECallback): void {
  const list = (subscribers.get(jobId) || []).filter((c) => c !== cb);
  if (list.length > 0) subscribers.set(jobId, list);
  else subscribers.delete(jobId);
}

function emit(jobId: string, event: string, data: unknown): void {
  (subscribers.get(jobId) || []).forEach((cb) => cb(event, data));
}

function update(jobId: string, patch: Partial<JobDescriptionParserResult>): JobDescriptionParserResult {
  const current = jobs.get(jobId)!;
  const updated = { ...current, ...patch };
  jobs.set(jobId, updated);
  return updated;
}

export function createJobDescriptionParserJob(postings: JobPostingInput[]): string {
  const jobId = uuidv4();
  jobs.set(jobId, {
    jobId,
    status: 'pending',
    progress: 0,
    totalPostings: postings.length,
    parsed: [],
    createdAt: new Date().toISOString(),
  });
  return jobId;
}

export function getJobDescriptionParserJob(jobId: string): JobDescriptionParserResult | undefined {
  return jobs.get(jobId);
}

// ── Bounded concurrency (mirrors competitionBenchmarkingService.ts) ─────────

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const SYSTEM_PROMPT = `You extract structured data from a single raw job posting. Work ONLY from the text given — never invent a skill, domain, or detail not present in the posting. If the posting doesn't state something (e.g. no explicit posted date), use your best direct reading of the text rather than guessing.

Rules:
- "domain" is the functional/technical domain the role sits in (e.g. "Mobile App Development", "Backend Engineering", "Data Science") — infer this from the title and responsibilities, keep it to 2-5 words.
- "summary" is a dense 1-2 sentence summary of what the role actually does, not a restatement of the whole posting.
- "required_skills" groups the posting's technical/functional requirements into a small number of sensible categories (e.g. "Languages & Frameworks", "Tools & Platforms", "Domain Experience") — do not create one category per skill; group related skills together. Extract only skills the posting actually lists or clearly implies, not generic seniority/soft-skill fluff.
- "posted_date" should reflect what the posting states (e.g. "29 days ago") — pass it through as given unless the posting itself states an absolute date, in which case prefer the absolute date.

Return ONLY a JSON object (no markdown fencing, no prose) matching this exact schema:
{
  "domain": string,
  "job_title": string,
  "summary": string,
  "posted_date": string,
  "required_skills": [{ "category": string, "skills": string[] }],
  "job_posting_url": string
}`;

function tryParseJson(raw: string): Record<string, unknown> | null {
  const match = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim().match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

async function parsePosting(posting: JobPostingInput, index: number): Promise<JobPostingParsed> {
  const userPrompt = `Job posting:
Title: ${posting.jobTitle}
Posted: ${posting.postedDate || 'not stated'}
URL: ${posting.jobPostingUrl || 'not provided'}

Description:
${posting.jobDescription}`;

  const repairSuffix = `

Your previous response did not parse as valid JSON matching the schema. Return ONLY the JSON object this time — no markdown code fences, no prose before or after it.`;

  const ATTEMPTS = 2; // 1 normal + 1 repair attempt on parse failure — same pattern as competitionBenchmarkingService.ts
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const prompt = attempt === 0 ? userPrompt : userPrompt + repairSuffix;
    const raw = await claudeCreateDirect(SYSTEM_PROMPT, prompt, 1500, MODEL, 60_000, 0.1, `parsePosting.${index}${attempt > 0 ? '.repair' : ''}`).catch(() => '');
    const parsed = raw ? tryParseJson(raw) : null;
    if (parsed) {
      return {
        domain: (parsed.domain as string) || '',
        job_title: (parsed.job_title as string) || posting.jobTitle,
        summary: (parsed.summary as string) || '',
        posted_date: (parsed.posted_date as string) || posting.postedDate || '',
        required_skills: Array.isArray(parsed.required_skills) ? parsed.required_skills as JobPostingParsed['required_skills'] : [],
        job_posting_url: (parsed.job_posting_url as string) || posting.jobPostingUrl || '',
      };
    }
  }

  return {
    domain: '', job_title: posting.jobTitle, summary: '', posted_date: posting.postedDate || '',
    required_skills: [], job_posting_url: posting.jobPostingUrl || '',
    parseError: `Could not extract structured data for "${posting.jobTitle}" after ${ATTEMPTS} attempts.`,
  };
}

export async function runJobDescriptionParser(jobId: string, postings: JobPostingInput[]): Promise<void> {
  try {
    let job = update(jobId, { status: 'parsing', progress: 5, currentStep: `Parsing 0/${postings.length} postings…` });
    emit(jobId, 'progress', job);

    let done = 0;
    const parsed = await mapWithConcurrency(postings, 6, async (posting, index) => {
      const result = await parsePosting(posting, index);
      done++;
      const progress = 5 + Math.round((done / postings.length) * 90);
      job = update(jobId, { progress, currentStep: `Parsed ${done}/${postings.length} postings…` });
      emit(jobId, 'progress', job);
      return result;
    });

    job = update(jobId, {
      status: 'complete',
      progress: 100,
      currentStep: 'Complete',
      parsed,
      completedAt: new Date().toISOString(),
    });
    emit(jobId, 'result', job);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Job description parsing failed';
    console.error(`[jobDescriptionParser] job ${jobId} failed:`, message);
    const job = update(jobId, { status: 'error', error: message });
    emit(jobId, 'error', job);
  }
}
