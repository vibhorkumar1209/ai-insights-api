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
    for (let i = 0; i < 140; i++) {
      archiveCompletedReport(entry(`cap-${i}`), { i }, new Date().toISOString());
    }
    const { entries } = getArchiveStats();
    expect(entries).toBeLessThanOrEqual(120);
    // The most recent survive; the earliest were evicted.
    expect(isArchived('cap-139')).toBe(true);
    expect(isArchived('cap-0')).toBe(false);
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
