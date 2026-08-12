import { Router, Request, Response } from 'express';
import {
  getGeminiUsageSummary, getGeminiUsageEntries,
  getClaudeUsageSummary, getClaudeUsageEntries,
  getParallelUsageSummary, getParallelUsageEntries,
} from '../services/usageLogger';

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

/**
 * GET /api/usage/claude
 * Aggregated real Claude token usage (response.usage.input_tokens/
 * output_tokens/cache_*), grouped by the calling function — auto-detected
 * from the call stack rather than hand-labeled at each of the 30+ call
 * sites (see usageLogger.ts's getCallerLabel).
 */
router.get('/claude', (_req: Request, res: Response) => {
  res.json({ summary: getClaudeUsageSummary() });
});

router.get('/claude/raw', (req: Request, res: Response) => {
  const limit = Math.min(Number(req.query.limit) || 200, 5000);
  const entries = getClaudeUsageEntries();
  res.json({ entries: entries.slice(-limit) });
});

/**
 * GET /api/usage/parallel
 * Real Parallel.AI (and Google Custom Search, prefixed "googleCSE:") call
 * counts, grouped by source. No token counts — Parallel/Google bill per
 * task/query, not per token, so calls/billedCalls is the real unit.
 */
router.get('/parallel', (_req: Request, res: Response) => {
  res.json({ summary: getParallelUsageSummary() });
});

router.get('/parallel/raw', (req: Request, res: Response) => {
  const limit = Math.min(Number(req.query.limit) || 200, 5000);
  const entries = getParallelUsageEntries();
  res.json({ entries: entries.slice(-limit) });
});

export default router;
