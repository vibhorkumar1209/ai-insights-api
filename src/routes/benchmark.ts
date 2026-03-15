import { Router, Request, Response } from 'express';
import { BenchmarkInput } from '../types';
import {
  createJob,
  getJob,
  runBenchmark,
  subscribeToJob,
  unsubscribeFromJob,
} from '../services/benchmarkService';
import { aiLimiter } from '../middleware/rateLimiter';

const router = Router();

/**
 * POST /api/benchmark
 * Start a new peer benchmarking job.
 *
 * Body: BenchmarkInput
 * Returns: { jobId: string }
 */
router.post('/', aiLimiter, async (req: Request, res: Response) => {
  const {
    userOrganization,
    targetCompany,
    industryContext,
    focusAreas,
    solutionPortfolio,
    additionalContext,
    selectedCompetitors,
  } = req.body;

  // Validate required fields
  if (!userOrganization || !targetCompany) {
    return res.status(400).json({
      error: 'userOrganization and targetCompany are required',
    });
  }

  if (!Array.isArray(selectedCompetitors) || selectedCompetitors.length === 0) {
    return res.status(400).json({
      error: 'selectedCompetitors must be a non-empty array (max 5)',
    });
  }

  if (selectedCompetitors.length > 5) {
    return res.status(400).json({ error: 'Maximum 5 competitors allowed' });
  }

  const input: BenchmarkInput = {
    userOrganization: String(userOrganization).slice(0, 200),
    targetCompany: String(targetCompany).slice(0, 200),
    industryContext: industryContext ? String(industryContext).slice(0, 500) : undefined,
    focusAreas: focusAreas ? String(focusAreas).slice(0, 500) : undefined,
    solutionPortfolio: solutionPortfolio ? String(solutionPortfolio).slice(0, 1000) : undefined,
    additionalContext: additionalContext ? String(additionalContext).slice(0, 2000) : undefined,
    selectedCompetitors: selectedCompetitors.map((c: unknown) => String(c).slice(0, 200)),
  };

  const jobId = createJob();

  // Run benchmark asynchronously — client streams progress via SSE
  runBenchmark(jobId, input).catch((err) => {
    console.error(`[benchmark] Job ${jobId} failed:`, err);
  });

  return res.status(202).json({ jobId });
});

/**
 * GET /api/benchmark/:jobId
 * Get the current state of a benchmarking job.
 */
router.get('/:jobId', (req: Request, res: Response) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  return res.json(job);
});

/**
 * GET /api/benchmark/:jobId/stream
 * Server-Sent Events stream for real-time job progress.
 */
router.get('/:jobId/stream', (req: Request, res: Response) => {
  const job = getJob(req.params.jobId);
  if (!job) {
    res.status(404).json({ error: 'Job not found' });
    return;
  }

  // If job is already complete, return snapshot immediately
  if (job.status === 'complete' || job.status === 'error') {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    const event = job.status === 'complete' ? 'result' : 'error';
    res.write(`event: ${event}\ndata: ${JSON.stringify(job)}\n\n`);
    res.end();
    return;
  }

  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable Nginx buffering
  res.flushHeaders();

  // Send current state immediately
  res.write(`event: progress\ndata: ${JSON.stringify(job)}\n\n`);

  const cb = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    if (event === 'result' || event === 'error') {
      cleanup();
      res.end();
    }
  };

  subscribeToJob(req.params.jobId, cb);

  const cleanup = () => {
    unsubscribeFromJob(req.params.jobId, cb);
  };

  req.on('close', cleanup);
  req.on('error', cleanup);
});

export default router;
