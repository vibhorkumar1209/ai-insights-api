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
import { registerJobStart, extractLabel } from '../services/reportRegistry';
import { dedupeJobStart } from '../services/jobDedupe';

const router = Router();

const THEME_MODULE_TYPE: Record<ThemeType, string> = {
  business: 'business-themes',
  technology: 'technology-themes',
  sustainability: 'sustainability',
};

const VALID_THEME_TYPES: ThemeType[] = ['business', 'technology', 'sustainability'];

/**
 * POST /api/themes
 * Start a new themes analysis job.
 * Body: { companyName, themeType, companyDomain?, userOrganization?, userDomain?,
 *   solutionPortfolio?, industry? (business), keyTriggers? (business), focusTechnologies? (technology) }
 * Returns: { jobId }
 */
router.post('/', aiLimiter, async (req: Request, res: Response) => {
  const { companyName, themeType, userOrganization, solutionPortfolio, companyDomain,
    userDomain, industry, keyTriggers, focusTechnologies } = req.body;
  const opt = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);

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
    userOrganization: opt(userOrganization, 200),
    solutionPortfolio: opt(solutionPortfolio, 1000),
    companyDomain: opt(companyDomain, 200),
    userDomain: opt(userDomain, 200),
    // Each theme type only takes the inputs that apply to it.
    industry: themeType === 'business' ? opt(industry, 200) : undefined,
    keyTriggers: themeType === 'business' ? opt(keyTriggers, 1000) : undefined,
    focusTechnologies: themeType === 'technology' ? opt(focusTechnologies, 500) : undefined,
  };

  const { jobId, isNew } = dedupeJobStart(
    'themes',
    input,
    (id) => getThemeJob(id)?.status,
    (status) => status === 'error',
    () => createThemeJob()
  );
  if (isNew) {
    // One route serves all three theme types, but each is its own module in
    // the app. Registering every job as 'business-themes' made a
    // Sustainability or Technology run show up in Report History as another
    // Business Themes report, which looked like the same report being rebuilt.
    registerJobStart(THEME_MODULE_TYPE[input.themeType], jobId, extractLabel(req.body));
    runThemesAnalysis(jobId, input).catch((err) => {
      console.error(`[themes] Job ${jobId} failed:`, err);
    });
  }

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
