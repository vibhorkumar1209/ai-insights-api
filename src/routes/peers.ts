import { Router, Request, Response } from 'express';
import { PeersInput } from '@ai-insights/types';
import {
  createPeersJob,
  getPeersJob,
  runPeersJob,
  subscribeToJob,
  unsubscribeFromJob,
} from '../services/peersService';
import { aiLimiter } from '../middleware/rateLimiter';
import { registerJobStart, extractLabel } from '../services/reportRegistry';
import { dedupeJobStart } from '../services/jobDedupe';

const router = Router();

/**
 * POST /api/peers — start a Peers discovery job (async job + SSE).
 *
 * This is the dedicated Peers page's endpoint — distinct from
 * /api/competitors (routes/competitors.ts), which is a lighter-weight
 * synchronous discovery call still used by Peer Benchmarking's setup
 * wizard. Splitting these avoids the Peers page's full pipeline (with
 * progress feedback, retry-safe SSE) fighting the wizard's need for a
 * quick synchronous list, while both share the same discoverCompetitorsFast
 * synthesis underneath.
 *
 * Body: { targetCompany: string, companyDomain: string, industryContext?: string }
 * Returns: { jobId }
 */
router.post('/', aiLimiter, (req: Request, res: Response): void => {
  const { targetCompany, industryContext, companyDomain } = req.body;

  if (!targetCompany || typeof targetCompany !== 'string') {
    res.status(400).json({ error: 'targetCompany is required and must be a string' });
    return;
  }
  if (!companyDomain || typeof companyDomain !== 'string' || !companyDomain.trim()) {
    res.status(400).json({ error: 'companyDomain is required — it is used to verify company identity before researching peers, since company names are frequently shared by unrelated businesses' });
    return;
  }
  if (targetCompany.length > 200 || (industryContext && String(industryContext).length > 500)) {
    res.status(400).json({ error: 'Input too long' });
    return;
  }

  const input: PeersInput = {
    targetCompany: targetCompany.trim(),
    companyDomain: companyDomain.trim(),
    industryContext: typeof industryContext === 'string' && industryContext.trim() ? industryContext.trim() : undefined,
  };

  const { jobId, isNew } = dedupeJobStart(
    'peers',
    input,
    (id) => getPeersJob(id)?.status,
    (status) => status === 'error',
    () => createPeersJob()
  );
  if (isNew) {
    registerJobStart('peers', jobId, extractLabel(req.body) || input.targetCompany);
    runPeersJob(jobId, input).catch((err) =>
      console.error(`[peers] Job ${jobId} failed:`, err)
    );
  }

  res.status(202).json({ jobId });
});

/** GET /api/peers/:jobId — snapshot */
router.get('/:jobId', (req: Request, res: Response): void => {
  const job = getPeersJob(req.params.jobId);
  if (!job) { res.status(404).json({ error: 'Job not found' }); return; }
  res.json(job);
});

/** GET /api/peers/:jobId/stream — SSE */
router.get('/:jobId/stream', (req: Request, res: Response): void => {
  const job = getPeersJob(req.params.jobId);
  if (!job) { res.status(404).json({ error: 'Job not found' }); return; }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  if (job.status === 'complete' || job.status === 'error') {
    res.write(`event: ${job.status === 'complete' ? 'result' : 'error'}\ndata: ${JSON.stringify(job)}\n\n`);
    res.end();
    return;
  }

  res.flushHeaders();
  res.write(`event: progress\ndata: ${JSON.stringify(job)}\n\n`);

  const keepAlive = setInterval(() => {
    try {
      res.write(': keepalive\n\n');
    } catch {
      clearInterval(keepAlive);
    }
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
