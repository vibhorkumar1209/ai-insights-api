import { Router, Request, Response } from 'express';
import { aiLimiter } from '../middleware/rateLimiter';
import {
  createBusinessSegmentsJob,
  getBusinessSegmentsJob,
  runBusinessSegmentsAnalysis,
  subscribeToJob,
  unsubscribeFromJob,
  getJobManager as getSegmentsJobManager,
} from '../services/businessSegmentsService';
import { handleJobError } from '../utils/jobErrorHandler';

const router = Router();

// ── POST /api/business-segments ─────────────────────────────────────────────
router.post('/', aiLimiter, (req: Request, res: Response): void => {
  const { companyName, companyDomain } = req.body;

  if (!companyName || typeof companyName !== 'string' || !companyName.trim()) {
    res.status(400).json({ error: 'companyName is required' });
    return;
  }

  const jobId = createBusinessSegmentsJob(
    companyName.trim().slice(0, 200),
    typeof companyDomain === 'string' ? companyDomain.trim().slice(0, 100) : undefined
  );

  // Run async (fire and forget)
  const manager = getSegmentsJobManager();
  runBusinessSegmentsAnalysis(jobId, companyName.trim(), companyDomain).catch((err: Error) =>
    handleJobError(jobId, err, manager)
  );

  res.status(202).json({ jobId });
});

// ── GET /api/business-segments/:jobId ───────────────────────────────────────
router.get('/:jobId', (req: Request, res: Response): void => {
  const job = getBusinessSegmentsJob(req.params.jobId);
  if (!job) { res.status(404).json({ error: 'Job not found' }); return; }
  res.json(job);
});

// ── GET /api/business-segments/:jobId/stream ────────────────────────────────
router.get('/:jobId/stream', (req: Request, res: Response): void => {
  const jobId = req.params.jobId;
  const job = getBusinessSegmentsJob(jobId);
  if (!job) { res.status(404).json({ error: 'Job not found' }); return; }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const sendEvent = (event: string, data: unknown) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  subscribeToJob(jobId, sendEvent);

  // Send initial state
  sendEvent('progress', job);

  req.on('close', () => unsubscribeFromJob(jobId, sendEvent));
});

export default router;
