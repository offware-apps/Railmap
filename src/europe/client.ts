// Main-thread side of the Interrail Europe search: starts the worker, keeps what it has
// answered in caches the synchronous render reads, and turns its journeys into the app's.
//
// Off (every call answers "nothing") when the page has no Worker or no train-api base:
// Interrail then searches SNCF's trains alone, as before.

import type { Journey, MaxTrain } from "../types";
import { toJourney } from "../core/connections";
import { addDays, dayIndex, minutesToHHMM } from "../util/time";
import type { EuropeDirectory, EuropeReply, EuropeRequest } from "./europe.worker";
import type { EuropeJourney, ReachRow } from "./network";

/** A day's journeys between two stations are searched with up to this many trains. */
export const EUROPE_MAX_TRAINS = 7;

/** One leg's local time "YYYY-MM-DDTHH:MM" as a date and minutes past that date's midnight. */
function minutesFrom(date: string, stamp: string): number {
  return (dayIndex(stamp.slice(0, 10)) - dayIndex(date)) * 1440 + Number(stamp.slice(11, 13)) * 60 + Number(stamp.slice(14, 16));
}

/** The app's journey for one the engine found: legs between app station ids, local times. */
export function toAppJourney(j: EuropeJourney): Journey | null {
  if (j.legs.length === 0) return null;
  const legs: MaxTrain[] = j.legs.map((l) => {
    const date = l.departure.slice(0, 10);
    const departMin = minutesFrom(date, l.departure);
    const arriveMin = Math.max(departMin, minutesFrom(date, l.arrival));
    const train: MaxTrain = {
      date,
      origin: l.from,
      destination: l.to,
      depart: minutesToHHMM(departMin),
      arrive: minutesToHHMM(arriveMin),
      departMin,
      arriveMin,
      durationMin: arriveMin - departMin,
      trainNo: l.trainNo,
      available: true,
    };
    if (l.category) train.axe = l.category;
    if (l.operator !== "sncf") train.operator = l.operator;
    return train;
  });
  const out = toJourney(legs);
  // Local clocks differ across borders; the engine's duration counts real minutes.
  out.totalDurationMin = j.duration;
  return out;
}

type Pending = { msg: EuropeRequest; done: (r: EuropeReply | null) => void; urgent: boolean };

let worker: Worker | null = null;
let disabled = false;
let seq = 0;
let inFlight: Pending | null = null;
const queue: Pending[] = [];

