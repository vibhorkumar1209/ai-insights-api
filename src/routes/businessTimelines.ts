import { Router, Request, Response } from 'express';
import { aiLimiter } from '../middleware/rateLimiter';
import {
  createBusinessTimelinesJob,
  getBusinessTimelinesJob,
  runBusinessTimelinesAnalysis,
  subscribeToJob,
  unsubscribeFromJob,
  getJobManager as getTimelinesJobManager,
} from '../services/businessTimelinesService';
import { handleJobError } from '../utils/jobErrorHandler';
import { registerJobStart, extractLabel } from '../services/reportRegistry';
import { dedupeJobStart } from '../services/jobDedupe';

const router = Router();

// ── POST /api/business-timelines ────────────────────────────────────────────
router.post('/', aiLimiter, (req: Request, res: Response): void => {
  const { companyName, companyDomain } = req.body;

  if (!companyName || typeof companyName !== 'string' || !companyName.trim()) {
    res.status(400).json({ error: 'companyName is required' });
    return;
  }

  const name = companyName.trim().slice(0, 200);
  const domain = typeof companyDomain === 'string' ? companyDomain.trim().slice(0, 100) : undefined;

  const { jobId, isNew } = dedupeJobStart(
    'business-timelines',
    { companyName: name, companyDomain: domain },
    (id) => getBusinessTimelinesJob(id)?.status,
    (status) => status === 'error',
    () => createBusinessTimelinesJob(name, domain)
  );
  if (isNew) {
    registerJobStart('business-timelines', jobId, extractLabel(req.body));
    // Run async (fire and forget)
    const manager = getTimelinesJobManager();
    runBusinessTimelinesAnalysis(jobId, name, domain).catch((err: Error) =>
      handleJobError(jobId, err, manager)
    );
  }

  res.status(202).json({ jobId });
});

// ── GET /api/business-timelines/:jobId ──────────────────────────────────────
router.get('/:jobId', (req: Request, res: Response): void => {
  const job = getBusinessTimelinesJob(req.params.jobId);
  if (!job) { res.status(404).json({ error: 'Job not found' }); return; }
  res.json(job);
});

// ── GET /api/business-timelines/:jobId/stream ───────────────────────────────
router.get('/:jobId/stream', (req: Request, res: Response): void => {
  const jobId = req.params.jobId;
  const job = getBusinessTimelinesJob(jobId);
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
