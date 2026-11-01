/// <reference lib="webworker" />
// The Interrail Europe worker. At start it downloads train-api's v2 index and every
// operator's station list (small), for the station fields and the map. Each search then
// downloads only the trip bundles of the operators it needs (see Europe.operatorsFor),
// once per visit, and answers off the main thread.
//
// Offline mode (opt-in, from Settings): every file is also kept in Cache Storage and read
// from there when the network fails; a sync downloads every operator's files, again only
// when train-api has published newer ones.

import type { SearchBundle } from "./engine";
import { OFFLINE_CACHE } from "./cache";
import { Europe, type EuropeJourney, type EuropePlace, type ReachRow, type StationList } from "./network";

export type EuropeRequest =
  | { id: number; type: "init"; base: string; sncfCoords: Record<string, [number, number]>; offline: boolean }
  | { id: number; type: "journeys"; from: string; to: string; dates: string[]; maxTrains: number }
  | { id: number; type: "reach"; from: string; dates: string[]; maxTrains: number }
  | { id: number; type: "offline"; on: boolean };

export interface EuropeDirectory {
  places: EuropePlace[];
  /** Each operator's booking site for pass holders, by train-api operator id. */
  booking: Record<string, string>;
  updatedAt: string;
  /** Bytes of every operator's Interrail trips: what offline mode keeps on the device. */
  bytes: number;
}

/** What offline mode holds: the timetables' date, or nothing kept. */
export interface OfflineState {
  on: boolean;
  /** train-api's updatedAt of the copy kept, "" when none is complete. */
  updatedAt: string;
}

export type EuropeReply =
  | { id: number; type: "init"; directory: EuropeDirectory | null }
  // byDate is null when the network doesn't serve a station asked for (SNCF's trains answer).
  | { id: number; type: "journeys"; byDate: Record<string, EuropeJourney[]> | null }
  | { id: number; type: "reach"; byDate: Record<string, ReachRow[]> | null }
  | { id: number; type: "offline"; state: OfflineState };

interface IndexV2 {
  updatedAt?: string;
  operators?: { id: string; passes?: { id: string; bookingUrl?: string; bytes?: number }[] }[];
}

const PASS = "interrail";

let base = "";
let offline = false;
let europe: Europe | null = null;

const hasCaches = (): boolean => typeof caches !== "undefined";

/** A train-api file: from the network, kept for offline mode; from the kept copy when the network fails. */
async function get<T>(path: string): Promise<T> {
  const url = `${base}/v2/${path}`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    if (offline && hasCaches()) await (await caches.open(OFFLINE_CACHE)).put(url, res.clone()).catch(() => undefined);
    return (await res.json()) as T;
  } catch (err) {
    const kept = hasCaches() ? await (await caches.open(OFFLINE_CACHE)).match(url).catch(() => undefined) : undefined;
    if (kept) return (await kept.json()) as T;
    throw err;
  }
}

function isBundle(x: unknown): x is SearchBundle {
  const b = x as Partial<SearchBundle> | null;
  return !!b && b.v === 2 && typeof b.operator === "string" && Array.isArray(b.dates) && Array.isArray(b.stations) && Array.isArray(b.trips);
}

function interrailOperators(index: IndexV2): { id: string; bookingUrl?: string; bytes?: number }[] {
  return (index.operators ?? []).flatMap((o) => {
    const pass = o.passes?.find((p) => p.id === PASS);
    return pass ? [{ id: o.id, bookingUrl: pass.bookingUrl, bytes: pass.bytes }] : [];
  });
}

async function init(m: Extract<EuropeRequest, { type: "init" }>): Promise<EuropeDirectory | null> {
  base = m.base;
  offline = m.offline;
  const index = await get<IndexV2>("index.json");
  const ops = interrailOperators(index);
  // An operator whose stations fail to load is left out; the others still search.
  const lists = (
    await Promise.all(
      ops.map((o) =>
        get<StationList["stations"]>(`${o.id}/stations.json`)
          .then((stations): StationList | null => (Array.isArray(stations) ? { operator: o.id, stations } : null))
          .catch(() => null),
      ),
    )
  ).filter((l): l is StationList => l !== null);
  if (lists.length === 0) return null;
  europe = new Europe(lists, m.sncfCoords);
  const booking: Record<string, string> = {};
  for (const o of ops) if (o.bookingUrl) booking[o.id] = o.bookingUrl;
  return {
    places: europe.directory(),
    booking,
    updatedAt: index.updatedAt ?? "",
    bytes: ops.reduce((n, o) => n + (o.bytes ?? 0), 0),
  };
}

