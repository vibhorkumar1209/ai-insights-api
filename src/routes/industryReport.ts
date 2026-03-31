import { Router, Request, Response } from 'express';
import { aiLimiter } from '../middleware/rateLimiter';
import {
  createIndustryReportJob,
  getIndustryReportJob,
  runIndustryReport,
  runIndustryReportV2,
  scopeWithWizard,
  subscribeToJob,
  unsubscribeFromJob,
  abortJob,
} from '../services/industryReportService';

const router = Router();

// POST /api/industry-report — Start a new industry report
router.post('/', aiLimiter, (req: Request, res: Response) => {
  const { query, geography } = req.body;

  if (!query || typeof query !== 'string' || query.trim().length < 3) {
    res.status(400).json({ error: 'query is required (minimum 3 characters)' });
    return;
  }

  const input = {
    query: query.trim(),
    geography: geography?.trim() || undefined,
  };

  const jobId = createIndustryReportJob(input);
  runIndustryReport(jobId, input).catch((err) =>
    console.error(`[industryReport] Unhandled error for job ${jobId}:`, err)
  );

  res.status(202).json({ jobId });
});

// POST /api/industry-report/scope — Wizard: extract scope + suggest segments & players
router.post('/scope', aiLimiter, async (req: Request, res: Response) => {
  const { industry, subIndustry, focusAreas, geography, excludeRegion, query, selectedSections } = req.body;

  const effectiveQuery = industry || query;
  if (!effectiveQuery || typeof effectiveQuery !== 'string' || effectiveQuery.trim().length < 3) {
    res.status(400).json({ error: 'industry or query is required (minimum 3 characters)' });
    return;
  }

  try {
    const result = await scopeWithWizard({
      query: effectiveQuery.trim(),
      industry: industry?.trim() || undefined,
      subIndustry: subIndustry?.trim() || undefined,
      focusAreas: focusAreas || undefined,
      geography: geography?.trim() || undefined,
      excludeRegion: excludeRegion?.trim() || undefined,
      selectedSections: selectedSections || undefined,
    });
    res.json(result);
  } catch (err: unknown) {
    console.error('[industryReport] Scope wizard error:', err);
    const message = err instanceof Error ? err.message : 'Scope extraction failed';
    res.status(500).json({ error: message });
  }
});

// POST /api/industry-report/generate — Wizard: generate full report with selected segments & players
router.post('/generate', aiLimiter, (req: Request, res: Response) => {
  const { scope, selectedSegments, selectedPlayers, allPlayers } = req.body;

  if (!scope || !scope.industry) {
    res.status(400).json({ error: 'scope with industry is required' });
    return;
  }

  // Merge selections into scope
  const enrichedScope = {
    ...scope,
    selectedSections: scope.selectedSections || undefined,
    selectedSegments: selectedSegments || [],
    selectedPlayers: selectedPlayers || [],
    allPlayers: allPlayers || selectedPlayers || [],
  };

  const input = { query: scope.industry, geography: scope.geography };
  const jobId = createIndustryReportJob(input);
  runIndustryReportV2(jobId, enrichedScope).catch((err) =>
    console.error(`[industryReport] Unhandled V2 error for job ${jobId}:`, err)
  );

  res.status(202).json({ jobId });
});

// POST /api/industry-report/:jobId/abort — Cancel a running report
router.post('/:jobId/abort', (req: Request, res: Response) => {
  const success = abortJob(req.params.jobId);
  if (!success) {
    res.status(404).json({ error: 'Job not found or already finished' });
    return;
  }
  res.json({ message: 'Job aborted' });
});

// GET /api/industry-report/:jobId — Snapshot
router.get('/:jobId', (req: Request, res: Response) => {
  const job = getIndustryReportJob(req.params.jobId);
  if (!job) {
    res.status(404).json({ error: 'Job not found' });
    return;
  }
  res.json(job);
});

// GET /api/industry-report/:jobId/stream — SSE stream
router.get('/:jobId/stream', (req: Request, res: Response) => {
  const job = getIndustryReportJob(req.params.jobId);
  if (!job) {
    res.status(404).json({ error: 'Job not found' });
    return;
  }

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Send current state immediately
  res.write(`event: progress\ndata: ${JSON.stringify(job)}\n\n`);

  // If already complete, send result and close
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

  // Keepalive to prevent timeout on idle connections (Railway/Nginx)
  const keepAlive = setInterval(() => {
    try { res.write(': keepalive\n\n'); } catch { clearInterval(keepAlive); }
  }, 20_000);

  // Subscribe to job updates
  const cb = (event: string, data: unknown) => {
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch { /* connection closed */ }
    if (event === 'result' || event === 'error') {
      cleanup();
      res.end();
    }
  };
  subscribeToJob(req.params.jobId, cb);

  const cleanup = () => {
    clearInterval(keepAlive);
    unsubscribeFromJob(req.params.jobId, cb);
  };

  req.on('close', cleanup);
  req.on('error', cleanup);
});

export default router;
