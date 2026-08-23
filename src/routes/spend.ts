import { Router, Request, Response } from 'express';
import { aiLimiter } from '../middleware/rateLimiter';
import { createSpendJob, getSpendJob, runSpendJob, subscribeToJob, unsubscribeFromJob } from '../services/spendService';
import { SPEND_CALCULATOR_INDUSTRIES } from '../services/claudeAI';
import { registerJobStart, extractLabel } from '../services/reportRegistry';

const router = Router();

// POST /api/spend — create and start a spend research job
// All 5 fields are mandatory: companyDomain/geography are rooted into the research
// query to disambiguate same-name companies; industry/revenueUsdMillion drive the
// benchmark formula deterministically (no auto-classification/auto-lookup fallback).
router.post('/', aiLimiter, (req: Request, res: Response) => {
  const { companyName, companyDomain, geography, industry, revenueUsdMillion } = req.body;

  if (!companyName || typeof companyName !== 'string' || companyName.trim().length < 2) {
    res.status(400).json({ error: 'companyName is required (min 2 characters)' });
    return;
  }
  if (!companyDomain || typeof companyDomain !== 'string' || !companyDomain.trim()) {
    res.status(400).json({ error: 'companyDomain is required — used to verify company identity before researching spend' });
    return;
  }
  if (!geography || typeof geography !== 'string' || !geography.trim()) {
    res.status(400).json({ error: 'geography is required — used to resolve the region adjustment and root the research query' });
    return;
  }
  if (!industry || typeof industry !== 'string' || !SPEND_CALCULATOR_INDUSTRIES.includes(industry.trim())) {
    res.status(400).json({ error: `industry is required and must be one of: ${SPEND_CALCULATOR_INDUSTRIES.join(', ')}` });
    return;
  }
  if (typeof revenueUsdMillion !== 'number' || !isFinite(revenueUsdMillion) || revenueUsdMillion <= 0) {
    res.status(400).json({ error: 'revenueUsdMillion is required and must be a positive number (annual revenue in USD millions)' });
    return;
  }

  const input = {
    companyName: companyName.trim(),
    companyDomain: companyDomain.trim(),
    geography: geography.trim(),
    industry: industry.trim(),
    revenueUsdMillion,
  };
  const jobId = createSpendJob(input);
  registerJobStart('spend', jobId, extractLabel(req.body));
  runSpendJob(jobId, input).catch(() => {});
  res.status(202).json({ jobId });
});

// GET /api/spend/:jobId — snapshot
router.get('/:jobId', (req: Request, res: Response) => {
  const job = getSpendJob(req.params.jobId);
  if (!job) { res.status(404).json({ error: 'Job not found' }); return; }
  res.json(job);
});

// GET /api/spend/:jobId/stream — SSE
router.get('/:jobId/stream', (req: Request, res: Response) => {
  const job = getSpendJob(req.params.jobId);
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
