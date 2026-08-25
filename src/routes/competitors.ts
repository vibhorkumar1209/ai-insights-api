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
 * Body: { targetCompany: string, companyDomain: string, industryContext?: string }
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

  // Optional (was previously required — Peer Benchmarking's setup wizard has
  // never collected a domain and was silently 400ing on every call as a
  // result). discoverCompetitorsFast already has a safe no-domain fallback:
  // it warns Claude the name may be ambiguous and instructs it to return []
  // rather than guess when it can't confidently identify the company, so
  // omitting domain degrades disambiguation strength rather than removing
  // the safety net entirely.
  const domain = typeof companyDomain === 'string' && companyDomain.trim() ? companyDomain.trim() : undefined;

  try {
    // This route is still a single blocking request (Peer Benchmarking's
    // wizard needs an immediate array, not a job to poll), so it's the most
    // latency-sensitive caller of researchCompanyOverview in the app — cap
    // the wait at 40s rather than the ~180s worst case, same reasoning as
    // businessDescriptionService.ts/peersService.ts.
    const research = await Promise.race([
      researchCompanyOverview(targetCompany.trim(), domain),
      new Promise<string>((resolve) => setTimeout(() => resolve(''), 40_000)),
    ]).catch((err) => {
      console.warn('[competitors] Research failed, proceeding with training knowledge:', err);
      return '';
    });

    // discoverCompetitorsFast already anchors identity strongly using the
    // domain + raw research text directly (see its own groundingBlock
    // logic) — the extra generateBusinessDescription round-trip that used
    // to run here was a full sequential Claude call for a marginal
    // additional disambiguation signal. Dropped for latency.
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
