import { Router, Request, Response } from 'express';
import { discoverCompetitors } from '../services/parallelAI';
import { aiLimiter } from '../middleware/rateLimiter';

const router = Router();

/**
 * POST /api/competitors
 * Discover competitors for a target company using Parallel.AI research.
 *
 * Body: { targetCompany: string, industryContext?: string }
 * Returns: { competitors: Competitor[] }
 */
router.post('/', aiLimiter, async (req: Request, res: Response) => {
  const { targetCompany, industryContext } = req.body;

  if (!targetCompany || typeof targetCompany !== 'string') {
    return res.status(400).json({ error: 'targetCompany is required and must be a string' });
  }

  if (targetCompany.length > 200 || (industryContext && String(industryContext).length > 500)) {
    return res.status(400).json({ error: 'Input too long' });
  }

  const industry = typeof industryContext === 'string' && industryContext.trim()
    ? industryContext.trim()
    : undefined;

  try {
    const competitors = await discoverCompetitors(
      targetCompany.trim(),
      industry
    );

    return res.json({
      targetCompany: targetCompany.trim(),
      industryContext: industry || '(auto-detected)',
      competitors,
      count: competitors.length,
    });
  } catch (err) {
    console.error('[competitors] Error:', err);
    const message = err instanceof Error ? err.message : 'Research failed';
    return res.status(500).json({ error: message });
  }
});

export default router;
