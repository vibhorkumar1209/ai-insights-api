import { Router, Request, Response } from 'express';
import { aiLimiter } from '../middleware/rateLimiter.js';
import {
  createConsultingIntelligenceJob,
  getConsultingIntelligenceJob,
  runConsultingIntelligenceAnalysis,
  subscribeToConsultingJob,
  unsubscribeFromConsultingJob,
} from '../services/consultingIntelligenceService.js';

const router = Router();

const VALID_GEOGRAPHIES = [
  'Global', 'North America', 'Europe', 'India', 'ASEAN', 'Middle East',
  'Latin America', 'US + UK + Germany',
];

/** POST /api/consulting-intelligence — start analysis */
router.post('/', aiLimiter, (req: Request, res: Response): void => {
  const { topic, geography } = req.body;

  if (!topic || typeof topic !== 'string' || !topic.trim()) {
    res.status(400).json({ error: 'topic is required' });
    return;
  }

  const geoValue = typeof geography === 'string' && VALID_GEOGRAPHIES.includes(geography)
    ? geography
    : 'Global';

  const jobId = createConsultingIntelligenceJob({
    topic: topic.trim().slice(0, 2000),
    geography: geoValue,
  });

  runConsultingIntelligenceAnalysis(jobId).catch((err) =>
    console.error('[consultingIntelligence] Unhandled error:', err)
  );

  res.status(202).json({ jobId });
});

/** GET /api/consulting-intelligence/:jobId — snapshot */
router.get('/:jobId', (req: Request, res: Response): void => {
  const job = getConsultingIntelligenceJob(req.params.jobId);
  if (!job) { res.status(404).json({ error: 'Job not found' }); return; }
  res.json(job);
});

/** GET /api/consulting-intelligence/:jobId/stream — SSE */
router.get('/:jobId/stream', (req: Request, res: Response): void => {
  const job = getConsultingIntelligenceJob(req.params.jobId);
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
    unsubscribeFromConsultingJob(req.params.jobId, cb);
  };

  subscribeToConsultingJob(req.params.jobId, cb);
  req.on('close', cleanup);
  req.on('error', cleanup);
});

export default router;
