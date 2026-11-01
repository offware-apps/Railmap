/// <reference lib="webworker" />
// The Interrail Europe worker: downloads every operator's Interrail trip bundle from
// train-api (v2) once, builds one search network over them, and answers journey and
// explore searches off the main thread.

import type { SearchBundle } from "./engine";
import { Europe, type EuropeJourney, type EuropePlace, type ReachRow } from "./network";

export type EuropeRequest =
  | { id: number; type: "init"; base: string; sncfCoords: Record<string, [number, number]> }
  | { id: number; type: "journeys"; from: string; to: string; dates: string[]; maxTrains: number }
  | { id: number; type: "reach"; from: string; dates: string[]; maxTrains: number };

export interface EuropeDirectory {
  places: EuropePlace[];
  /** Each operator's booking site for pass holders, by train-api operator id. */
  booking: Record<string, string>;
  updatedAt: string;
}

export type EuropeReply =
  | { id: number; type: "init"; directory: EuropeDirectory | null }
  // byDate is null when the network doesn't serve a station asked for (SNCF's trains answer).
  | { id: number; type: "journeys"; byDate: Record<string, EuropeJourney[]> | null }
  | { id: number; type: "reach"; byDate: Record<string, ReachRow[]> | null };

interface IndexV2 {
  updatedAt?: string;
  operators?: { id: string; passes?: { id: string; bookingUrl?: string }[] }[];
}

const PASS = "interrail";

let europe: Europe | null = null;

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return (await res.json()) as T;
}

function isBundle(x: unknown): x is SearchBundle {
  const b = x as Partial<SearchBundle> | null;
  return !!b && b.v === 2 && typeof b.operator === "string" && Array.isArray(b.dates) && Array.isArray(b.stations) && Array.isArray(b.trips);
}

async function init(base: string, sncfCoords: Record<string, [number, number]>): Promise<EuropeDirectory | null> {
  const index = await fetchJson<IndexV2>(`${base}/v2/index.json`);
  const ops = (index.operators ?? []).filter((o) => o.passes?.some((p) => p.id === PASS));
  // An operator that fails to load is left out; the others still search.
  const bundles = (
    await Promise.all(ops.map((o) => fetchJson<unknown>(`${base}/v2/${o.id}/${PASS}.json`).catch(() => null)))
  ).filter(isBundle);
  if (bundles.length === 0) return null;
  europe = new Europe(bundles, sncfCoords);
  const booking: Record<string, string> = {};
  for (const o of ops) {
    const url = o.passes?.find((p) => p.id === PASS)?.bookingUrl;
    if (url) booking[o.id] = url;
  }
  return { places: europe.directory(), booking, updatedAt: index.updatedAt ?? "" };
}

const ctx = self as unknown as {
  postMessage: (m: EuropeReply) => void;
  onmessage: ((e: MessageEvent<EuropeRequest>) => void) | null;
};

ctx.onmessage = (e: MessageEvent<EuropeRequest>): void => {
  const m = e.data;
  if (m.type === "init") {
    void init(m.base, m.sncfCoords)
      .catch(() => null)
      .then((directory) => ctx.postMessage({ id: m.id, type: "init", directory }));
    return;
  }
  const net = europe;
  if (m.type === "journeys") {
    if (!net?.knows(m.from) || !net.knows(m.to)) return ctx.postMessage({ id: m.id, type: "journeys", byDate: null });
    const byDate: Record<string, EuropeJourney[]> = {};
    for (const d of m.dates) byDate[d] = net.journeys(m.from, m.to, d, m.maxTrains);
    ctx.postMessage({ id: m.id, type: "journeys", byDate });
    return;
  }
  if (!net?.knows(m.from)) return ctx.postMessage({ id: m.id, type: "reach", byDate: null });
  const byDate: Record<string, ReachRow[]> = {};
  for (const d of m.dates) byDate[d] = net.reachable(m.from, d, m.maxTrains);
  ctx.postMessage({ id: m.id, type: "reach", byDate });
};
