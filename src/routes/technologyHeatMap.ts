import { Router, Request, Response } from 'express';
import { aiLimiter } from '../middleware/rateLimiter';
import {
  createTechnologyHeatMapJob,
  getTechnologyHeatMapJob,
  runTechnologyHeatMap,
  subscribeToJob,
  unsubscribeFromJob,
} from '../services/technologyHeatMapService';
import { discoverEmergingTechsQuick } from '../services/claudeAI';
import { TechHeatMapInput } from '@ai-insights/types';
import { registerJobStart, extractLabel } from '../services/reportRegistry';

const router = Router();

/** POST /api/technology-heat-map — start job */
router.post('/', aiLimiter, (req: Request, res: Response): void => {
  const input: TechHeatMapInput = req.body;

  if (!input.industry || typeof input.industry !== 'string' || !input.industry.trim()) {
    res.status(400).json({ error: 'industry is required' });
    return;
  }

  if (!input.geography || typeof input.geography !== 'string' || !input.geography.trim()) {
    res.status(400).json({ error: 'geography is required' });
    return;
  }

  if (!Array.isArray(input.technologies) || input.technologies.length === 0) {
    res.status(400).json({ error: 'technologies array must have at least 1 item' });
    return;
  }

  if (input.technologies.length > 12) {
    res.status(400).json({ error: 'Maximum 12 technologies allowed' });
    return;
  }

  const jobId = createTechnologyHeatMapJob();
  registerJobStart('technology-heat-map', jobId, extractLabel(req.body));

  runTechnologyHeatMap(jobId, input).catch((err) =>
    console.error('[technologyHeatMap] Unhandled error:', err)
  );

  res.status(202).json({ jobId });
});

/** GET /api/technology-heat-map/:jobId — snapshot */
router.get('/:jobId', (req: Request, res: Response): void => {
  const job = getTechnologyHeatMapJob(req.params.jobId);
  if (!job) {
    res.status(404).json({ error: 'Job not found' });
    return;
  }
  res.json(job);
});

/** GET /api/technology-heat-map/:jobId/stream — SSE */
router.get('/:jobId/stream', (req: Request, res: Response): void => {
  const job = getTechnologyHeatMapJob(req.params.jobId);
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

/** POST /api/technology-heat-map/discover-technologies — auto-populate techs for an industry */
router.post('/discover-technologies', aiLimiter, async (req: Request, res: Response): Promise<void> => {
  const { industry } = req.body;
  if (!industry) {
    res.status(400).json({ error: 'industry is required' });
    return;
  }

  try {
    console.log('[discover-technologies] Discovering technologies for industry:', industry);
    const technologies = await discoverEmergingTechsQuick(industry);
    console.log('[discover-technologies] Found', technologies.length, 'technologies');
    res.json({ technologies });
  } catch (error) {
    console.error('[discover-technologies] Error:', error);
    res.json({ technologies: getDefaultTechnologies() });
  }
});

function getDefaultTechnologies(): Array<{ name: string; category: string; maturityLevel: string }> {
  return [
    { name: 'AI/ML', category: 'Artificial Intelligence', maturityLevel: 'growth' },
    { name: 'Cloud Computing', category: 'Infrastructure', maturityLevel: 'mainstream' },
    { name: 'Cybersecurity', category: 'Security', maturityLevel: 'mainstream' },
    { name: 'RPA', category: 'Automation', maturityLevel: 'mainstream' },
    { name: 'IoT', category: 'Internet of Things', maturityLevel: 'growth' },
    { name: 'Big Data Analytics', category: 'Data', maturityLevel: 'mainstream' },
    { name: 'Blockchain', category: 'Distributed Ledger', maturityLevel: 'emerging' },
    { name: 'Edge Computing', category: 'Infrastructure', maturityLevel: 'growth' },
    { name: 'Quantum Computing', category: 'Computing', maturityLevel: 'emerging' },
    { name: '5G', category: 'Connectivity', maturityLevel: 'growth' },
  ];
}

export default router;
