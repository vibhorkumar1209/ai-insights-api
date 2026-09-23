import { Router, Request, Response } from 'express';
import { getRecentCompletedReports, getReportPayload } from '../services/reportsAggregatorService';
import { getArchiveStats } from '../services/reportRegistry';
import { getPersistenceBackend } from '../services/persistentStore';

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
  const payload = getReportPayload(req.params.jobId);
  if (!payload) {
    res.status(404).json({ error: 'Report not found' });
    return;
  }
  res.json(payload);
});

// GET /api/reports/archive-stats — operational visibility into the archive's
// bounded memory use, so a growing archive is observable rather than a
// surprise OOM on a 300MB heap.
router.get('/archive-stats', (_req: Request, res: Response) => {
  const { entries, bytes } = getArchiveStats();
  const backend = getPersistenceBackend();
  res.json({
    entries,
    bytes,
    megabytes: Math.round((bytes / 1024 / 1024) * 100) / 100,
    // Which store is behind the archive, and therefore what actually survives.
    // This was previously invisible from outside, and the difference matters:
    // 'memory' loses everything on restart, 'file' survives a process restart
    // but NOT a redeploy unless DATA_DIR points at a mounted Render Disk (a
    // redeploy is a new container), and only 'redis' survives both. An archive
    // that came back after one restart and vanished after the next looks
    // baffling until you can see this.
    persistence: backend,
    survivesRedeploy: backend === 'redis',
  });
});

export default router;
