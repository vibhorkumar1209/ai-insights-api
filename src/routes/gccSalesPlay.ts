import { Router, Request, Response } from 'express';
import { aiLimiter } from '../middleware/rateLimiter';
import { registerJobStart, extractLabel } from '../services/reportRegistry';
import { dedupeJobStart } from '../services/jobDedupe';
import {
  createGccSalesPlayJob,
  getGccSalesPlayJob,
  runGccSalesPlayJob,
  subscribeToJob,
  unsubscribeFromJob,
} from '../services/gccSalesPlayService';

const router = Router();

// POST /api/gcc-sales-play — create and start a dossier generation job
router.post('/', aiLimiter, (req: Request, res: Response) => {
  const { targetCompany, advisoryFirm, targetGeoRegion, coreIndustrySegment } = req.body;

  if (!targetCompany?.trim() || !advisoryFirm?.trim() || !targetGeoRegion?.trim() || !coreIndustrySegment?.trim()) {
    res.status(400).json({ error: 'targetCompany, advisoryFirm, targetGeoRegion, and coreIndustrySegment are all required' });
    return;
  }

  const input = {
    targetCompany: targetCompany.trim(),
    advisoryFirm: advisoryFirm.trim(),
    targetGeoRegion: targetGeoRegion.trim(),
    coreIndustrySegment: coreIndustrySegment.trim(),
  };

  const { jobId, isNew } = dedupeJobStart(
    'gcc-sales-play',
    input,
    (id) => getGccSalesPlayJob(id)?.status,
    (status) => status === 'error',
    () => createGccSalesPlayJob(input)
  );
  if (isNew) {
    registerJobStart('gcc-sales-play', jobId, extractLabel(req.body));
    runGccSalesPlayJob(jobId, input).catch(() => {});
  }
  res.status(202).json({ jobId });
});

// GET /api/gcc-sales-play/:jobId — snapshot
router.get('/:jobId', (req: Request, res: Response) => {
  const job = getGccSalesPlayJob(req.params.jobId);
  if (!job) { res.status(404).json({ error: 'Job not found' }); return; }
  res.json(job);
});

// GET /api/gcc-sales-play/:jobId/stream — SSE
router.get('/:jobId/stream', (req: Request, res: Response) => {
  const job = getGccSalesPlayJob(req.params.jobId);
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
