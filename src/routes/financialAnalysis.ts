import { Router, Request, Response } from 'express';
import { aiLimiter } from '../middleware/rateLimiter';
import {
  createFinancialJob,
  getFinancialJob,
  runFinancialAnalysis,
  subscribeToJob,
  unsubscribeFromJob,
} from '../services/financialAnalysisService';
import { FinancialAnalysisInput } from '../types';

const router = Router();

// ── POST /api/financial-analysis ─────────────────────────────────────────────
router.post('/', aiLimiter, (req: Request, res: Response): void => {
  const { companyName, companyDomain, isPublic } = req.body as FinancialAnalysisInput;

  if (!companyName || typeof companyName !== 'string' || !companyName.trim()) {
    res.status(400).json({ error: 'companyName is required' });
    return;
  }

  const jobId = createFinancialJob({
    companyName: companyName.trim().slice(0, 200),
    companyDomain: typeof companyDomain === 'string' ? companyDomain.trim().slice(0, 100) : undefined,
    isPublic: typeof isPublic === 'boolean' ? isPublic : undefined,
  });

  // Run async (fire and forget)
  runFinancialAnalysis(jobId, {
    companyName: companyName.trim().slice(0, 200),
    companyDomain: typeof companyDomain === 'string' ? companyDomain.trim().slice(0, 100) : undefined,
    isPublic: typeof isPublic === 'boolean' ? isPublic : undefined,
  }).catch((err: Error) => console.error('[financialAnalysis] unhandled error:', err.message));

  res.status(202).json({ jobId });
});

// ── GET /api/financial-analysis/:jobId ───────────────────────────────────────
router.get('/:jobId', (req: Request, res: Response): void => {
  const job = getFinancialJob(req.params.jobId);
  if (!job) { res.status(404).json({ error: 'Job not found' }); return; }
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
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // If already terminal, send immediately
  if (job.status === 'complete') { send('result', job); res.end(); return; }
  if (job.status === 'error') { send('error', job); res.end(); return; }

  const cb = (event: string, data: unknown) => {
    send(event, data);
    if (event === 'result' || event === 'error') { unsubscribeFromJob(req.params.jobId, cb); res.end(); }
  };

  subscribeToJob(req.params.jobId, cb);

  const onClose = () => unsubscribeFromJob(req.params.jobId, cb);
  req.on('close', onClose);
  req.on('error', onClose);
});

export default router;
