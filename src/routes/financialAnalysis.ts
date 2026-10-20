import { getReportPayload } from '../services/reportsAggregatorService';
import { Router, Request, Response } from 'express';
import { aiLimiter } from '../middleware/rateLimiter';
import {
  createFinancialJob,
  getFinancialJob,
  runFinancialAnalysis,
  subscribeToJob,
  unsubscribeFromJob,
  getJobManager as getFinancialJobManager,
} from '../services/financialAnalysisService';
import { FinancialAnalysisInput } from '@ai-insights/types';
import { handleJobError } from '../utils/jobErrorHandler';
import { registerJobStart, extractLabel } from '../services/reportRegistry';
import { dedupeJobStart } from '../services/jobDedupe';

const router = Router();

// ── POST /api/financial-analysis ─────────────────────────────────────────────
router.post('/', aiLimiter, (req: Request, res: Response): void => {
  const { companyName, companyDomain, isPublic } = req.body as FinancialAnalysisInput;

  if (!companyName || typeof companyName !== 'string' || !companyName.trim()) {
    res.status(400).json({ error: 'companyName is required' });
    return;
  }

  if (!companyDomain || typeof companyDomain !== 'string' || !companyDomain.trim()) {
    res.status(400).json({ error: 'companyDomain is required — it is used to verify the company\'s identity before researching financials, since company names are frequently shared by unrelated businesses' });
    return;
  }

  const input: FinancialAnalysisInput = {
    companyName: companyName.trim().slice(0, 200),
    companyDomain: typeof companyDomain === 'string' ? companyDomain.trim().slice(0, 100) : undefined,
    isPublic: typeof isPublic === 'boolean' ? isPublic : undefined,
  };

  const { jobId, isNew } = dedupeJobStart(
    'financial-analysis',
    input,
    (id) => getFinancialJob(id)?.status,
    (status) => status === 'error',
    () => createFinancialJob(input)
  );
  if (isNew) {
    registerJobStart('financial-analysis', jobId, extractLabel(req.body));
    // Run async (fire and forget)
    const manager = getFinancialJobManager();
    runFinancialAnalysis(jobId, input).catch((err: Error) => handleJobError(jobId, err, manager));
  }

  res.status(202).json({ jobId });
});

// ── GET /api/financial-analysis/:jobId ───────────────────────────────────────
// Jobs live in memory, so a restart (any deploy, any free-tier spin-down)
// deletes them. The RefractOne .NET API polls this endpoint, throws on a 404,
// and retries the same job every 60s indefinitely. A lost job is therefore
// answered as a terminal job state (200, status "error") that any poller
// already knows how to stop on, and a job that finished and was archived is
// still served from the archive instead of being reported missing.
router.get('/:jobId', (req: Request, res: Response): void => {
  const job = getFinancialJob(req.params.jobId) ?? getReportPayload(req.params.jobId);
  if (!job) {
    res.json({
      jobId: req.params.jobId,
      status: 'error',
      progress: 0,
      error: 'Job not found: it expired or was lost in a server restart before it finished. Start a new analysis.',
    });
    return;
  }
  res.json(job);
});

// ── GET /api/financial-analysis/:jobId/stream ────────────────────────────────
router.get('/:jobId/stream', (req: Request, res: Response): void => {
  const job = getFinancialJob(req.params.jobId);
  if (!job) { res.status(404).json({ error: 'Job not found' }); return; }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const send = (event: string, data: unknown) => {
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* closed */ }
  };

  // If already terminal, send immediately
  if (job.status === 'complete') { send('result', job); res.end(); return; }
  if (job.status === 'error') { send('error', job); res.end(); return; }

  // Keepalive heartbeat — prevents Railway/Nginx from killing idle SSE connections
  // during long-running operations (Yahoo Finance + Parallel.AI + Claude can take 2–3 min)
  const keepAlive = setInterval(() => {
    try { res.write(': keepalive\n\n'); } catch { clearInterval(keepAlive); }
  }, 20_000);

  const cleanup = () => {
    clearInterval(keepAlive);
    unsubscribeFromJob(req.params.jobId, cb);
  };

  const cb = (event: string, data: unknown) => {
    send(event, data);
    if (event === 'result' || event === 'error') { cleanup(); res.end(); }
  };

  subscribeToJob(req.params.jobId, cb);

  const onClose = () => cleanup();
  req.on('close', onClose);
  req.on('error', onClose);
});

export default router;
