import { Router, Request, Response } from 'express';
import { aiLimiter } from '../middleware/rateLimiter.js';
import { registerJobStart, extractLabel } from '../services/reportRegistry';
import {
  createVucaJob,
  getVucaJob,
  runVucaAnalysis,
  subscribeToVucaJob,
  unsubscribeFromVucaJob,
} from '../services/vucaAnalysisService.js';
import { dedupeJobStart } from '../services/jobDedupe';

const router = Router();

/** POST /api/vuca-analysis — start analysis */
router.post('/', aiLimiter, (req: Request, res: Response): void => {
  const { industry, geography } = req.body;
  if (!industry || typeof industry !== 'string' || !industry.trim()) {
    res.status(400).json({ error: 'industry is required' });
    return;
  }
  if (!geography || typeof geography !== 'string' || !geography.trim()) {
    res.status(400).json({ error: 'geography is required' });
    return;
  }

  const { companyName, companyDomain } = req.body;
  const params = {
    industry: industry.trim().slice(0, 200),
    geography: geography.trim().slice(0, 100),
    companyName: typeof companyName === 'string' ? companyName.trim().slice(0, 200) : undefined,
    companyDomain: typeof companyDomain === 'string' ? companyDomain.trim().slice(0, 200) : undefined,
  };

  const { jobId, isNew } = dedupeJobStart(
    'vuca-analysis',
    params,
    (id) => getVucaJob(id)?.status,
    (status) => status === 'error',
    () => createVucaJob(params)
  );
  if (isNew) {
    registerJobStart('vuca-analysis', jobId, extractLabel(req.body));
    runVucaAnalysis(jobId).catch((err) =>
      console.error('[vucaAnalysis] Unhandled error:', err)
    );
  }

  res.status(202).json({ jobId });
});

/** GET /api/vuca-analysis/:jobId — snapshot */
router.get('/:jobId', (req: Request, res: Response): void => {
  const job = getVucaJob(req.params.jobId);
  if (!job) { res.status(404).json({ error: 'Job not found' }); return; }
  res.json(job);
});

/** GET /api/vuca-analysis/:jobId/stream — SSE */
router.get('/:jobId/stream', (req: Request, res: Response): void => {
  const job = getVucaJob(req.params.jobId);
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
  const cleanup = () => { clearInterval(keepAlive); unsubscribeFromVucaJob(req.params.jobId, cb); };

  subscribeToVucaJob(req.params.jobId, cb);
  req.on('close', cleanup);
  req.on('error', cleanup);
});

export default router;
