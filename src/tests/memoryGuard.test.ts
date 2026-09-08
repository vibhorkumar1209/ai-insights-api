import type { Request, Response, NextFunction } from 'express';
import { memoryGuard } from '../middleware/rateLimiter';

// The guard's threshold became configurable so route tests could run (Jest's
// own heap trips the 250MB production limit). These assert that making it
// configurable did not make it inert — it must still reject above threshold,
// and must still default to 250MB when the env var is absent or malformed.
function invoke() {
  const next = jest.fn() as unknown as NextFunction;
  const json = jest.fn();
  const res = { status: jest.fn(() => ({ json })), json } as unknown as Response;
  memoryGuard({} as Request, res, next);
  return { next, res, json };
}

describe('memoryGuard', () => {
  const original = process.env.MEMORY_GUARD_MAX_HEAP_MB;
  afterEach(() => {
    if (original === undefined) delete process.env.MEMORY_GUARD_MAX_HEAP_MB;
    else process.env.MEMORY_GUARD_MAX_HEAP_MB = original;
  });

  it('rejects with 503 when heap exceeds the threshold', () => {
    process.env.MEMORY_GUARD_MAX_HEAP_MB = '1';
    const { next, res } = invoke();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(next).not.toHaveBeenCalled();
  });

  it('passes the request through when heap is under the threshold', () => {
    process.env.MEMORY_GUARD_MAX_HEAP_MB = '100000';
    const { next, res } = invoke();
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('falls back to the 250MB production default when the env var is unset', () => {
    delete process.env.MEMORY_GUARD_MAX_HEAP_MB;
    const heapMB = process.memoryUsage().heapUsed / 1024 / 1024;
    const { next, res } = invoke();
    // Jest's own heap is well over 250MB, so the default must reject here.
    expect(heapMB).toBeGreaterThan(250);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(next).not.toHaveBeenCalled();
  });

  it('ignores a malformed threshold and uses the default', () => {
    process.env.MEMORY_GUARD_MAX_HEAP_MB = 'not-a-number';
    const { next, res } = invoke();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(next).not.toHaveBeenCalled();
  });
});
