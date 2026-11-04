import { dedupeJobStart, _resetDedupeForTests } from '../services/jobDedupe';

describe('failure breaker', () => {
  beforeEach(() => _resetDedupeForTests());

  it('stops starting new runs after the identical request fails twice', () => {
    const status = new Map<string, string>();
    let n = 0;
    const start = (input: unknown) => dedupeJobStart('m', input, (id) => status.get(id), (s) => s === 'error', () => {
      const id = `job${++n}`; status.set(id, 'running'); return id;
    });

    const a = start({ q: 1 }); expect(a.isNew).toBe(true);
    status.set(a.jobId, 'error');
    const b = start({ q: 1 }); expect(b.isNew).toBe(true); // first retry allowed
    status.set(b.jobId, 'error');
    const c = start({ q: 1 }); expect(c).toEqual({ jobId: b.jobId, isNew: false });
    const d = start({ q: 1 }); expect(d).toEqual({ jobId: b.jobId, isNew: false });
    expect(n).toBe(2);

    const other = start({ q: 2 }); expect(other.isNew).toBe(true); // a changed request still runs
  });

  it('still dedupes a running job and allows a retry after one failure', () => {
    const status = new Map<string, string>();
    let n = 0;
    const start = () => dedupeJobStart('m', { q: 1 }, (id) => status.get(id), (s) => s === 'error', () => {
      const id = `job${++n}`; status.set(id, 'running'); return id;
    });
    const a = start();
    expect(start()).toEqual({ jobId: a.jobId, isNew: false });
    status.set(a.jobId, 'error');
    expect(start().isNew).toBe(true);
  });
});
