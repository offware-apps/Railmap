// Main-thread client for the background search worker. `warmSearch` asks the worker
// to pre-compute a query's heavy primitives off-thread, then merges the result into
// the local caches so the synchronous render runs as cache hits. It ALWAYS resolves
// (never rejects): if the worker is unavailable, errors, or is slow, it resolves and
// the render simply computes on the main thread, exactly as before.

import type { MaxTrain, SearchQuery } from "../types";
import { restoreConnCaches, type ConnCacheDump } from "../core/connections";

interface WarmReply {
  id: number;
  dump: ConnCacheDump | null;
}

let worker: Worker | null = null;
let disabled = false;
let seq = 0;
const pending = new Map<number, (dump: ConnCacheDump | null) => void>();

function ensureWorker(): Worker | null {
  if (disabled) return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL("./search.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<WarmReply>) => {
      const { id, dump } = e.data;
      const cb = pending.get(id);
      if (cb) {
        pending.delete(id);
        cb(dump);
      }
    };
    worker.onerror = () => {
      // Give up on the worker for the rest of the session; searches fall back to main.
      disabled = true;
      worker = null;
      for (const [id, cb] of pending) {
        pending.delete(id);
        cb(null);
      }
    };
  } catch {
    disabled = true;
    worker = null;
  }
  return worker;
}

/**
 * Pre-compute the query's heavy search primitives in the worker and warm the local
 * caches. Resolves once done (or immediately if the worker can't help), so the caller
 * can render right after. Never throws.
 */
export function warmSearch(trains: MaxTrain[], query: SearchQuery, today: string, api = ""): Promise<void> {
  const w = ensureWorker();
  if (!w) return Promise.resolve();
  const id = ++seq;
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = (dump: ConnCacheDump | null): void => {
      if (settled) return;
      settled = true;
      if (dump) {
        try {
          restoreConnCaches(trains, dump);
        } catch {
          /* ignore a malformed dump — render computes on-thread */
        }
      }
      resolve();
    };
    pending.set(id, finish);
    // Never let a stuck worker hold up a search: after a budget, render on-thread.
    setTimeout(() => {
      if (pending.delete(id)) finish(null);
    }, 4000);
    try {
      w.postMessage({ id, query, today, api });
    } catch {
      pending.delete(id);
      finish(null);
    }
  });
}
