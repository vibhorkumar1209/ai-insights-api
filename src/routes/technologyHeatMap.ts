import { Router, Request, Response } from 'express';
import { aiLimiter } from '../middleware/rateLimiter';
import {
  createTechnologyHeatMapJob,
  getTechnologyHeatMapJob,
  runTechnologyHeatMap,
  subscribeToJob,
  unsubscribeFromJob,
} from '../services/technologyHeatMapService';
import { HeatMapInput } from '@ai-insights/types';

const router = Router();

/** POST /api/technology-heat-map — start analysis */
router.post('/', aiLimiter, (req: Request, res: Response): void => {
  const input: HeatMapInput = req.body;

  if (!input.industry || typeof input.industry !== 'string' || !input.industry.trim()) {
    res.status(400).json({ error: 'industry is required' });
    return;
  }

  if (!Array.isArray(input.selectedCompetitors) || input.selectedCompetitors.length === 0) {
    res.status(400).json({ error: 'selectedCompetitors array is required and must not be empty' });
    return;
  }

  if (input.selectedCompetitors.length > 10) {
    res.status(400).json({ error: 'Maximum 10 competitors allowed' });
    return;
  }

  if (!Array.isArray(input.selectedTechs) || input.selectedTechs.length === 0) {
    res.status(400).json({ error: 'selectedTechs array is required and must not be empty' });
    return;
  }

  if (input.selectedTechs.length > 10) {
    res.status(400).json({ error: 'Maximum 10 technologies allowed' });
    return;
  }

  if (!Array.isArray(input.industrySegments) || input.industrySegments.length === 0) {
    res.status(400).json({ error: 'industrySegments array is required and must not be empty' });
    return;
  }

  if (input.industrySegments.length > 10) {
    res.status(400).json({ error: 'Maximum 10 industry segments allowed' });
    return;
  }

  const jobId = createTechnologyHeatMapJob();

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

/** POST /api/technology-heat-map/discover-competitors */
router.post('/discover-competitors', aiLimiter, (req: Request, res: Response): void => {
  const { industry } = req.body;
  if (!industry) {
    res.status(400).json({ error: 'industry is required' });
    return;
  }

  // Return hardcoded competitors for now (will be enhanced with AI discovery later)
  const competitors = getCompetitorsForIndustry(industry);
  res.json({ competitors });
});

/** POST /api/technology-heat-map/discover-technologies */
router.post('/discover-technologies', aiLimiter, (req: Request, res: Response): void => {
  const { industry } = req.body;
  if (!industry) {
    res.status(400).json({ error: 'industry is required' });
    return;
  }

  // Return emerging technologies for the industry
  const technologies = getTechnologiesForIndustry(industry);
  res.json({ technologies });
});

/** POST /api/technology-heat-map/discover-segments */
router.post('/discover-segments', aiLimiter, (req: Request, res: Response): void => {
  const { industry } = req.body;
  if (!industry) {
    res.status(400).json({ error: 'industry is required' });
    return;
  }

  // Return industry segments
  const segments = getSegmentsForIndustry(industry);
  res.json({ segments });
});

// ── Helper functions ──────────────────────────────────────────────────────────

function getCompetitorsForIndustry(industry: string): any[] {
  const competitorMap: Record<string, any[]> = {
    banking: [
      { name: 'JPMorgan Chase', headquarters: 'New York, USA', estimatedRevenue: '$177.3B', relevanceScore: 10 },
      { name: 'Bank of America', headquarters: 'Charlotte, USA', estimatedRevenue: '$117.2B', relevanceScore: 10 },
      { name: 'Goldman Sachs', headquarters: 'New York, USA', estimatedRevenue: '$70.1B', relevanceScore: 9 },
      { name: 'Citigroup', headquarters: 'New York, USA', estimatedRevenue: '$79.9B', relevanceScore: 9 },
      { name: 'Wells Fargo', headquarters: 'San Francisco, USA', estimatedRevenue: '$89.0B', relevanceScore: 8 },
      { name: 'HSBC', headquarters: 'London, UK', estimatedRevenue: '$66.5B', relevanceScore: 8 },
      { name: 'ING Group', headquarters: 'Amsterdam, Netherlands', estimatedRevenue: '$70.9B', relevanceScore: 7 },
      { name: 'Barclays', headquarters: 'London, UK', estimatedRevenue: '$44.4B', relevanceScore: 7 },
      { name: 'Credit Suisse', headquarters: 'Zurich, Switzerland', estimatedRevenue: '$22.5B', relevanceScore: 6 },
      { name: 'Morgan Stanley', headquarters: 'New York, USA', estimatedRevenue: '$53.7B', relevanceScore: 8 },
    ],
    technology: [
      { name: 'Apple', headquarters: 'Cupertino, USA', estimatedRevenue: '$408.2B', relevanceScore: 10 },
      { name: 'Microsoft', headquarters: 'Redmond, USA', estimatedRevenue: '$221.9B', relevanceScore: 10 },
      { name: 'Google (Alphabet)', headquarters: 'Mountain View, USA', estimatedRevenue: '$307.4B', relevanceScore: 10 },
      { name: 'Meta', headquarters: 'Menlo Park, USA', estimatedRevenue: '$134.9B', relevanceScore: 9 },
      { name: 'Amazon', headquarters: 'Seattle, USA', estimatedRevenue: '$575.5B', relevanceScore: 9 },
      { name: 'Tesla', headquarters: 'Austin, USA', estimatedRevenue: '$81.5B', relevanceScore: 8 },
      { name: 'NVIDIA', headquarters: 'Santa Clara, USA', estimatedRevenue: '$60.9B', relevanceScore: 9 },
      { name: 'Broadcom', headquarters: 'San Jose, USA', estimatedRevenue: '$63.1B', relevanceScore: 7 },
      { name: 'Qualcomm', headquarters: 'San Diego, USA', estimatedRevenue: '$44.2B', relevanceScore: 8 },
      { name: 'Intel', headquarters: 'Santa Clara, USA', estimatedRevenue: '$63.1B', relevanceScore: 7 },
    ],
    automotive: [
      { name: 'Tesla', headquarters: 'Austin, USA', estimatedRevenue: '$81.5B', relevanceScore: 10 },
      { name: 'Toyota', headquarters: 'Toyota City, Japan', estimatedRevenue: '$279.5B', relevanceScore: 10 },
      { name: 'Volkswagen', headquarters: 'Wolfsburg, Germany', estimatedRevenue: '$296.0B', relevanceScore: 10 },
      { name: 'General Motors', headquarters: 'Detroit, USA', estimatedRevenue: '$127.0B', relevanceScore: 9 },
      { name: 'Ford', headquarters: 'Dearborn, USA', estimatedRevenue: '$136.3B', relevanceScore: 9 },
      { name: 'BMW', headquarters: 'Munich, Germany', estimatedRevenue: '$142.5B', relevanceScore: 8 },
      { name: 'Mercedes-Benz', headquarters: 'Stuttgart, Germany', estimatedRevenue: '$176.0B', relevanceScore: 8 },
      { name: 'Honda', headquarters: 'Tokyo, Japan', estimatedRevenue: '$150.4B', relevanceScore: 9 },
      { name: 'Hyundai', headquarters: 'Seoul, South Korea', estimatedRevenue: '$98.4B', relevanceScore: 8 },
      { name: 'BYD', headquarters: 'Shenzhen, China', estimatedRevenue: '$63.9B', relevanceScore: 9 },
    ],
    retail: [
      { name: 'Amazon', headquarters: 'Seattle, USA', estimatedRevenue: '$575.5B', relevanceScore: 10 },
      { name: 'Walmart', headquarters: 'Bentonville, USA', estimatedRevenue: '$648.1B', relevanceScore: 10 },
      { name: 'Alibaba', headquarters: 'Hangzhou, China', estimatedRevenue: '$126.2B', relevanceScore: 9 },
      { name: 'JD.com', headquarters: 'Beijing, China', estimatedRevenue: '$128.6B', relevanceScore: 8 },
      { name: 'Target', headquarters: 'Minneapolis, USA', estimatedRevenue: '$107.6B', relevanceScore: 7 },
      { name: 'Best Buy', headquarters: 'Richfield, USA', estimatedRevenue: '$52.0B', relevanceScore: 6 },
      { name: 'Costco', headquarters: 'Issaquah, USA', estimatedRevenue: '$248.1B', relevanceScore: 8 },
      { name: 'Home Depot', headquarters: 'Atlanta, USA', estimatedRevenue: '$158.0B', relevanceScore: 7 },
      { name: 'Lowe\'s', headquarters: 'Mooresville, USA', estimatedRevenue: '$96.3B', relevanceScore: 7 },
      { name: 'Target', headquarters: 'Minneapolis, USA', estimatedRevenue: '$107.6B', relevanceScore: 7 },
    ],
  };

  return competitorMap[industry.toLowerCase()] || [];
}

function getTechnologiesForIndustry(industry: string): any[] {
  const defaultTechs = [
    { name: 'AI/ML', category: 'Artificial Intelligence', maturityLevel: 'growth' },
    { name: 'Cloud Computing', category: 'Infrastructure', maturityLevel: 'mainstream' },
    { name: 'Blockchain', category: 'Distributed Ledger', maturityLevel: 'emerging' },
    { name: 'IoT', category: 'Internet of Things', maturityLevel: 'growth' },
    { name: 'RPA', category: 'Automation', maturityLevel: 'mainstream' },
    { name: 'Cybersecurity', category: 'Security', maturityLevel: 'mainstream' },
    { name: 'Big Data Analytics', category: 'Data', maturityLevel: 'mainstream' },
    { name: 'Edge Computing', category: 'Infrastructure', maturityLevel: 'growth' },
    { name: 'Quantum Computing', category: 'Computing', maturityLevel: 'emerging' },
    { name: '5G', category: 'Connectivity', maturityLevel: 'growth' },
  ];

  // Could be enhanced with industry-specific techs
  return defaultTechs;
}

function getSegmentsForIndustry(industry: string): string[] {
  const segmentMap: Record<string, string[]> = {
    banking: [
      'Retail Banking',
      'Corporate Banking',
      'Investment Banking',
      'Wealth Management',
      'Payment Processing',
      'Digital Banking',
      'Insurance',
      'Risk Management',
      'Regulatory Compliance',
      'Customer Service',
    ],
    technology: [
      'Cloud Services',
      'Software Development',
      'Hardware Manufacturing',
      'Semiconductors',
      'Cybersecurity',
      'Artificial Intelligence',
      'E-commerce',
      'Data Analytics',
      'IoT Solutions',
      'Mobile Apps',
    ],
    automotive: [
      'Electric Vehicles',
      'Autonomous Driving',
      'Manufacturing',
      'Supply Chain',
      'Aftersales Service',
      'Connected Vehicles',
      'Battery Technology',
      'Software & Platforms',
      'Customer Experience',
      'Sustainability',
    ],
    retail: [
      'E-commerce',
      'Physical Stores',
      'Omnichannel',
      'Supply Chain',
      'Customer Analytics',
      'Inventory Management',
      'Mobile Commerce',
      'Payment Solutions',
      'Logistics',
      'Customer Service',
    ],
  };

  return segmentMap[industry.toLowerCase()] || [];
}

export default router;
