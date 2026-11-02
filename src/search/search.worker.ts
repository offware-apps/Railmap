/// <reference lib="webworker" />
// Background search worker. Owns its own copy of the dataset (fetched from the same
// committed snapshot the page uses), runs the heavy per-search compute off the main
// thread, and posts back a cache dump the page merges so its render is a cache hit.

import type { MaxTrain, SearchQuery } from "../types";
import { loadDataset } from "../data/dataset";
import { profileForCard, type DatasetProfile } from "../data/profile";
import { clearConnCaches, dumpConnCaches, type ConnCacheDump } from "../core/connections";
import { warmForQuery } from "./warm";

interface WarmMsg {
  id: number;
  query: SearchQuery;
  today: string;
  /** The train-api base the page's trains came from ("" = the snapshot). */
  api: string;
}

// One dataset per profile and source (the query's pass decides which), loaded on first
// use. The worker must hold the very trains the page holds, or its cache dump would
// describe other trains: when the page read train-api but the worker could only reach
// the snapshot, it has nothing to offer and the page computes on its own.
const loaded = new Map<string, Promise<MaxTrain[]>>();
function trainsFor(profile: DatasetProfile, api: string): Promise<MaxTrain[]> {
  const key = `${profile.id} ${api}`;
  let p = loaded.get(key);
  if (!p) {
    p = loadDataset(profile, api)
      .then((d) => ((d.apiBase ?? "") === api ? d.trains : []))
      .catch(() => []);
    loaded.set(key, p);
  }
  return p;
}

const ctx = self as unknown as {
  postMessage: (m: { id: number; dump: ConnCacheDump | null }) => void;
  onmessage: ((e: MessageEvent<WarmMsg>) => void) | null;
};

ctx.onmessage = (e: MessageEvent<WarmMsg>): void => {
  const { id, query, today, api } = e.data;
  void trainsFor(profileForCard(query.card), api ?? "").then((trains) => {
    if (!trains.length) {
      ctx.postMessage({ id, dump: null });
      return;
    }
    // Clear first so the dump carries only THIS search's working set, not everything
    // computed since the worker started.
    clearConnCaches(trains);
    warmForQuery(trains, query, today);
    ctx.postMessage({ id, dump: dumpConnCaches(trains) });
  });
};
