import { Router, Request, Response } from 'express';
import { aiLimiter } from '../middleware/rateLimiter';
import {
  createIndustryTrendsJob,
  getIndustryTrendsJob,
  runIndustryTrends,
  subscribeToJob,
  unsubscribeFromJob,
} from '../services/industryTrendsService';

const router = Router();

/** POST /api/industry-trends — start analysis */
router.post('/', aiLimiter, (req: Request, res: Response): void => {
  const { industrySegment } = req.body;

  if (!industrySegment || typeof industrySegment !== 'string' || !industrySegment.trim()) {
    res.status(400).json({ error: 'industrySegment is required' });
    return;
  }

  const jobId = createIndustryTrendsJob();

  runIndustryTrends(jobId, {
    industrySegment: industrySegment.trim().slice(0, 300),
  }).catch((err) => console.error('[industryTrends] Unhandled error:', err));

  res.status(202).json({ jobId });
});

/** GET /api/industry-trends/:jobId — snapshot */
router.get('/:jobId', (req: Request, res: Response): void => {
  const job = getIndustryTrendsJob(req.params.jobId);
  if (!job) { res.status(404).json({ error: 'Job not found' }); return; }
  res.json(job);
});

/** GET /api/industry-trends/:jobId/stream — SSE */
router.get('/:jobId/stream', (req: Request, res: Response): void => {
  const job = getIndustryTrendsJob(req.params.jobId);
  if (!job) { res.status(404).json({ error: 'Job not found' }); return; }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  if (job.status === 'complete' || job.status === 'error') {
    const evt = job.status === 'complete' ? 'result' : 'error';
    res.write(`event: ${evt}\ndata: ${JSON.stringify(job)}\n\n`);
    res.end();
    return;
  }

  res.flushHeaders();
  res.write(`event: progress\ndata: ${JSON.stringify(job)}\n\n`);

  const keepAlive = setInterval(() => {
    try { res.write(': keepalive\n\n'); } catch { clearInterval(keepAlive); }
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
