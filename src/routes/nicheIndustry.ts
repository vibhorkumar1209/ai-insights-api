import { Router, Request, Response } from 'express';
import { aiLimiter } from '../middleware/rateLimiter';
import {
  createNicheIndustryJob,
  getNicheIndustryJob,
  runNicheIndustryAnalysis,
  subscribeToJob,
  unsubscribeFromJob,
} from '../services/nicheIndustryService';
import { NicheOutputMode, NicheSegmentationDepth } from '../types';

const router = Router();

const VALID_MODES: NicheOutputMode[] = ['white_space', 'bestseller', 'both'];
const VALID_DEPTHS: NicheSegmentationDepth[] = ['standard', 'deep'];
const VALID_CAGR = ['5', '8', '12', '18'];
const VALID_TOPICS = [8, 12, 16];

/** POST /api/niche-industries — start analysis */
router.post('/', aiLimiter, (req: Request, res: Response): void => {
  const {
    industryVertical,
    subSegmentOrTheme,
    geography,
    minimumCAGR,
    outputMode,
    additionalContext,
    numberOfTopics,
    segmentationDepth,
  } = req.body;

  if (!industryVertical || typeof industryVertical !== 'string' || !industryVertical.trim()) {
    res.status(400).json({ error: 'industryVertical is required' });
    return;
  }

  const jobId = createNicheIndustryJob();

  runNicheIndustryAnalysis(jobId, {
    industryVertical: industryVertical.trim().slice(0, 2000),
    subSegmentOrTheme: typeof subSegmentOrTheme === 'string' && subSegmentOrTheme.trim()
      ? subSegmentOrTheme.trim().slice(0, 1000) : undefined,
    geography: typeof geography === 'string' && geography.trim() ? geography.trim() : 'Global',
    minimumCAGR: VALID_CAGR.includes(String(minimumCAGR)) ? String(minimumCAGR) : '8',
    outputMode: VALID_MODES.includes(outputMode) ? outputMode : 'both',
    additionalContext: typeof additionalContext === 'string' && additionalContext.trim()
      ? additionalContext.trim().slice(0, 5000) : undefined,
    numberOfTopics: VALID_TOPICS.includes(Number(numberOfTopics)) ? Number(numberOfTopics) : 12,
    segmentationDepth: VALID_DEPTHS.includes(segmentationDepth) ? segmentationDepth : 'standard',
  }).catch((err) => console.error('[nicheIndustry] Unhandled error:', err));

  res.status(202).json({ jobId });
});

/** GET /api/niche-industries/:jobId — snapshot */
router.get('/:jobId', (req: Request, res: Response): void => {
  const job = getNicheIndustryJob(req.params.jobId);
  if (!job) { res.status(404).json({ error: 'Job not found' }); return; }
  res.json(job);
});

/** GET /api/niche-industries/:jobId/stream — SSE */
router.get('/:jobId/stream', (req: Request, res: Response): void => {
  const job = getNicheIndustryJob(req.params.jobId);
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
    unsubscribeFromJob(req.params.jobId, cb);
  };

  subscribeToJob(req.params.jobId, cb);
  req.on('close', cleanup);
  req.on('error', cleanup);
});

export default router;
