import { Router, Request, Response } from 'express';
import { ThemeInput, ThemeType } from '@ai-insights/types';
import {
  createThemeJob,
  getThemeJob,
  runThemesAnalysis,
  subscribeToThemeJob,
  unsubscribeFromThemeJob,
} from '../services/themesService';
import { aiLimiter } from '../middleware/rateLimiter';

const router = Router();

const VALID_THEME_TYPES: ThemeType[] = ['business', 'technology', 'sustainability'];

/**
 * POST /api/themes
 * Start a new themes analysis job.
 * Body: { companyName, themeType, userOrganization?, solutionPortfolio? }
 * Returns: { jobId }
 */
router.post('/', aiLimiter, async (req: Request, res: Response) => {
  const { companyName, themeType, userOrganization, solutionPortfolio, companyDomain } = req.body;

  if (!companyName || typeof companyName !== 'string') {
    return res.status(400).json({ error: 'companyName is required' });
  }

  if (!themeType || !VALID_THEME_TYPES.includes(themeType as ThemeType)) {
    return res.status(400).json({
      error: `themeType must be one of: ${VALID_THEME_TYPES.join(', ')}`,
    });
  }

  const input: ThemeInput = {
    companyName: String(companyName).slice(0, 200),
    themeType: themeType as ThemeType,
    userOrganization: userOrganization ? String(userOrganization).slice(0, 200) : undefined,
    solutionPortfolio: solutionPortfolio ? String(solutionPortfolio).slice(0, 1000) : undefined,
    companyDomain: companyDomain ? String(companyDomain).slice(0, 200) : undefined,
  };

  const jobId = createThemeJob();

  runThemesAnalysis(jobId, input).catch((err) => {
    console.error(`[themes] Job ${jobId} failed:`, err);
  });

  return res.status(202).json({ jobId });
});

/**
 * GET /api/themes/:jobId
 * Get the current state of a themes job.
 */
router.get('/:jobId', (req: Request, res: Response) => {
  const job = getThemeJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  return res.json(job);
});

/**
 * GET /api/themes/:jobId/stream
 * Server-Sent Events stream for real-time themes job progress.
 */
router.get('/:jobId/stream', (req: Request, res: Response) => {
  const job = getThemeJob(req.params.jobId);
  if (!job) {
    res.status(404).json({ error: 'Job not found' });
    return;
  }

  if (job.status === 'complete' || job.status === 'error') {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    const event = job.status === 'complete' ? 'result' : 'error';
    res.write(`event: ${event}\ndata: ${JSON.stringify(job)}\n\n`);
    res.end();
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  res.write(`event: progress\ndata: ${JSON.stringify(job)}\n\n`);

  const cb = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    if (event === 'result' || event === 'error') {
      cleanup();
      res.end();
    }
  };

  subscribeToThemeJob(req.params.jobId, cb);

  const cleanup = () => unsubscribeFromThemeJob(req.params.jobId, cb);
  req.on('close', cleanup);
  req.on('error', cleanup);
});

export default router;
