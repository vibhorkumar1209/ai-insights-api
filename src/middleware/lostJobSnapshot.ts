import type { Request, Response, NextFunction } from 'express';
import { getReportPayload } from '../services/reportsAggregatorService';

// Every module keeps its jobs in memory, so a restart (each deploy, each
// free-tier spin-down) deletes them, and each module's status endpoint then
// answered GET /api/<module>/<jobId> with 404 {"error":"Job not found"} for
// good. The RefractOne .NET API throws on that 404 and re-polls the same job
// indefinitely: first seen on Financial Analysis
// (GetFinancialAnalysisStatusAsync), then on Biz Descrip
// (GetBusinessDescriptionStatus). Fixing it here covers all modules at once,
// including ones added later.
//
// Only that exact response is rewritten: a status GET for a job id, about to
// return the module's own "Job not found" 404. A finished job is served from
// the report archive; otherwise the answer is a terminal job state (200,
// status "error"), which any poller already knows how to stop on.
const SNAPSHOT_PATH = /^\/api\/[a-z0-9-]+\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export const LOST_JOB_MESSAGE =
  'Job not found: it expired or was lost in a server restart before it finished. Start a new request.';

export function lostJobSnapshot(req: Request, res: Response, next: NextFunction): void {
  const match = req.method === 'GET' ? req.path.match(SNAPSHOT_PATH) : null;
  if (!match) { next(); return; }
  const jobId = match[1];

  const originalJson = res.json.bind(res);
  res.json = ((body: unknown) => {
    const isLost = res.statusCode === 404 && (body as { error?: unknown })?.error === 'Job not found';
    if (!isLost) return originalJson(body);
    res.status(200);
    const archived = getReportPayload(jobId);
    if (archived) return originalJson(archived);
    return originalJson({ jobId, status: 'error', progress: 0, error: LOST_JOB_MESSAGE });
  }) as Response['json'];
  next();
}
