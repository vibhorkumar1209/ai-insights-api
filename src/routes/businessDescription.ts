import { Router, Request, Response } from 'express';

const router = Router();

// Business Description is disabled — an external caller (traced by
// RefractOne's own team to their Azure-hosted .NET API, configured with
// this host as its backend) repeatedly pinged this endpoint automatically,
// driving uncontrolled Claude/Parallel.AI/Gemini credit spend across
// multiple incidents in one day even after a 10-minute dedupe window and
// persisted dedupe state. Shut down at the owner's explicit request rather
// than continuing to chase each new occurrence. Every request is rejected
// before any parsing, dedupe check, or AI work — the original job-creation
// logic is preserved in git history (see the businessDescriptionService.ts
// commit history) if this is ever re-enabled.
router.all('/*', (_req: Request, res: Response): void => {
  res.status(410).json({ error: 'The Business Description module has been permanently disabled.' });
});

export default router;
