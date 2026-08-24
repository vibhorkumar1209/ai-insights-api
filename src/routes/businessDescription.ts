import { Router, Request, Response } from 'express';
import { BusinessDescriptionInput } from '@ai-insights/types';
import {
  createBusinessDescriptionJob,
  getBusinessDescriptionJob,
  runBusinessDescription,
  subscribeToJob,
  unsubscribeFromJob,
} from '../services/businessDescriptionService';
import { aiLimiter } from '../middleware/rateLimiter';
import { registerJobStart, extractLabel } from '../services/reportRegistry';

const router = Router();

/** POST /api/business-description — start job */
router.post('/', aiLimiter, (req: Request, res: Response): void => {
  const { companyName, domain } = req.body;

  if (!companyName || typeof companyName !== 'string') {
    res.status(400).json({ error: 'companyName is required and must be a string' });
    return;
  }
  if (companyName.length > 200 || (domain && String(domain).length > 200)) {
    res.status(400).json({ error: 'Input too long' });
    return;
  }

  const input: BusinessDescriptionInput = {
    companyName: companyName.trim(),
    domain: typeof domain === 'string' && domain.trim() ? domain.trim() : undefined,
  };

  const jobId = createBusinessDescriptionJob();
  registerJobStart('business-description', jobId, extractLabel(req.body));
  runBusinessDescription(jobId, input).catch((err) =>
    console.error(`[business-description] Job ${jobId} failed:`, err)
  );

  res.status(202).json({ jobId });
});

/** GET /api/business-description/:jobId — snapshot */
router.get('/:jobId', (req: Request, res: Response): void => {
  const job = getBusinessDescriptionJob(req.params.jobId);
  if (!job) { res.status(404).json({ error: 'Job not found' }); return; }
  res.json(job);
});

/** GET /api/business-description/:jobId/stream — SSE */
router.get('/:jobId/stream', (req: Request, res: Response): void => {
  const job = getBusinessDescriptionJob(req.params.jobId);
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
