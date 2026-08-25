import { Router, Request, Response } from 'express';
import { aiLimiter } from '../middleware/rateLimiter';
import {
  createJobDescriptionParserJob, getJobDescriptionParserJob, runJobDescriptionParser,
  subscribeToJob, unsubscribeFromJob,
} from '../services/jobDescriptionParserService';
import { JobPostingInput } from '@ai-insights/types';
import { registerJobStart, extractLabel } from '../services/reportRegistry';
import { dedupeJobStart } from '../services/jobDedupe';

const router = Router();

const MAX_POSTINGS = 50;

// POST /api/job-description-parser — { postings: JobPostingInput[] }
router.post('/', aiLimiter, (req: Request, res: Response) => {
  const { postings } = req.body;

  if (!Array.isArray(postings) || postings.length === 0) {
    res.status(400).json({ error: 'postings must be a non-empty array' });
    return;
  }
  if (postings.length > MAX_POSTINGS) {
    res.status(400).json({ error: `Maximum ${MAX_POSTINGS} postings per request` });
    return;
  }

  const cleaned: JobPostingInput[] = [];
  for (const [i, p] of postings.entries()) {
    if (!p || typeof p !== 'object' || typeof p.jobTitle !== 'string' || !p.jobTitle.trim()) {
      res.status(400).json({ error: `postings[${i}].jobTitle is required` });
      return;
    }
    if (typeof p.jobDescription !== 'string' || !p.jobDescription.trim()) {
      res.status(400).json({ error: `postings[${i}].jobDescription is required` });
      return;
    }
    cleaned.push({
      jobTitle: p.jobTitle.trim(),
      jobDescription: p.jobDescription.trim().slice(0, 20_000),
      postedDate: typeof p.postedDate === 'string' ? p.postedDate.trim() : undefined,
      jobPostingUrl: typeof p.jobPostingUrl === 'string' ? p.jobPostingUrl.trim() : undefined,
    });
  }

  const { jobId, isNew } = dedupeJobStart(
    'job-description-parser',
    cleaned,
    (id) => getJobDescriptionParserJob(id)?.status,
    (status) => status === 'error',
    () => createJobDescriptionParserJob(cleaned)
  );
  if (isNew) {
    registerJobStart('job-description-parser', jobId, extractLabel(req.body));
    runJobDescriptionParser(jobId, cleaned).catch(() => {});
  }
  res.status(202).json({ jobId });
});

// GET /api/job-description-parser/:jobId — snapshot
router.get('/:jobId', (req: Request, res: Response) => {
  const job = getJobDescriptionParserJob(req.params.jobId);
  if (!job) { res.status(404).json({ error: 'Job not found' }); return; }
  res.json(job);
});

// GET /api/job-description-parser/:jobId/stream — SSE
router.get('/:jobId/stream', (req: Request, res: Response) => {
  const job = getJobDescriptionParserJob(req.params.jobId);
  if (!job) { res.status(404).json({ error: 'Job not found' }); return; }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  res.write(`event: progress\ndata: ${JSON.stringify(job)}\n\n`);

  if (job.status === 'complete') {
    res.write(`event: result\ndata: ${JSON.stringify(job)}\n\n`);
    res.end();
    return;
  }
  if (job.status === 'error') {
    res.write(`event: error\ndata: ${JSON.stringify({ error: job.error })}\n\n`);
    res.end();
    return;
  }

  const keepAlive = setInterval(() => {
    try { res.write(': keepalive\n\n'); } catch { clearInterval(keepAlive); }
  }, 20_000);

  const cb = (event: string, data: unknown) => {
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* closed */ }
    if (event === 'result' || event === 'error') { cleanup(); res.end(); }
  };
  subscribeToJob(req.params.jobId, cb);

  const cleanup = () => { clearInterval(keepAlive); unsubscribeFromJob(req.params.jobId, cb); };
  req.on('close', cleanup);
  req.on('error', cleanup);
});

export default router;
