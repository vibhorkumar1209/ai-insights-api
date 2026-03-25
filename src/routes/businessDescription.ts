import { Router, Request, Response } from 'express';
import { generateBusinessDescription } from '../services/claudeAI';
import { aiLimiter } from '../middleware/rateLimiter';

const router = Router();

/**
 * POST /api/business-description
 * Generate a 100-250 word business description for a company.
 *
 * Body: { companyName: string, domain?: string }
 * Returns: { companyName: string, description: string }
 */
router.post('/', aiLimiter, async (req: Request, res: Response) => {
  const { companyName, domain } = req.body;

  if (!companyName || typeof companyName !== 'string') {
    return res.status(400).json({ error: 'companyName is required and must be a string' });
  }

  if (companyName.length > 200 || (domain && String(domain).length > 200)) {
    return res.status(400).json({ error: 'Input too long' });
  }

  try {
    const description = await generateBusinessDescription(
      companyName.trim(),
      typeof domain === 'string' && domain.trim() ? domain.trim() : undefined
    );

    return res.json({
      companyName: companyName.trim(),
      description,
    });
  } catch (err) {
    console.error('[business-description] Error:', err);
    const message = err instanceof Error ? err.message : 'Description generation failed';
    return res.status(500).json({ error: message });
  }
});

export default router;
