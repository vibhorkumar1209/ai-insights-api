import { Router, Request, Response } from 'express';
import { ChallengesGrowthInput } from '../types';
import {
  createChallengesGrowthJob,
  getChallengesGrowthJob,
  runChallengesGrowth,
  subscribeToJob,
  unsubscribeFromJob,
} from '../services/challengesGrowthService';
import { aiLimiter } from '../middleware/rateLimiter';

const router = Router();

/** POST /api/challenges-growth — start analysis */
router.post('/', aiLimiter, async (req: Request, res: Response) => {
  const { companyName, userOrganization, solutionPortfolio } = req.body;

  if (!companyName || typeof companyName !== 'string') {
    return res.status(400).json({ error: 'companyName is required' });
  }

  const input: ChallengesGrowthInput = {
    companyName: String(companyName).slice(0, 200),
    userOrganization: userOrganization ? String(userOrganization).slice(0, 200) : undefined,
    solutionPortfolio: solutionPortfolio ? String(solutionPortfolio).slice(0, 1000) : undefined,
  };

  const jobId = createChallengesGrowthJob();
  runChallengesGrowth(jobId, input).catch((err) =>
    console.error(`[challenges-growth] Job ${jobId} failed:`, err)
  );

  return res.status(202).json({ jobId });
});

/** GET /api/challenges-growth/:jobId — snapshot */
router.get('/:jobId', (req: Request, res: Response) => {
  const job = getChallengesGrowthJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  return res.json(job);
});

/** GET /api/challenges-growth/:jobId/stream — SSE */
router.get('/:jobId/stream', (req: Request, res: Response) => {
  const job = getChallengesGrowthJob(req.params.jobId);
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

  const cb = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    if (event === 'result' || event === 'error') { cleanup(); res.end(); }
  };

  subscribeToJob(req.params.jobId, cb);
  const cleanup = () => unsubscribeFromJob(req.params.jobId, cb);
  req.on('close', cleanup);
  req.on('error', cleanup);
});

export default router;
