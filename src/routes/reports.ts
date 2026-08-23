import { Router, Request, Response } from 'express';
import { getRecentCompletedReports } from '../services/reportsAggregatorService';

const router = Router();

// GET /api/reports/recent?limit=100
// Cross-module list of completed reports, regardless of whether they were
// generated through the frontend UI or by hitting a module's API directly —
// see reportRegistry.ts for why this exists (localStorage-only history was
// blind to anything generated outside a browser session).
router.get('/recent', (req: Request, res: Response) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  res.json({ reports: getRecentCompletedReports(limit) });
});

export default router;
