import { Router, Request, Response } from 'express';
import { BusinessSegmentInput, BattlecardInput } from '@ai-insights/types';
import {
  createBusinessSegmentJob,
  getBusinessSegmentJob,
  runBusinessSegment,
  startBattlecard,
  getBattlecard,
  subscribeToJob,
  unsubscribeFromJob,
} from '../services/businessSegmentService';
import { aiLimiter } from '../middleware/rateLimiter';
import { registerJobStart, extractLabel } from '../services/reportRegistry';
import { dedupeJobStart } from '../services/jobDedupe';

const router = Router();

const LINKEDIN_URL_PATTERN = /^https?:\/\/([a-z]{2,3}\.)?linkedin\.com\//i;

/**
 * POST /api/business-segment — start the segment dossier (phase 1)
 * Body: { companyName: string, companyDomain: string, linkedinUrl?: string }
 */
router.post('/', aiLimiter, (req: Request, res: Response): void => {
  const { companyName, companyDomain, linkedinUrl } = req.body;

  if (!companyName || typeof companyName !== 'string' || !companyName.trim()) {
    res.status(400).json({ error: 'companyName is required and must be a string' });
    return;
  }
  if (!companyDomain || typeof companyDomain !== 'string' || !companyDomain.trim()) {
    res.status(400).json({ error: 'companyDomain is required — it anchors company identity, since names are frequently shared by unrelated businesses' });
    return;
  }
  if (companyName.length > 200 || companyDomain.length > 200 || (linkedinUrl && String(linkedinUrl).length > 500)) {
    res.status(400).json({ error: 'Input too long' });
    return;
  }
  if (linkedinUrl && typeof linkedinUrl === 'string' && linkedinUrl.trim() && !LINKEDIN_URL_PATTERN.test(linkedinUrl.trim())) {
    res.status(400).json({ error: 'linkedinUrl must be a linkedin.com URL' });
    return;
  }

  const input: BusinessSegmentInput = {
    companyName: companyName.trim(),
    companyDomain: companyDomain.trim(),
    linkedinUrl: typeof linkedinUrl === 'string' && linkedinUrl.trim() ? linkedinUrl.trim() : undefined,
  };

  const { jobId, isNew } = dedupeJobStart(
    'business-segment',
    input,
    (id) => getBusinessSegmentJob(id)?.status,
    (status) => status === 'error',
    () => createBusinessSegmentJob()
  );
  if (isNew) {
    registerJobStart('business-segment', jobId, extractLabel(req.body) || input.companyName);
    runBusinessSegment(jobId, input).catch((err) =>
      console.error(`[business-segment] Job ${jobId} failed:`, err)
    );
  }

  res.status(202).json({ jobId });
});

/**
 * POST /api/business-segment/:jobId/battlecard — phase 2, for one segment of a finished dossier
 * Body: { segmentName, yourCompany, yourUrl, yourSolution, competitorName, competitorUrl }
 */
const BATTLECARD_FIELDS: (keyof BattlecardInput)[] = ['segmentName', 'yourCompany', 'yourUrl', 'yourSolution', 'competitorName', 'competitorUrl'];

router.post('/:jobId/battlecard', aiLimiter, (req: Request, res: Response): void => {
  const inputs = {} as BattlecardInput;
  for (const field of BATTLECARD_FIELDS) {
    const v = req.body?.[field];
    if (typeof v !== 'string' || !v.trim()) {
      res.status(400).json({ error: `${field} is required` });
      return;
    }
    if (v.length > 300) {
      res.status(400).json({ error: `${field} is too long` });
      return;
    }
    inputs[field] = v.trim();
  }

  const result = startBattlecard(req.params.jobId, inputs);
  if ('battlecard' in result) {
    res.status(202).json({ battlecardId: result.battlecard.battlecardId });
    return;
  }
  res.status(result.status).json({ error: result.error });
});

/** GET /api/business-segment/:jobId/battlecard/:battlecardId — poll one battlecard */
router.get('/:jobId/battlecard/:battlecardId', (req: Request, res: Response): void => {
  const card = getBattlecard(req.params.jobId, req.params.battlecardId);
  if (!card) { res.status(404).json({ error: 'Battlecard not found' }); return; }
  res.json(card);
});

/** GET /api/business-segment/:jobId — snapshot */
router.get('/:jobId', (req: Request, res: Response): void => {
  const job = getBusinessSegmentJob(req.params.jobId);
  if (!job) { res.status(404).json({ error: 'Job not found' }); return; }
  res.json(job);
});

/** GET /api/business-segment/:jobId/stream — SSE */
router.get('/:jobId/stream', (req: Request, res: Response): void => {
  const job = getBusinessSegmentJob(req.params.jobId);
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