/** Load the trip bundles of these operators not loaded yet (one that fails is left out). */
async function ensure(net: Europe, ops: string[]): Promise<void> {
  const bundles = await Promise.all(net.missing(ops).map((op) => get<unknown>(`${op}/${PASS}.json`).catch(() => null)));
  for (const b of bundles) if (isBundle(b)) net.addBundle(b);
}

/** The updatedAt of the complete copy kept, or "". */
async function keptState(): Promise<string> {
  if (!hasCaches()) return "";
  const cache = await caches.open(OFFLINE_CACHE);
  const index = (await (await cache.match(`${base}/v2/index.json`))?.json().catch(() => null)) as IndexV2 | null;
  if (!index) return "";
  for (const o of interrailOperators(index)) {
    if (!(await cache.match(`${base}/v2/${o.id}/stations.json`))) return "";
    if (!(await cache.match(`${base}/v2/${o.id}/${PASS}.json`))) return "";
  }
  return index.updatedAt ?? "";
}

/** Turn offline mode on (download what's missing or outdated) or off (drop the copy). */
async function setOffline(on: boolean): Promise<OfflineState> {
  offline = on;
  if (!hasCaches() || !base) return { on, updatedAt: "" };
  if (!on) {
    await caches.delete(OFFLINE_CACHE);
    return { on, updatedAt: "" };
  }
  const cache = await caches.open(OFFLINE_CACHE);
  const indexUrl = `${base}/v2/index.json`;
  const kept = (await (await cache.match(indexUrl))?.json().catch(() => null)) as IndexV2 | null;
  let res: Response;
  try {
    res = await fetch(indexUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch {
    return { on, updatedAt: await keptState() }; // offline now: keep what is there
  }
  const index = (await res.clone().json()) as IndexV2;
  const fresh = kept?.updatedAt !== index.updatedAt;
  for (const o of interrailOperators(index)) {
    for (const path of [`${o.id}/stations.json`, `${o.id}/${PASS}.json`]) {
      const url = `${base}/v2/${path}`;
      if (!fresh && (await cache.match(url))) continue;
      const file = await fetch(url).catch(() => null);
      if (file?.ok) await cache.put(url, file);
    }
  }
  // The index goes in last: a copy is complete only once every file it lists is in.
  await cache.put(indexUrl, res);
  return { on, updatedAt: await keptState() };
}

const ctx = self as unknown as {
  postMessage: (m: EuropeReply) => void;
  onmessage: ((e: MessageEvent<EuropeRequest>) => void) | null;
};

async function answer(m: EuropeRequest): Promise<EuropeReply> {
  if (m.type === "init") return { id: m.id, type: "init", directory: await init(m).catch(() => null) };
  if (m.type === "offline") return { id: m.id, type: "offline", state: await setOffline(m.on).catch(() => ({ on: m.on, updatedAt: "" })) };
  const net = europe;
  if (m.type === "journeys") {
    if (!net?.knows(m.from) || !net.knows(m.to)) return { id: m.id, type: "journeys", byDate: null };
    const ops = net.operatorsFor(m.from, m.to);
    await ensure(net, ops);
    const byDate: Record<string, EuropeJourney[]> = {};
    for (const d of m.dates) byDate[d] = net.journeys(m.from, m.to, d, m.maxTrains, ops);
    return { id: m.id, type: "journeys", byDate };
  }
  if (!net?.knows(m.from)) return { id: m.id, type: "reach", byDate: null };
  const ops = net.operatorsFor(m.from);
  await ensure(net, ops);
  const byDate: Record<string, ReachRow[]> = {};
  for (const d of m.dates) byDate[d] = net.reachable(m.from, d, m.maxTrains, ops);
  return { id: m.id, type: "reach", byDate };
}

ctx.onmessage = (e: MessageEvent<EuropeRequest>): void => {
  void answer(e.data).then((reply) => ctx.postMessage(reply));
};