function ensureWorker(): Worker | null {
  if (disabled) return null;
  if (worker) return worker;
  if (typeof Worker === "undefined") {
    disabled = true;
    return null;
  }
  try {
    worker = new Worker(new URL("./europe.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<EuropeReply>) => {
      const p = inFlight;
      inFlight = null;
      if (p && p.msg.id === e.data.id) p.done(e.data);
      pump();
    };
    worker.onerror = () => {
      disabled = true;
      worker = null;
      const all = [...(inFlight ? [inFlight] : []), ...queue.splice(0)];
      inFlight = null;
      for (const p of all) p.done(null);
    };
  } catch {
    disabled = true;
    worker = null;
  }
  return worker;
}

/** Send the next request: one at a time, so a search asked for now overtakes a calendar filling in. */
function pump(): void {
  if (inFlight || !worker) return;
  const next = queue.shift();
  if (!next) return;
  inFlight = next;
  try {
    worker.postMessage(next.msg);
  } catch {
    inFlight = null;
    next.done(null);
    pump();
  }
}

/** The request without its id (each type's own fields). */
type RequestBody = EuropeRequest extends infer R ? (R extends EuropeRequest ? Omit<R, "id"> : never) : never;

function ask(body: RequestBody, urgent: boolean): Promise<EuropeReply | null> {
  const w = ensureWorker();
  if (!w) return Promise.resolve(null);
  const msg = { ...body, id: ++seq } as EuropeRequest;
  return new Promise((done) => {
    const p: Pending = { msg, done, urgent };
    // Urgent requests go after the other urgent ones, ahead of background fills.
    const at = urgent ? queue.findIndex((q) => !q.urgent) : -1;
    if (at < 0) queue.push(p);
    else queue.splice(at, 0, p);
    pump();
  });
}

let directory: Promise<EuropeDirectory | null> | null = null;
let loaded: EuropeDirectory | null = null;

/** Download the network once (a few MB, compressed to about one); null when it can't load. */
export function loadEurope(base: string, sncfCoords: Record<string, [number, number]>): Promise<EuropeDirectory | null> {
  if (!base) return Promise.resolve(null);
  directory ??= ask({ type: "init", base, sncfCoords }, true).then((r) => {
    loaded = r?.type === "init" ? r.directory : null;
    return loaded;
  });
  return directory;
}

/** The loaded network's places, or null before (or without) it. */
export function europeDirectory(): EuropeDirectory | null {
  return loaded;
}

// Journeys by "from>to@date#trains", and explore rows by "from@date#trains".
const journeyCache = new Map<string, Journey[]>();
const reachCache = new Map<string, { station: string; journey: Journey }[]>();
const CACHE_LIMIT = 400;
// Routes ("from>to") and origins the network doesn't serve: SNCF's trains answer those.
const outside = new Set<string>();

function remember<T>(cache: Map<string, T>, key: string, value: T): void {
  cache.set(key, value);
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
}

function trainsFor(maxConnections: number | undefined): number {
  return Math.min(EUROPE_MAX_TRAINS, Math.max(1, (maxConnections ?? 1) + 1));
}

/** The journeys found from `from` to `to` on `date`, or undefined when not searched yet. */
export function cachedJourneys(from: string, to: string, date: string, maxConnections?: number): Journey[] | undefined {
  if (!loaded) return undefined;
  return journeyCache.get(`${from}>${to}@${date}#${trainsFor(maxConnections)}`);
}

/**
 * Search the dates not searched yet; true when some were. `urgent` puts it ahead of
 * background fills.
 */
export async function searchJourneys(
  from: string,
  to: string,
  dates: string[],
  maxConnections: number | undefined,
  urgent: boolean,
): Promise<boolean> {
  if (!loaded) return false;
  const maxTrains = trainsFor(maxConnections);
  const todo = [...new Set(dates)].filter((d) => !journeyCache.has(`${from}>${to}@${d}#${maxTrains}`));
  if (todo.length === 0) return false;
  if (outside.has(`${from}>${to}`)) return false;
  const r = await ask({ type: "journeys", from, to, dates: todo, maxTrains }, urgent);
  if (r?.type !== "journeys") return false;
  const byDate = r.byDate;
  if (!byDate) {
    outside.add(`${from}>${to}`);
    return false;
  }
  for (const d of todo) {
    const list = (byDate[d] ?? []).flatMap((j) => toAppJourney(j) ?? []);
    remember(journeyCache, `${from}>${to}@${d}#${maxTrains}`, list);
  }
  return true;
}

/** Every town reachable from `from` on `date` with its fastest journey, or undefined when not searched yet. */
export function cachedReach(from: string, date: string, maxConnections?: number): { station: string; journey: Journey }[] | undefined {
  if (!loaded) return undefined;
  return reachCache.get(`${from}@${date}#${trainsFor(maxConnections)}`);
}

export async function searchReach(from: string, dates: string[], maxConnections: number | undefined): Promise<void> {
  if (!loaded) return;
  const maxTrains = trainsFor(maxConnections);
  const todo = [...new Set(dates)].filter((d) => !reachCache.has(`${from}@${d}#${maxTrains}`));
  if (todo.length === 0) return;
  if (outside.has(from)) return;
  const r = await ask({ type: "reach", from, dates: todo, maxTrains }, true);
  if (r?.type !== "reach") return;
  const byDate = r.byDate;
  if (!byDate) {
    outside.add(from);
    return;
  }
  for (const d of todo) {
    const rows = (byDate[d] ?? []).flatMap((row: ReachRow) => {
      const journey = toAppJourney(row.journey);
      return journey ? [{ station: row.station, journey }] : [];
    });
    remember(reachCache, `${from}@${d}#${maxTrains}`, rows);
  }
}

/** The dates a round trip leaving on `date` may come back on, for the return lists and calendar. */
export function returnDates(dates: string[], extra = 3): string[] {
  const last = dates.reduce((a, d) => (d > a ? d : a), "");
  const out = new Set(dates);
  for (let i = 1; i <= extra && last; i++) out.add(addDays(last, i));
  return [...out].sort();
}
