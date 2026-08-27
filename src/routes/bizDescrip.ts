import { Router, Request, Response } from 'express';
import { BizDescripInput } from '@ai-insights/types';
import {
  createBizDescripJob,
  getBizDescripJob,
  runBizDescrip,
  subscribeToJob,
  unsubscribeFromJob,
} from '../services/bizDescripService';
import { aiLimiter } from '../middleware/rateLimiter';
import { registerJobStart, extractLabel } from '../services/reportRegistry';
import { dedupeJobStart } from '../services/jobDedupe';

const router = Router();

const LINKEDIN_URL_PATTERN = /^https?:\/\/([a-z]{2,3}\.)?linkedin\.com\//i;

/**
 * POST /api/biz-descrip — start job
 * Body: { companyName: string, companyDomain: string, linkedinUrl?: string }
 */
router.post('/', aiLimiter, (req: Request, res: Response): void => {
  const { companyName, companyDomain, linkedinUrl } = req.body;

  if (!companyName || typeof companyName !== 'string') {
    res.status(400).json({ error: 'companyName is required and must be a string' });
    return;
  }
  if (!companyDomain || typeof companyDomain !== 'string' || !companyDomain.trim()) {
    res.status(400).json({ error: 'companyDomain is required — it anchors company identity, since names are frequently shared by unrelated businesses' });
    return;
  }
  if (companyName.length > 200 || companyDomain.length > 200 || (linkedinUrl && String(linkedinUrl).length > 500)) {
    res.status(400).json({ error: 'Input too long' });
    return;
  }
  if (linkedinUrl && typeof linkedinUrl === 'string' && linkedinUrl.trim() && !LINKEDIN_URL_PATTERN.test(linkedinUrl.trim())) {
    res.status(400).json({ error: 'linkedinUrl must be a linkedin.com URL' });
    return;
  }

  const input: BizDescripInput = {
    companyName: companyName.trim(),
    companyDomain: companyDomain.trim(),
    linkedinUrl: typeof linkedinUrl === 'string' && linkedinUrl.trim() ? linkedinUrl.trim() : undefined,
  };

  const { jobId, isNew } = dedupeJobStart(
    'biz-descrip',
    input,
    (id) => getBizDescripJob(id)?.status,
    (status) => status === 'error',
    () => createBizDescripJob()
  );
  if (isNew) {
    registerJobStart('biz-descrip', jobId, extractLabel(req.body) || input.companyName);
    runBizDescrip(jobId, input).catch((err) =>
      console.error(`[biz-descrip] Job ${jobId} failed:`, err)
    );
  }

  res.status(202).json({ jobId });
});

/** GET /api/biz-descrip/:jobId — snapshot */
router.get('/:jobId', (req: Request, res: Response): void => {
  const job = getBizDescripJob(req.params.jobId);
  if (!job) { res.status(404).json({ error: 'Job not found' }); return; }
  res.json(job);
});

/** GET /api/biz-descrip/:jobId/stream — SSE */
router.get('/:jobId/stream', (req: Request, res: Response): void => {
  const job = getBizDescripJob(req.params.jobId);
  if (!job) { res.status(404).json({ error: 'Job not found' }); return; }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  if (job.status === 'complete' || job.status === 'error') {
    res.write(`event: ${job.status === 'complete' ? 'result' : 'error'}\ndata: ${JSON.stringify(job)}\n\n`);
    res.end();
    return;
  }

  res.flushHeaders();
  res.write(`event: progress\ndata: ${JSON.stringify(job)}\n\n`);

  const keepAlive = setInterval(() => {
    try {
      res.write(': keepalive\n\n');
    } catch {
      clearInterval(keepAlive);
    }
  }, 20_000);

  const cb = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    if (event === 'result' || event === 'error') { cleanup(); res.end(); }
  };

  const cleanup = () => {
    clearInterval(keepAlive);
    unsubscribeFromJob(req.params.jobId, cb);
  };

  subscribeToJob(req.params.jobId, cb);
  req.on('close', cleanup);
  req.on('error', cleanup);
});

export default router;
