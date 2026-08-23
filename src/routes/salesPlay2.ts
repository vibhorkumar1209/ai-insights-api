import { Router, Request, Response } from 'express';
import { aiLimiter } from '../middleware/rateLimiter';
import { SalesPlay2Input } from '@ai-insights/types';
import { registerJobStart, extractLabel } from '../services/reportRegistry';
import {
  createSalesPlay2Job,
  runSalesPlay2,
  getSalesPlay2Job,
  subscribeToJob,
  unsubscribeFromJob,
} from '../services/salesPlay2Service';

const router = Router();

router.post('/', aiLimiter, (req: Request, res: Response) => {
  const { yourCompany, competitorName, targetAccount, targetIndustry, strategicPriorities, solutionAreas, competitorWeaknesses } = req.body;
  if (!yourCompany?.trim() || !competitorName?.trim() || !targetAccount?.trim() || !targetIndustry?.trim()) {
    res.status(400).json({ error: 'yourCompany, competitorName, targetAccount, and targetIndustry are required' });
    return;
  }
  const parsedPriorities: string[] = Array.isArray(strategicPriorities)
    ? strategicPriorities.map((p: string) => p.trim()).filter(Boolean) : [];
  const input: SalesPlay2Input = {
    yourCompany: yourCompany.trim(),
    competitorName: competitorName.trim(),
    targetAccount: targetAccount.trim(),
    targetIndustry: targetIndustry.trim(),
    strategicPriorities: parsedPriorities.length > 0 ? parsedPriorities : undefined,
    solutionAreas: solutionAreas?.trim() || undefined,
    competitorWeaknesses: competitorWeaknesses?.trim() || undefined,
  };
  const jobId = createSalesPlay2Job(input);
  registerJobStart('sales-play-2', jobId, extractLabel(req.body));
  runSalesPlay2(jobId, input).catch((err) => console.error('[salesPlay2] Unhandled error:', err));
  res.status(202).json({ jobId });
});

router.get('/:jobId', (req: Request, res: Response) => {
  const job = getSalesPlay2Job(req.params.jobId);
  if (!job) { res.status(404).json({ error: 'Job not found' }); return; }
  res.json(job);
});

router.get('/:jobId/stream', (req: Request, res: Response) => {
  const { jobId } = req.params;
  const job = getSalesPlay2Job(jobId);
  if (!job) { res.status(404).json({ error: 'Job not found' }); return; }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const cb = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    if (event === 'result' || event === 'error') res.end();
  };

  subscribeToJob(jobId, cb);
  if (job.status === 'complete') { cb('result', job); return; }
  if (job.status === 'error') { cb('error', job); return; }
  req.on('close', () => unsubscribeFromJob(jobId, cb));
});

export default router;
