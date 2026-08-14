import { Router, Request, Response } from 'express';
import { aiLimiter } from '../middleware/rateLimiter';
import {
  createCompetitionBenchmarkingJob, getCompetitionBenchmarkingJob, runCompetitionBenchmarking,
  subscribeToJob, unsubscribeFromJob,
} from '../services/competitionBenchmarkingService';
import { CompetitionBenchmarkingInput } from '@ai-insights/types';

const router = Router();

// POST /api/competition-benchmarking — create and start a benchmarking report job
router.post('/', aiLimiter, (req: Request, res: Response) => {
  const { userFirm, userDomain, focusSegment, focusTech, geoFocus, additionalContext, competitorList, selectedCompetitors } = req.body;

  if (!userFirm || typeof userFirm !== 'string' || userFirm.trim().length < 2) {
    res.status(400).json({ error: 'userFirm is required (min 2 characters)' });
    return;
  }
  if (!userDomain || typeof userDomain !== 'string' || userDomain.trim().length < 2) {
    res.status(400).json({ error: 'userDomain is required' });
    return;
  }
  if (competitorList !== undefined && !Array.isArray(competitorList)) {
    res.status(400).json({ error: 'competitorList must be an array of strings if provided' });
    return;
  }
  if (selectedCompetitors !== undefined) {
    if (!Array.isArray(selectedCompetitors) || selectedCompetitors.length > 5) {
      res.status(400).json({ error: 'selectedCompetitors must be an array of at most 5 strings' });
      return;
    }
  }

  const input: CompetitionBenchmarkingInput = {
    userFirm: userFirm.trim(),
    userDomain: userDomain.trim(),
    focusSegment: typeof focusSegment === 'string' && focusSegment.trim() ? focusSegment.trim() : undefined,
    focusTech: typeof focusTech === 'string' && focusTech.trim() ? focusTech.trim() : undefined,
    geoFocus: typeof geoFocus === 'string' && geoFocus.trim() ? geoFocus.trim() : undefined,
    additionalContext: typeof additionalContext === 'string' && additionalContext.trim() ? additionalContext.trim() : undefined,
    competitorList: Array.isArray(competitorList) ? competitorList.map(String).slice(0, 20) : undefined,
    selectedCompetitors: Array.isArray(selectedCompetitors) ? selectedCompetitors.map(String).slice(0, 5) : undefined,
  };

  const jobId = createCompetitionBenchmarkingJob(input);
  runCompetitionBenchmarking(jobId, input).catch(() => {});
  res.status(202).json({ jobId });
});

// GET /api/competition-benchmarking/:jobId — snapshot
router.get('/:jobId', (req: Request, res: Response) => {
  const job = getCompetitionBenchmarkingJob(req.params.jobId);
  if (!job) { res.status(404).json({ error: 'Job not found' }); return; }
  res.json(job);
});

// GET /api/competition-benchmarking/:jobId/stream — SSE
router.get('/:jobId/stream', (req: Request, res: Response) => {
  const job = getCompetitionBenchmarkingJob(req.params.jobId);
  if (!job) { res.status(404).json({ error: 'Job not found' }); return; }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  res.write(`event: progress\ndata: ${JSON.stringify(job)}\n\n`);

  if (job.status === 'complete') {
    res.write(`event: result\ndata: ${JSON.stringify(job)}\n\n`);
    res.end();
    return;
  }
  if (job.status === 'error') {
    res.write(`event: error\ndata: ${JSON.stringify({ error: job.error })}\n\n`);
    res.end();
    return;
  }

  // This pipeline can go multiple minutes with no progress event during the
  // research fan-out — same silent-connection-drop failure mode fixed for
  // Peer Benchmarking (commit 09c6f10). Keepalive from day one here.
  const keepAlive = setInterval(() => {
    try { res.write(': keepalive\n\n'); } catch { clearInterval(keepAlive); }
  }, 20_000);

  const cb = (event: string, data: unknown) => {
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* closed */ }
    if (event === 'result' || event === 'error') { cleanup(); res.end(); }
  };
  subscribeToJob(req.params.jobId, cb);

  const cleanup = () => { clearInterval(keepAlive); unsubscribeFromJob(req.params.jobId, cb); };
  req.on('close', cleanup);
  req.on('error', cleanup);
});

export default router;
