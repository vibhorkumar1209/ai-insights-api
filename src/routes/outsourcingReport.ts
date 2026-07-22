import { Router, Request, Response } from 'express';
import { aiLimiter } from '../middleware/rateLimiter';
import {
  createOutsourcingReportJob,
  getOutsourcingReportJob,
  runOutsourcingReportJob,
  subscribeToJob,
  unsubscribeFromJob,
} from '../services/outsourcingReportService';

const router = Router();

// POST /api/industry-outsourcing-report — create and start a blueprint generation job
router.post('/', aiLimiter, (req: Request, res: Response) => {
  const { vendorName, targetIndustry, geoFocus, focusTech, focusSegment } = req.body;

  if (!vendorName?.trim() || !targetIndustry?.trim() || !geoFocus?.trim()) {
    res.status(400).json({ error: 'vendorName, targetIndustry, and geoFocus are required' });
    return;
  }

  // focusTech/focusSegment are optional — when omitted, let Claude use its own
  // judgement to pick the single most relevant one for this vendor/industry/geo.
  const input = {
    vendorName: vendorName.trim(),
    targetIndustry: targetIndustry.trim(),
    geoFocus: geoFocus.trim(),
    focusTech: focusTech?.trim() || 'the most transformative technology for this vertical (use your own judgement to select the single most relevant one)',
    focusSegment: focusSegment?.trim() || 'the most attractive target segment for this vertical (use your own judgement to select the single most relevant one)',
  };

  const jobId = createOutsourcingReportJob(input);
  runOutsourcingReportJob(jobId, input).catch(() => {});
  res.status(202).json({ jobId });
});

// GET /api/industry-outsourcing-report/:jobId — snapshot
router.get('/:jobId', (req: Request, res: Response) => {
  const job = getOutsourcingReportJob(req.params.jobId);
  if (!job) { res.status(404).json({ error: 'Job not found' }); return; }
  res.json(job);
});

// GET /api/industry-outsourcing-report/:jobId/stream — SSE
router.get('/:jobId/stream', (req: Request, res: Response) => {
  const job = getOutsourcingReportJob(req.params.jobId);
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
