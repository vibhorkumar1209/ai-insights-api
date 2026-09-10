import { Router, Request, Response } from 'express';
import { getRecentCompletedReports, getArchivedReportPayload } from '../services/reportsAggregatorService';
import { getArchiveStats } from '../services/reportRegistry';

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

// GET /api/reports/:jobId/raw
// Archived payload for a report whose module job store has evicted it (2h
// TTL). The frontend falls back to this so "View" on an older Report History
// row still opens the real report rather than 404ing.
router.get('/:jobId/raw', (req: Request, res: Response) => {
  const payload = getArchivedReportPayload(req.params.jobId);
  if (!payload) {
    res.status(404).json({ error: 'Report not found in archive' });
    return;
  }
  res.json(payload);
});

// GET /api/reports/archive-stats — operational visibility into the archive's
// bounded memory use, so a growing archive is observable rather than a
// surprise OOM on a 300MB heap.
router.get('/archive-stats', (_req: Request, res: Response) => {
  const { entries, bytes } = getArchiveStats();
  res.json({ entries, bytes, megabytes: Math.round((bytes / 1024 / 1024) * 100) / 100 });
});

export default router;
