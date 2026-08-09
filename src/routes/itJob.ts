import { Router, Request, Response } from 'express';
import { aiLimiter } from '../middleware/rateLimiter';
import { createItJobJob, getItJobJob, runItJobSearch, subscribeToJob, unsubscribeFromJob } from '../services/itJobService';
import { normalizeDomain } from '../services/yahooFinance';

const router = Router();

// Accepts either a bare handle ("stripe") or a full URL in any of the forms
// LinkedIn/users commonly paste (linkedin.com/company/stripe,
// https://www.linkedin.com/company/stripe/jobs/, etc.) and extracts just the
// handle segment, so the research query can build a precise jobs-page URL
// regardless of what shape the user typed.
function normalizeLinkedinHandle(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const companyMatch = trimmed.match(/linkedin\.com\/company\/([^/?#]+)/i);
  if (companyMatch) return companyMatch[1];
  // Bare handle — strip any accidental leading/trailing slashes or "@"
  return trimmed.replace(/^\/+|\/+$/g, '').replace(/^@/, '') || undefined;
}

// POST /api/it-jobs — create and start an IT/Software Engineering job-market search
router.post('/', aiLimiter, (req: Request, res: Response) => {
  const { companyName, companyDomain, linkedinHandle } = req.body;

  if (!companyName || typeof companyName !== 'string' || companyName.trim().length < 2) {
    res.status(400).json({ error: 'companyName is required (min 2 characters)' });
    return;
  }
  if (!companyDomain || typeof companyDomain !== 'string' || !companyDomain.trim()) {
    res.status(400).json({ error: 'companyDomain is required — used to anchor search results to the correct company' });
    return;
  }

  const normalizedDomain = normalizeDomain(companyDomain);
  if (!normalizedDomain) {
    res.status(400).json({ error: 'companyDomain is not a valid domain' });
    return;
  }

  const normalizedLinkedinHandle = typeof linkedinHandle === 'string' ? normalizeLinkedinHandle(linkedinHandle) : undefined;

  const input = { companyName: companyName.trim(), companyDomain: normalizedDomain, linkedinHandle: normalizedLinkedinHandle };
  const jobId = createItJobJob(input);
  runItJobSearch(jobId, input).catch(() => {});
  res.status(202).json({ jobId });
});

// GET /api/it-jobs/:jobId — snapshot
router.get('/:jobId', (req: Request, res: Response) => {
  const job = getItJobJob(req.params.jobId);
  if (!job) { res.status(404).json({ error: 'Job not found' }); return; }
  res.json(job);
});

// GET /api/it-jobs/:jobId/stream — SSE
router.get('/:jobId/stream', (req: Request, res: Response) => {
  const job = getItJobJob(req.params.jobId);
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
