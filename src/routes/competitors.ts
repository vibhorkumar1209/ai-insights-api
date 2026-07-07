import { Router, Request, Response } from 'express';
import { discoverCompetitorsFast } from '../services/claudeAI';
import { researchCompanyOverview } from '../services/parallelAI';
import { aiLimiter } from '../middleware/rateLimiter';

const router = Router();

/**
 * POST /api/competitors
 * Discover competitors for a target company. Grounds Claude in a live web
 * research pass first — pure training-knowledge lookups were confidently
 * returning competitors for the wrong company when the name was ambiguous
 * or Claude's training data on the target company was sparse.
 *
 * Body: { targetCompany: string, industryContext?: string, companyDomain?: string }
 * Returns: { competitors: Competitor[] }
 */
router.post('/', aiLimiter, async (req: Request, res: Response) => {
  const { targetCompany, industryContext, companyDomain } = req.body;

  if (!targetCompany || typeof targetCompany !== 'string') {
    return res.status(400).json({ error: 'targetCompany is required and must be a string' });
  }

  if (targetCompany.length > 200 || (industryContext && String(industryContext).length > 500)) {
    return res.status(400).json({ error: 'Input too long' });
  }

  const industry = typeof industryContext === 'string' && industryContext.trim()
    ? industryContext.trim()
    : undefined;

  const domain = typeof companyDomain === 'string' && companyDomain.trim()
    ? companyDomain.trim()
    : undefined;

  try {
    const research = await researchCompanyOverview(targetCompany.trim(), domain).catch((err) => {
      console.warn('[competitors] Research failed, proceeding with training knowledge:', err);
      return '';
    });

    const competitors = await discoverCompetitorsFast(
      targetCompany.trim(),
      industry,
      domain,
      research
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
