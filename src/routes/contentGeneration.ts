import { Router, Request, Response } from 'express';
import { aiLimiter } from '../middleware/rateLimiter';
import {
  createContentGenerationJob,
  getContentGenerationJob,
  runContentGeneration,
  subscribeToJob,
  unsubscribeFromJob,
} from '../services/contentGenerationService';
import { ContentGenerationInput } from '@ai-insights/types';
import { registerJobStart, extractLabel } from '../services/reportRegistry';

const router = Router();

/** POST /api/content-generation — start job */
router.post('/', aiLimiter, (req: Request, res: Response): void => {
  const input: ContentGenerationInput = req.body;

  if (!input.moduleType || !['industry-blog', 'industry-thought-leadership'].includes(input.moduleType)) {
    res.status(400).json({ error: 'moduleType must be industry-blog or industry-thought-leadership' });
    return;
  }
  if (!input.voice || !['first_person', 'third_person'].includes(input.voice)) {
    res.status(400).json({ error: 'voice is required (first_person | third_person)' });
    return;
  }
  if (!input.tone || !['professional', 'smart_casual'].includes(input.tone)) {
    res.status(400).json({ error: 'tone is required (professional | smart_casual)' });
    return;
  }
  if (!input.perspective || !['practitioner', 'analyst'].includes(input.perspective)) {
    res.status(400).json({ error: 'perspective is required (practitioner | analyst)' });
    return;
  }
  if (!input.wordCount || typeof input.wordCount !== 'number') {
    res.status(400).json({ error: 'wordCount is required' });
    return;
  }

  const jobId = createContentGenerationJob();
  // Registered under the actual sub-module (industry-blog /
  // industry-thought-leadership), not the generic 'content-generation'
  // route name — this route serves both off one endpoint, and the
  // frontend's per-module History hydration (apiReports.ts) branches on
  // exactly this moduleType string, the same way it branches on
  // marketing-strategy's VUCA-vs-standard-framework result shape.
  registerJobStart(input.moduleType, jobId, input.industryReportData?.query || extractLabel(req.body));
  runContentGeneration(jobId, input).catch((err) =>
    console.error('[contentGeneration] Unhandled error:', err)
  );
  res.status(202).json({ jobId });
});

/** GET /api/content-generation/:jobId — snapshot */
router.get('/:jobId', (req: Request, res: Response): void => {
  const job = getContentGenerationJob(req.params.jobId);
  if (!job) {
    res.status(404).json({ error: 'Job not found' });
    return;
  }
  res.json(job);
});

/** GET /api/content-generation/:jobId/stream — SSE */
router.get('/:jobId/stream', (req: Request, res: Response): void => {
  const job = getContentGenerationJob(req.params.jobId);
  if (!job) {
    res.status(404).json({ error: 'Job not found' });
    return;
  }

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
    try {
      res.write(': keepalive\n\n');
    } catch {
      clearInterval(keepAlive);
    }
  }, 20_000);

  const cb = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    if (event === 'result' || event === 'error') {
      cleanup();
      res.end();
    }
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
