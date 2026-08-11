import { Router, Request, Response } from 'express';
import { getGeminiUsageSummary, getGeminiUsageEntries } from '../services/usageLogger';

const router: ReturnType<typeof Router> = Router();

/**
 * GET /api/usage/gemini
 * Aggregated real Gemini token usage (usageMetadata.promptTokenCount /
 * candidatesTokenCount) since the last deploy, grouped by calling module.
 * In-memory only — resets on redeploy, same as this app's job stores.
 */
router.get('/gemini', (_req: Request, res: Response) => {
  res.json({ summary: getGeminiUsageSummary() });
});

/**
 * GET /api/usage/gemini/raw?limit=200
 * Raw per-call entries, most recent last. Capped at 5000 in memory.
 */
router.get('/gemini/raw', (req: Request, res: Response) => {
  const limit = Math.min(Number(req.query.limit) || 200, 5000);
  const entries = getGeminiUsageEntries();
  res.json({ entries: entries.slice(-limit) });
});

export default router;
