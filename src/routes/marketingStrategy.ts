import { Router, Request, Response } from 'express';
import { aiLimiter } from '../middleware/rateLimiter';
import { StrategyFramework } from '../types';
import {
  createMarketingStrategyJob,
  getMarketingStrategyJob,
  runMarketingStrategy,
  subscribeToJob,
  unsubscribeFromJob,
} from '../services/marketingStrategyService';

const VALID_FRAMEWORKS: StrategyFramework[] = [
  'BCG Matrix', 'SWOT', 'Porters Five Forces', 'Ansoff Matrix',
  '4P/7P Marketing Mix', 'AIDA', 'PESTEL', 'North Star',
  'Flywheel Model', 'Blue Ocean', '7S Framework',
  'GE-McKinsey Matrix', 'Eisenhower Matrix',
];

const router = Router();

/** POST /api/marketing-strategy — start analysis */
router.post('/', aiLimiter, (req: Request, res: Response): void => {
  const { industryOrSegment, framework, productContext, additionalContext } = req.body;

  if (!industryOrSegment || typeof industryOrSegment !== 'string' || !industryOrSegment.trim()) {
    res.status(400).json({ error: 'industryOrSegment is required' });
    return;
  }
  if (!framework || !VALID_FRAMEWORKS.includes(framework)) {
    res.status(400).json({ error: `framework must be one of: ${VALID_FRAMEWORKS.join(', ')}` });
    return;
  }

  const jobId = createMarketingStrategyJob();

  runMarketingStrategy(jobId, {
    industryOrSegment: industryOrSegment.trim().slice(0, 300),
    framework,
    productContext: typeof productContext === 'string' && productContext.trim()
      ? productContext.trim().slice(0, 5000) : undefined,
    additionalContext: typeof additionalContext === 'string' && additionalContext.trim()
      ? additionalContext.trim().slice(0, 5000) : undefined,
  }).catch((err) => console.error('[marketingStrategy] Unhandled error:', err));

  res.status(202).json({ jobId });
});

/** GET /api/marketing-strategy/:jobId — snapshot */
router.get('/:jobId', (req: Request, res: Response): void => {
  const job = getMarketingStrategyJob(req.params.jobId);
  if (!job) { res.status(404).json({ error: 'Job not found' }); return; }
  res.json(job);
});

/** GET /api/marketing-strategy/:jobId/stream — SSE */
router.get('/:jobId/stream', (req: Request, res: Response): void => {
  const job = getMarketingStrategyJob(req.params.jobId);
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
