import { Router, Request, Response } from 'express';
import { aiLimiter } from '../middleware/rateLimiter';
import {
  createIndustryReportJob,
  getIndustryReportJob,
  runIndustryReport,
  subscribeToJob,
  unsubscribeFromJob,
} from '../services/industryReportService';

const router = Router();

// POST /api/industry-report — Start a new industry report
router.post('/', aiLimiter, (req: Request, res: Response) => {
  const { query, geography } = req.body;

  if (!query || typeof query !== 'string' || query.trim().length < 3) {
    res.status(400).json({ error: 'query is required (minimum 3 characters)' });
    return;
  }

  const input = {
    query: query.trim(),
    geography: geography?.trim() || undefined,
  };

  const jobId = createIndustryReportJob(input);
  runIndustryReport(jobId, input).catch((err) =>
    console.error(`[industryReport] Unhandled error for job ${jobId}:`, err)
  );

  res.status(202).json({ jobId });
});

// GET /api/industry-report/:jobId — Snapshot
router.get('/:jobId', (req: Request, res: Response) => {
  const job = getIndustryReportJob(req.params.jobId);
  if (!job) {
    res.status(404).json({ error: 'Job not found' });
    return;
  }
  res.json(job);
});

// GET /api/industry-report/:jobId/stream — SSE stream
router.get('/:jobId/stream', (req: Request, res: Response) => {
  const job = getIndustryReportJob(req.params.jobId);
  if (!job) {
    res.status(404).json({ error: 'Job not found' });
    return;
  }

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Send current state immediately
  res.write(`event: progress\ndata: ${JSON.stringify(job)}\n\n`);

  // If already complete, send result and close
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

  // Keepalive to prevent timeout on idle connections (Railway/Nginx)
  const keepAlive = setInterval(() => {
    try { res.write(': keepalive\n\n'); } catch { clearInterval(keepAlive); }
  }, 20_000);

  // Subscribe to job updates
  const cb = (event: string, data: unknown) => {
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch { /* connection closed */ }
    if (event === 'result' || event === 'error') {
      cleanup();
      res.end();
    }
  };
  subscribeToJob(req.params.jobId, cb);

  const cleanup = () => {
    clearInterval(keepAlive);
    unsubscribeFromJob(req.params.jobId, cb);
  };

  req.on('close', cleanup);
  req.on('error', cleanup);
});

export default router;
