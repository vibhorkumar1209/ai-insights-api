import fs from 'fs/promises';
import path from 'path';

// Small pluggable key/value store for state that must survive a restart.
//
// WHY THIS EXISTS
// Two pieces of in-memory state were being silently destroyed on every
// deploy/restart, and Render redeploys on every push to main:
//   1. usageLogger's ring buffers — the source of the per-report cost figures
//      in Report History. After a redeploy, older reports showed no cost at
//      all, because the usage entries they were computed from were gone.
//   2. jobDedupe's recentByKey map — losing it means the first request after
//      a restart ALWAYS starts fresh AI work, even if an identical request
//      was deduped moments earlier. With frequent deploys this defeated the
//      dedupe protection precisely when it mattered.
//
// BACKEND SELECTION (first match wins):
//   REDIS_URL set  -> redis. Survives redeploys AND restarts. Recommended:
//                     Render's Key Value add-on has a free tier, and unlike a
//                     persistent disk it does not force single-instance
//                     deploys or block zero-downtime rollouts.
//   DATA_DIR set   -> file. NOTE: Render's default filesystem is EPHEMERAL —
//                     a plain path survives a process crash but NOT a
//                     redeploy (new container). Only genuinely durable if
//                     DATA_DIR points at a mounted Render Disk.
//   neither        -> memory (no persistence). Preserves the previous
//                     behaviour exactly, so this is a safe no-op default.
//
// Every operation is defensive: a backend failure degrades to "no
// persistence" rather than throwing. Persistence is a nice-to-have here, and
// must never take the API down or fail a request.

type Backend = 'redis' | 'file' | 'memory';

interface MinimalRedis {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  quit(): Promise<unknown>;
}

let backend: Backend = 'memory';
let redisClient: MinimalRedis | null = null;
let dataDir: string | null = null;
let initialized = false;

export function getPersistenceBackend(): Backend {
  return backend;
}

export async function initPersistentStore(): Promise<void> {
  if (initialized) return;
  initialized = true;

  const redisUrl = process.env.REDIS_URL;
  if (redisUrl) {
    try {
      // Dynamic import so a missing/uninstalled `redis` package degrades to
      // the next backend instead of crashing the server at startup.
      const mod = await import('redis');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const client = (mod as any).createClient({ url: redisUrl });
      // An 'error' listener is REQUIRED — node-redis emits errors on the
      // client and an unhandled 'error' event would take the process down.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client.on('error', (err: any) => {
        console.warn('[persistentStore] redis error:', err?.message || err);
      });
      await client.connect();
      redisClient = client as MinimalRedis;
      backend = 'redis';
      console.log('[persistentStore] backend=redis — state will survive restarts and redeploys');
      return;
    } catch (err) {
      console.warn('[persistentStore] REDIS_URL set but redis unavailable, falling back:', err instanceof Error ? err.message : err);
    }
  }

  const dir = process.env.DATA_DIR;
  if (dir) {
    try {
      await fs.mkdir(dir, { recursive: true });
      dataDir = dir;
      backend = 'file';
      console.log(`[persistentStore] backend=file at ${dir} — durable ONLY if this is a mounted Render Disk (the default Render filesystem is ephemeral and is lost on redeploy)`);
      return;
    } catch (err) {
      console.warn('[persistentStore] DATA_DIR set but not writable, falling back:', err instanceof Error ? err.message : err);
    }
  }

  backend = 'memory';
  console.log('[persistentStore] backend=memory — no REDIS_URL or DATA_DIR set, so usage logs and dedupe state will NOT survive a restart');
}

function fileFor(key: string): string {
  // Key is developer-supplied (never user input), but sanitize anyway so a
  // key can never escape the data directory.
  return path.join(dataDir as string, `${key.replace(/[^a-zA-Z0-9_.-]/g, '_')}.json`);
}

export async function loadJson<T>(key: string): Promise<T | null> {
  try {
    if (backend === 'redis' && redisClient) {
      const raw = await redisClient.get(key);
      return raw ? (JSON.parse(raw) as T) : null;
    }
    if (backend === 'file' && dataDir) {
      const raw = await fs.readFile(fileFor(key), 'utf8');
      return JSON.parse(raw) as T;
    }
  } catch (err) {
    // ENOENT on first boot is normal and not worth logging as a warning.
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== 'ENOENT') {
      console.warn(`[persistentStore] load "${key}" failed:`, err instanceof Error ? err.message : err);
    }
  }
  return null;
}

async function writeJson(key: string, value: unknown): Promise<void> {
  try {
    const serialized = JSON.stringify(value);
    if (backend === 'redis' && redisClient) {
      await redisClient.set(key, serialized);
      return;
    }
    if (backend === 'file' && dataDir) {
      // Write-then-rename so a crash mid-write can't leave a truncated file
      // that would fail to parse on the next boot.
      const target = fileFor(key);
      const tmp = `${target}.tmp`;
      await fs.writeFile(tmp, serialized, 'utf8');
      await fs.rename(tmp, target);
    }
  } catch (err) {
    console.warn(`[persistentStore] save "${key}" failed:`, err instanceof Error ? err.message : err);
  }
}

const pendingTimers = new Map<string, NodeJS.Timeout>();

/**
 * Debounced, fire-and-forget save. Takes a getter rather than a value so the
 * snapshot is taken at flush time — callers can fire this on every mutation
 * without serializing the whole buffer each time.
 */
export function saveJsonDebounced(key: string, getValue: () => unknown, debounceMs = 5000): void {
  if (backend === 'memory') return; // nothing to do, skip the timer churn entirely

  const existing = pendingTimers.get(key);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    pendingTimers.delete(key);
    void writeJson(key, getValue());
  }, debounceMs);

  // Don't let a pending flush hold the process open on shutdown.
  timer.unref();
  pendingTimers.set(key, timer);
}

/** Flush any pending debounced writes — used on graceful shutdown. */
export async function flushPendingSaves(flushers: Array<{ key: string; getValue: () => unknown }>): Promise<void> {
  for (const timer of pendingTimers.values()) clearTimeout(timer);
  pendingTimers.clear();
  if (backend === 'memory') return;
  await Promise.all(flushers.map((f) => writeJson(f.key, f.getValue())));
}
