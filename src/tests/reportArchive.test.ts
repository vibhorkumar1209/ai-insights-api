import {
  registerJobStart,
  archiveCompletedReport,
  getArchivedReport,
  getArchiveStats,
  isArchived,
  getRegisteredReports,
  type RegisteredReport,
} from '../services/reportRegistry';

// API-generated reports vanished from Report History two hours after they were
// made, because the aggregator read each job's status from its module's own
// store and every one of those evicts on a 2h TTL. The archive keeps the
// completed payload independently. It is bounded on purpose — this process runs
// with a 300MB heap, so an unbounded archive would trade a history bug for an
// OOM. These assert the bounds actually hold.

function entry(jobId: string, moduleType = 'industry-report'): RegisteredReport {
  return { moduleType, jobId, label: `label-${jobId}`, createdAt: new Date().toISOString() };
}

describe('report archive', () => {
  it('archives a completed report and serves it back', () => {
    const e = entry('job-basic');
    archiveCompletedReport(e, { status: 'complete', sections: ['a'] }, '2026-01-01T00:00:00.000Z');

    expect(isArchived('job-basic')).toBe(true);
    const archived = getArchivedReport('job-basic');
    expect(archived?.label).toBe('label-job-basic');
    expect(archived?.completedAt).toBe('2026-01-01T00:00:00.000Z');
    expect((archived?.payload as Record<string, unknown>).sections).toEqual(['a']);
  });

  it('does not overwrite an already-archived job', () => {
    const e = entry('job-once');
    archiveCompletedReport(e, { v: 1 }, '2026-01-01T00:00:00.000Z');
    archiveCompletedReport(e, { v: 2 }, '2026-01-02T00:00:00.000Z');
    expect((getArchivedReport('job-once')?.payload as Record<string, unknown>).v).toBe(1);
  });

  it('refuses a payload above the single-report size limit', () => {
    // > 2MB once serialized.
    const huge = { blob: 'x'.repeat(2 * 1024 * 1024 + 10) };
    archiveCompletedReport(entry('job-huge'), huge, '2026-01-01T00:00:00.000Z');
    expect(isArchived('job-huge')).toBe(false);
  });

  it('skips a payload that cannot be serialized rather than throwing', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => archiveCompletedReport(entry('job-cyclic'), cyclic, '2026-01-01T00:00:00.000Z')).not.toThrow();
    expect(isArchived('job-cyclic')).toBe(false);
  });

  it('evicts oldest entries to stay under the entry cap', () => {
    for (let i = 0; i < 2100; i++) {
      archiveCompletedReport(entry(`cap-${i}`), { i }, new Date().toISOString());
    }
    const { entries } = getArchiveStats();
    expect(entries).toBeLessThanOrEqual(2000);
    // The most recent survive; the earliest were evicted.
    expect(isArchived('cap-2099')).toBe(true);
    expect(isArchived('cap-0')).toBe(false);
  });

  // The cap that matters. Live, 120 entries held 843KB — so a 120-entry limit
  // was evicting expensive Industry Reports while using 3.5% of the memory
  // actually budgeted for them.
  it('keeps far more than the old 120-entry limit when payloads are small', () => {
    for (let i = 0; i < 400; i++) {
      archiveCompletedReport(entry(`small-${i}`), { note: 'x'.repeat(200) }, new Date().toISOString());
    }
    expect(getArchiveStats().entries).toBeGreaterThan(120);
    expect(isArchived('small-399')).toBe(true);
  });

  it('keeps the byte total consistent with what is retained', () => {
    const { entries, bytes } = getArchiveStats();
    expect(bytes).toBeGreaterThanOrEqual(0);
    expect(bytes).toBeLessThanOrEqual(24 * 1024 * 1024);
    if (entries === 0) expect(bytes).toBe(0);
  });

  it('caps the start registry so it cannot grow without bound', () => {
    for (let i = 0; i < 520; i++) registerJobStart('peers', `reg-${i}`, `label-${i}`);
    expect(getRegisteredReports().length).toBeLessThanOrEqual(500);
  });
});

// ── Serving a report by id ───────────────────────────────────────────────────
// "View Raw" in the UI opened the module's own endpoint, which 404s once that
// module's 2h TTL evicts the job — hence {"error":"Job not found"} on every
// older API-generated report. It now goes through the reports endpoint, which
// must answer for BOTH an archived report and one that just finished and has
// not been swept into the archive yet (the sweep runs every 60s).
describe('getReportPayload', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { getReportPayload } = require('../services/reportsAggregatorService');

  it('returns an archived payload', () => {
    archiveCompletedReport(entry('served-archived', 'peers'), { status: 'complete', competitors: ['a'] }, '2026-01-01T00:00:00.000Z');
    const payload = getReportPayload('served-archived') as Record<string, unknown>;
    expect(payload).toBeDefined();
    expect(payload.competitors).toEqual(['a']);
  });

  it('returns undefined for an unknown job rather than throwing', () => {
    expect(getReportPayload('no-such-job')).toBeUndefined();
  });

  it('returns undefined for a registered job with no archived copy and no live job', () => {
    registerJobStart('peers', 'registered-but-gone', 'Acme');
    expect(getReportPayload('registered-but-gone')).toBeUndefined();
  });
});
