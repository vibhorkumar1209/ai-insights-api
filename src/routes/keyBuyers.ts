import { Router, Request, Response } from 'express';
import { aiLimiter } from '../middleware/rateLimiter';
import {
  createKeyBuyersJob,
  getKeyBuyersJob,
  runKeyBuyers,
  subscribeToJob,
  unsubscribeFromJob,
} from '../services/keyBuyersService';
import { KeyBuyersInput } from '../types';

const router = Router();

/** POST /api/key-buyers — start analysis */
router.post('/', aiLimiter, (req: Request, res: Response): void => {
  const { companyName, companyDomain } = req.body as KeyBuyersInput;

  if (!companyName || typeof companyName !== 'string' || !companyName.trim()) {
    res.status(400).json({ error: 'companyName is required' });
    return;
  }

  const input: KeyBuyersInput = {
    companyName: companyName.trim().slice(0, 200),
    companyDomain: typeof companyDomain === 'string' ? companyDomain.trim().slice(0, 100) : undefined,
  };

  const jobId = createKeyBuyersJob();

  // Fire-and-forget — result delivered via SSE
  runKeyBuyers(jobId, input).catch((err) =>
    console.error('[keyBuyers] Unhandled error:', err)
  );

  res.status(202).json({ jobId });
});

/** GET /api/key-buyers/:jobId — snapshot */
router.get('/:jobId', (req: Request, res: Response): void => {
  const job = getKeyBuyersJob(req.params.jobId);
  if (!job) { res.status(404).json({ error: 'Job not found' }); return; }
  res.json(job);
});

/** GET /api/key-buyers/:jobId/stream — SSE */
router.get('/:jobId/stream', (req: Request, res: Response): void => {
  const job = getKeyBuyersJob(req.params.jobId);
  if (!job) { res.status(404).json({ error: 'Job not found' }); return; }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  // If already terminal, send immediately
  if (job.status === 'complete' || job.status === 'error') {
    const evt = job.status === 'complete' ? 'result' : 'error';
    res.write(`event: ${evt}\ndata: ${JSON.stringify(job)}\n\n`);
    res.end();
    return;
  }

  res.flushHeaders();
  res.write(`event: progress\ndata: ${JSON.stringify(job)}\n\n`);

  // Keepalive heartbeat — research + synthesis can take 2-3 min
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
