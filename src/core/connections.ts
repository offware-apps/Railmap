import type { MaxTrain, Journey } from "../types";
import { HUB_STATIONS, MIN_CONNECTION_MIN, MAX_CONNECTION_MIN } from "../config";
import { absoluteMinute, addDays, dayIndex, parseTimeToMinutes } from "../util/time";
import { isNightTrain } from "./search";

export interface ConnectionOptions {
  /** 0 = direct only, 1 = one change (default), 2 = two changes. */
  maxConnections?: number;
  hubs?: string[];
  minConnectionMin?: number;
  maxConnectionMin?: number;
  departAfter?: string; // constrains the first leg only
  departBefore?: string;
  /** Latest acceptable arrival ("HH:MM"), compared on the absolute cross-date timeline. */
  arriveBefore?: string;
  maxDurationMin?: number; // total journey duration
  minDurationMin?: number; // skip journeys shorter than this (e.g. exclude 1 h hops)
  trainType?: string;
  /** Drop night trains (leave late or arrive past midnight) from the search. */
  excludeNight?: boolean;
  /** Only keep journeys that include at least one night train (sleep aboard). */
  onlyNight?: boolean;
  /**
   * reachableJourneys / reachableInto only: keep the EARLIEST-ARRIVING journey per
   * station (maximises time on site) instead of the shortest-duration one. Round-trip
   * "ideas" need this so their outbound matches bestGetawayTo's earliest-arrival
   * choice; one-way "best" leaves it off and keeps the fastest journey.
   */
  earliestArrival?: boolean;
  /**
   * How many calendar days of trains to pool, so a journey may chain hops with
   * multi-day stopovers at hubs ("trip over up to N days"). Default 2 — the chosen
   * day plus the next, enough for a normal connection across midnight. Larger spans
   * raise the layover ceiling to the span and widen the pool accordingly.
   */
  spanDays?: number;
}

// Safety bounds for the multi-day search: a wide span with several changes could
// otherwise enumerate an enormous number of itineraries. We stop collecting at the
// result cap, and bail the whole DFS if it expands too many nodes (pathological
// fan-out), so the search always returns promptly.
export const MAX_RESULTS = 200;
const MAX_DFS_EXPANSIONS = 400_000;

/**
 * Journeys another search already found for a route and day, or undefined when it has
 * none: Interrail across Europe, where the trip-bundle engine answers instead of this
 * file's search over SNCF's trains (see src/europe/client.ts). `maxConnections` is the
 * query's.
 */
export type JourneySource = (origin: string, destination: string, date: string, maxConnections: number) => Journey[] | undefined;

let journeySource: JourneySource | null = null;

/** Let {@link findJourneys} answer from `source` first; null goes back to the trains alone. */
export function setJourneySource(source: JourneySource | null): void {
  journeySource = source;
}

/** A found journey list narrowed to the options the source didn't search with. */
function narrowFound(list: Journey[], opts: ConnectionOptions): Journey[] {
  const after = opts.departAfter ? parseTimeToMinutes(opts.departAfter) : undefined;
  const before = opts.departBefore ? parseTimeToMinutes(opts.departBefore) : undefined;
  const arriveBy = opts.arriveBefore ? parseTimeToMinutes(opts.arriveBefore) : undefined;
  return list
    .filter((j) => {
      const last = j.legs[j.legs.length - 1];
      if (!last) return false;
      if (after !== undefined && j.departMin < after) return false;
      if (before !== undefined && j.departMin > before) return false;
      if (arriveBy !== undefined && journeyArriveAbs(j) > arriveBy) return false;
      if (opts.maxDurationMin != null && j.totalDurationMin > opts.maxDurationMin) return false;
      if (opts.minDurationMin != null && j.totalDurationMin < opts.minDurationMin) return false;
      if (opts.trainType && j.legs.some((l) => (l.axe ?? "") !== opts.trainType)) return false;
      if (opts.excludeNight && j.legs.some(isNightTrain)) return false;
      if (opts.onlyNight && !isNightTrain(last)) return false;
      return true;
    })
    .sort((a, b) => a.departMin - b.departMin || a.totalDurationMin - b.totalDurationMin || a.legs.length - b.legs.length);
}

// Cache of available trains grouped by date, keyed by the (stable, loaded-once)
// trains array. Avoids re-scanning the whole dataset on every journey lookup —
// matters when callers run findJourneys many times (30-day calendar, best mode).
const byDateCache = new WeakMap<MaxTrain[], Map<string, MaxTrain[]>>();

// Memoize journey lookups per (stable) trains array. The 30-day calendar and
// repeated / back navigation hit the same routes many times; WeakMap keying by
// the trains array keeps results correct across different datasets (e.g. tests).
const journeyCache = new WeakMap<MaxTrain[], Map<string, Journey[]>>();

function journeyMemo(trains: MaxTrain[]): Map<string, Journey[]> {
  let m = journeyCache.get(trains);
  if (!m) {
    m = new Map();
    journeyCache.set(trains, m);
  }
  return m;
}

// Memoize reachableJourneys (multi-target) per (stable) trains array. The ideas
// list and the destinations-per-day calendar both run it for the same days, so
// the second sweep is a cache hit. Callers only read the returned Map.
const reachCache = new WeakMap<MaxTrain[], Map<string, Map<string, Journey>>>();

function reachMemo(trains: MaxTrain[]): Map<string, Map<string, Journey>> {
  let m = reachCache.get(trains);
  if (!m) {
    m = new Map();
    reachCache.set(trains, m);
  }
  return m;
}

function availableByDate(trains: MaxTrain[]): Map<string, MaxTrain[]> {
  const cached = byDateCache.get(trains);
  if (cached) return cached;
  const idx = new Map<string, MaxTrain[]>();
  for (const t of trains) {
    if (!t.available) continue;
    const arr = idx.get(t.date);
    if (arr) arr.push(t);
    else idx.set(t.date, [t]);
  }
  byDateCache.set(trains, idx);
  return idx;
}

/** Build a Journey from an ordered list of legs (1..n), on an absolute timeline. */
export function toJourney(legs: MaxTrain[]): Journey {
  const first = legs[0];
  const last = legs[legs.length - 1];
  if (!first || !last) throw new Error("toJourney requires at least one leg");
  const layovers: number[] = [];
  const hubs: string[] = [];
  for (let i = 1; i < legs.length; i++) {
    const prev = legs[i - 1];
    const cur = legs[i];
    if (!prev || !cur) continue;
    layovers.push(absoluteMinute(cur.date, cur.departMin) - absoluteMinute(prev.date, prev.arriveMin));
    hubs.push(prev.destination);
  }
  return {
    date: first.date,
    origin: first.origin,
    destination: last.destination,
    legs,
    departMin: first.departMin,
    arriveMin: last.arriveMin,
    totalDurationMin:
      absoluteMinute(last.date, last.arriveMin) - absoluteMinute(first.date, first.departMin),
    connectionMin: layovers.length === 1 ? layovers[0] : undefined,
    hub: hubs.length === 1 ? hubs[0] : undefined,
    layovers,
    hubs,
  };
}

/**
 * Arrival time as minutes from the journey's START-date midnight. Use this — never
 * the bare `arriveMin` — whenever comparing "when do I get there" across journeys or
 * against a home-by ceiling: `arriveMin` is only the LAST leg's own-date minute, so a
 * journey whose final leg falls on a later day would otherwise look hours *earlier*.
 * `departMin` is on the start date and `totalDurationMin` is the true cross-date span,
 * so their sum is the real arrival offset from the start-date midnight.
 */
export function journeyArriveAbs(j: Journey): number {
  return j.departMin + j.totalDurationMin;
}

/**
 * The trains or journeys a traveller arriving on `prev` can still catch: those leaving
 * at least MIN_CONNECTION_MIN after it arrives, across dates. All of them when `prev` is null.
 */
export function catchableAfter<T extends { date: string; departMin: number }>(xs: T[], prev: Journey | null): T[] {
  if (!prev) return xs;
  const ready = absoluteMinute(prev.date, journeyArriveAbs(prev)) + MIN_CONNECTION_MIN;
  return xs.filter((x) => absoluteMinute(x.date, x.departMin) >= ready);
}

// One journey per chain of trains. A station group (LYON (intramuros)) can list one train at
// two of its stations, so the shortest row wins: the earliest arrival, or the latest boarding.
function dedupe(journeys: Journey[]): Journey[] {
  const byKey = new Map<string, Journey>();
  for (const j of journeys) {
    const key = `${j.legs.map((l) => `${l.date}/${l.trainNo}@${l.origin}`).join(">")}`;
    const cur = byKey.get(key);
    if (!cur || j.totalDurationMin < cur.totalDurationMin) byKey.set(key, j);
  }
  return [...byKey.values()];
}

/**
 * Find journeys from `origin` to `destination` departing on `date`, with up to
 * `maxConnections` changes. Connecting legs may fall on the following day, so a
 * leg arriving just after midnight can still connect; layovers and total duration
 * are computed on an absolute (cross-date) timeline. Intermediate stops must be
 * hubs; each layover must fall within the allowed window; no station is visited
 * twice. Sorted by departure, then total duration, then fewest legs.
 */
export function findJourneys(
  trains: MaxTrain[],
  origin: string,
  destination: string,
  date: string,
  opts: ConnectionOptions = {},
): Journey[] {
  const maxConn = opts.maxConnections ?? 1;
  const found = journeySource?.(origin, destination, date, maxConn);
  if (found) return narrowFound(found, opts);
  const hubSet = new Set(opts.hubs ?? HUB_STATIONS);
  const minC = opts.minConnectionMin ?? MIN_CONNECTION_MIN;
  // Pool `span` calendar days (≥2). A multi-day span also raises the layover
  // ceiling to the span, so a hop can wait days at a hub, not just hours.
  const span = Math.max(2, Math.floor(opts.spanDays ?? 2));
  const baseMaxC = opts.maxConnectionMin ?? MAX_CONNECTION_MIN;
  const maxC = span > 2 ? Math.max(baseMaxC, (span - 1) * 1440) : baseMaxC;

  const memo = journeyMemo(trains);
  const key = `${origin}>${destination}@${date}|${maxConn}|${minC}-${maxC}|${span}|${opts.departAfter ?? ""}|${opts.departBefore ?? ""}|${opts.arriveBefore ?? ""}|${opts.maxDurationMin ?? ""}|${opts.minDurationMin ?? ""}|${opts.trainType ?? ""}|${opts.excludeNight ? "nonight" : ""}|${opts.onlyNight ? "onlynight" : ""}|${[...hubSet].join(",")}`;
  const cached = memo.get(key);
  if (cached) return cached;

  // Available legs departing within the pooled window (so connections can cross
  // midnight, and multi-day trips can stop over at hubs). From a cached per-date
  // index, then sorted.
  const idx = availableByDate(trains);
  let pool: MaxTrain[] = [];
  for (let i = 0; i < span; i++) pool.push(...(idx.get(addDays(date, i)) ?? []));
  if (opts.trainType) pool = pool.filter((t) => (t.axe ?? "") === opts.trainType);
  if (opts.excludeNight) pool = pool.filter((t) => !isNightTrain(t));
  pool.sort((a, b) => absoluteMinute(a.date, a.departMin) - absoluteMinute(b.date, b.departMin));

  // The first leg must depart on `date`, within the user's time window.
  const after = opts.departAfter ? parseTimeToMinutes(opts.departAfter) : undefined;
  const before = opts.departBefore ? parseTimeToMinutes(opts.departBefore) : undefined;
  const arriveBy = opts.arriveBefore ? parseTimeToMinutes(opts.arriveBefore) : undefined;
  const firstPool = pool.filter(
    (t) =>
      t.date === date &&
      (after === undefined || t.departMin >= after) &&
      (before === undefined || t.departMin <= before),
  );

  const byOrigin = new Map<string, MaxTrain[]>();
  for (const t of pool) {
    const arr = byOrigin.get(t.origin);
    if (arr) arr.push(t);
    else byOrigin.set(t.origin, [t]);
  }

  const results: Journey[] = [];
  const path: MaxTrain[] = [];
  let expansions = 0;

  const dfs = (): void => {
    // Bounds for the multi-day search: stop once we have plenty, or if the search
    // fans out pathologically (a wide span × several changes).
    if (results.length >= MAX_RESULTS || expansions >= MAX_DFS_EXPANSIONS) return;
    expansions++;
    const last = path[path.length - 1];
    if (!last) return;
    if (last.destination === destination) {
      // "Only night trains": you must ARRIVE on a sleeper — the last leg is a night
      // train. A day hop to a hub then the sleeper in is fine; a sleeper followed by
      // a day hop is not (you wouldn't be sleeping into your destination).
      if (!opts.onlyNight || isNightTrain(last)) results.push(toJourney([...path]));
      return;
    }
    if (path.length - 1 >= maxConn) return; // used all allowed changes
    if (!hubSet.has(last.destination)) return; // intermediate must be a hub
    const visited = new Set<string>();
    for (const l of path) {
      visited.add(l.origin);
      visited.add(l.destination);
    }
    const lastArr = absoluteMinute(last.date, last.arriveMin);
    for (const nx of byOrigin.get(last.destination) ?? []) {
      if (visited.has(nx.destination)) continue;
      const layover = absoluteMinute(nx.date, nx.departMin) - lastArr;
      if (layover < minC || layover > maxC) continue;
      path.push(nx);
      dfs();
      path.pop();
    }
  };

  for (const l1 of firstPool) {
    if (l1.origin !== origin) continue;
    path.push(l1);
    dfs();
    path.pop();
  }

  let out = dedupe(results);
  if (opts.maxDurationMin != null) {
    out = out.filter((j) => j.totalDurationMin <= opts.maxDurationMin!);
  }
  if (opts.minDurationMin != null) {
    out = out.filter((j) => j.totalDurationMin >= opts.minDurationMin!);
  }
  // Latest acceptable arrival, on the absolute cross-date timeline: a journey whose
  // final leg lands after the cutoff (even the next day) is dropped.
  if (arriveBy !== undefined) {
    out = out.filter((j) => journeyArriveAbs(j) <= arriveBy);
  }
  out.sort(
    (a, b) =>
      a.departMin - b.departMin ||
      a.totalDurationMin - b.totalDurationMin ||
      a.legs.length - b.legs.length,
  );
  memo.set(key, out);
  return out;
}

/** The single best (shortest total) journey for a route, or null. */
export function bestJourney(
  trains: MaxTrain[],
  origin: string,
  destination: string,
  date: string,
  opts: ConnectionOptions = {},
): Journey | null {
  let best: Journey | null = null;
  for (const j of findJourneys(trains, origin, destination, date, opts)) {
    if (!best || j.totalDurationMin < best.totalDurationMin) best = j;
  }
  return best;
}

/**
 * Best (shortest) free-MAX journey from `origin` to EVERY reachable destination on
 * `date`, found in ONE graph search — far cheaper than calling findJourneys once
 * per candidate when you want them all (e.g. the "ideas, all days" union). Same
 * connection rules as findJourneys: intermediate stops must be hubs, layovers
 * within the window, no station visited twice, first leg departs on `date`.
 * With `arriveCeil` (minutes from `date` midnight) it keeps, per destination, the
 * LATEST-departing journey arriving by then: the forward mirror of {@link latestReturns}.
 */
export function reachableJourneys(
  trains: MaxTrain[],
  origin: string,
  date: string,
  opts: ConnectionOptions = {},
  arriveCeil?: number,
): Map<string, Journey> {
  const maxConn = opts.maxConnections ?? 1;
  const hubSet = new Set(opts.hubs ?? HUB_STATIONS);
  const minC = opts.minConnectionMin ?? MIN_CONNECTION_MIN;
  const span = Math.max(2, Math.floor(opts.spanDays ?? 2));
  const baseMaxC = opts.maxConnectionMin ?? MAX_CONNECTION_MIN;
  const maxC = span > 2 ? Math.max(baseMaxC, (span - 1) * 1440) : baseMaxC;

  const memo = reachMemo(trains);
  const key = `${origin}@${date}|${maxConn}|${minC}-${maxC}|${span}|${opts.departAfter ?? ""}|${opts.departBefore ?? ""}|${opts.arriveBefore ?? ""}|${opts.maxDurationMin ?? ""}|${opts.minDurationMin ?? ""}|${opts.trainType ?? ""}|${opts.excludeNight ? "nonight" : ""}|${opts.onlyNight ? "onlynight" : ""}|${opts.earliestArrival ? "earlyarr" : ""}|${arriveCeil ?? ""}|${[...hubSet].join(",")}`;
  const cached = memo.get(key);
  if (cached) return cached;

  const idx = availableByDate(trains);
  let pool: MaxTrain[] = [];
  for (let i = 0; i < span; i++) pool.push(...(idx.get(addDays(date, i)) ?? []));
  if (opts.trainType) pool = pool.filter((t) => (t.axe ?? "") === opts.trainType);
  if (opts.excludeNight) pool = pool.filter((t) => !isNightTrain(t));
  pool.sort((a, b) => absoluteMinute(a.date, a.departMin) - absoluteMinute(b.date, b.departMin));

  const after = opts.departAfter ? parseTimeToMinutes(opts.departAfter) : undefined;
  const before = opts.departBefore ? parseTimeToMinutes(opts.departBefore) : undefined;
  const arriveBy = opts.arriveBefore ? parseTimeToMinutes(opts.arriveBefore) : undefined;
  const firstPool = pool.filter(
    (t) =>
      t.date === date &&
      (after === undefined || t.departMin >= after) &&
      (before === undefined || t.departMin <= before),
  );

  const byOrigin = new Map<string, MaxTrain[]>();
  for (const t of pool) {
    const arr = byOrigin.get(t.origin);
    if (arr) arr.push(t);
    else byOrigin.set(t.origin, [t]);
  }

  const best = new Map<string, Journey>();
  const maxDur = opts.maxDurationMin;
  const minDur = opts.minDurationMin;
  const path: MaxTrain[] = [];

  const dfs = (): void => {
    const last = path[path.length - 1];
    if (!last) return;
    // Every station reached is itself a candidate destination — record the best
    // (shortest) journey to it.
    const j = toJourney([...path]);
    // "Only night trains": you must arrive on a sleeper (the last leg is a night train).
    const okNight = !opts.onlyNight || isNightTrain(last);
    // Honour the same min/max duration bounds as findJourneys, so callers (e.g. the
    // tour's min-per-train cap) don't get candidates the per-journey search rejects.
    const okDur = (maxDur == null || j.totalDurationMin <= maxDur) && (minDur == null || j.totalDurationMin >= minDur);
    // Latest acceptable arrival, on the absolute cross-date timeline.
    const okArrive =
      (arriveBy === undefined || journeyArriveAbs(j) <= arriveBy) && (arriveCeil === undefined || journeyArriveAbs(j) <= arriveCeil);
    if (okNight && okDur && okArrive) {
      const cur = best.get(j.destination);
      // Default: keep the fastest. earliestArrival: keep the one arriving soonest in
      // ABSOLUTE time (ties → shorter), matching bestGetawayTo so round-trip ideas
      // stay at parity. Compare journeyArriveAbs, not the leg-local arriveMin — else a
      // via-hub journey whose last leg lands the next day would falsely look earliest.
      // arriveCeil: keep the latest departure (ties → shorter), as latestReturns does.
      const better =
        !cur ||
        (arriveCeil !== undefined
          ? j.departMin > cur.departMin || (j.departMin === cur.departMin && j.totalDurationMin < cur.totalDurationMin)
          : opts.earliestArrival
            ? journeyArriveAbs(j) < journeyArriveAbs(cur) ||
              (journeyArriveAbs(j) === journeyArriveAbs(cur) && j.totalDurationMin < cur.totalDurationMin)
            : j.totalDurationMin < cur.totalDurationMin);
      if (better) best.set(j.destination, j);
    }
    if (path.length - 1 >= maxConn) return; // used all allowed changes
    if (!hubSet.has(last.destination)) return; // intermediate must be a hub
    const visited = new Set<string>();
    for (const l of path) {
      visited.add(l.origin);
      visited.add(l.destination);
    }
    const lastArr = absoluteMinute(last.date, last.arriveMin);
    for (const nx of byOrigin.get(last.destination) ?? []) {
      if (visited.has(nx.destination)) continue;
      const layover = absoluteMinute(nx.date, nx.departMin) - lastArr;
      if (layover < minC || layover > maxC) continue;
      path.push(nx);
      dfs();
      path.pop();
    }
  };

  for (const l1 of firstPool) {
    if (l1.origin !== origin) continue;
    path.push(l1);
    dfs();
    path.pop();
  }
  best.delete(origin);
  memo.set(key, best);
  return best;
}

// Memoize latestReturns (multi-source → one target) per (stable) trains array.
const returnCache = new WeakMap<MaxTrain[], Map<string, Map<string, Journey>>>();

function returnMemo(trains: MaxTrain[]): Map<string, Map<string, Journey>> {
  let m = returnCache.get(trains);
  if (!m) {
    m = new Map();
    returnCache.set(trains, m);
  }
  return m;
}

/**
 * For every station that can reach `target` with a journey whose FIRST leg departs
 * on `date`, the return with the LATEST first-leg departure that still arrives by
 * `arriveCeil` (minutes from `date` midnight; e.g. 1440 = home by midnight). The
 * backward mirror of {@link reachableJourneys} — ONE multi-source sweep — so a whole
 * month of round-trip returns costs a pass per day instead of a search per
 * destination. Same connection rules (hub changes, layover window, no station twice).
 */
export function latestReturns(
  trains: MaxTrain[],
  target: string,
  date: string,
  arriveCeil: number,
  opts: ConnectionOptions = {},
): Map<string, Journey> {
  const maxConn = opts.maxConnections ?? 1;
  const hubSet = new Set(opts.hubs ?? HUB_STATIONS);
  const minC = opts.minConnectionMin ?? MIN_CONNECTION_MIN;
  const span = Math.max(2, Math.floor(opts.spanDays ?? 2));
  const baseMaxC = opts.maxConnectionMin ?? MAX_CONNECTION_MIN;
  const maxC = span > 2 ? Math.max(baseMaxC, (span - 1) * 1440) : baseMaxC;

  const memo = returnMemo(trains);
  const key = `${target}@${date}|${arriveCeil}|${maxConn}|${minC}-${maxC}|${span}|${opts.departAfter ?? ""}|${opts.departBefore ?? ""}|${opts.maxDurationMin ?? ""}|${opts.trainType ?? ""}|${opts.excludeNight ? "nonight" : ""}|${opts.onlyNight ? "onlynight" : ""}|${[...hubSet].join(",")}`;
  const cached = memo.get(key);
  if (cached) return cached;

  const idx = availableByDate(trains);
  let pool: MaxTrain[] = [];
  for (let i = 0; i < span; i++) pool.push(...(idx.get(addDays(date, i)) ?? []));
  if (opts.trainType) pool = pool.filter((t) => (t.axe ?? "") === opts.trainType);
  if (opts.excludeNight) pool = pool.filter((t) => !isNightTrain(t));

  // The first (departing) leg must respect the user's depart-time window — same as
  // findJourneys/reachableJourneys, so the Ideas return is filtered like Where-to's.
  const after = opts.departAfter ? parseTimeToMinutes(opts.departAfter) : undefined;
  const before = opts.departBefore ? parseTimeToMinutes(opts.departBefore) : undefined;

  const dateMidnight = dayIndex(date) * 1440;
  // Index by ARRIVAL station, to walk a journey backward from `target`.
  const byDestination = new Map<string, MaxTrain[]>();
  for (const t of pool) {
    const arr = byDestination.get(t.destination);
    if (arr) arr.push(t);
    else byDestination.set(t.destination, [t]);
  }

  const maxDur = opts.maxDurationMin;
  const best = new Map<string, Journey>();
  const path: MaxTrain[] = []; // reverse order; path[0] = the first (earliest) leg

  const consider = (): void => {
    const head = path[0];
    if (!head || head.date !== date) return; // the first leg must depart on `date`
    if (after !== undefined && head.departMin < after) return; // outside depart window
    if (before !== undefined && head.departMin > before) return;
    const last = path[path.length - 1];
    if (!last) return;
    // Arrival (minutes from `date` midnight) must be within the home-by ceiling.
    if (absoluteMinute(last.date, last.arriveMin) - dateMidnight > arriveCeil) return;
    if (opts.onlyNight && !isNightTrain(last)) return;
    const j = toJourney([...path]);
    if (maxDur != null && j.totalDurationMin > maxDur) return;
    const cur = best.get(head.origin);
    // Keep the latest-departing return (ties broken by the shorter journey).
    if (!cur || head.departMin > cur.departMin || (head.departMin === cur.departMin && j.totalDurationMin < cur.totalDurationMin)) {
      best.set(head.origin, j);
    }
  };

  const dfs = (): void => {
    consider();
    if (path.length - 1 >= maxConn) return;
    const head = path[0];
    if (!head || !hubSet.has(head.origin)) return; // a prepended change must be at a hub
    const visited = new Set<string>();
    for (const l of path) {
      visited.add(l.origin);
      visited.add(l.destination);
    }
    const headDep = absoluteMinute(head.date, head.departMin);
    for (const pv of byDestination.get(head.origin) ?? []) {
      if (visited.has(pv.origin)) continue;
      const layover = headDep - absoluteMinute(pv.date, pv.arriveMin);
      if (layover < minC || layover > maxC) continue;
      path.unshift(pv);
      dfs();
      path.shift();
    }
  };

  for (const last of byDestination.get(target) ?? []) {
    path.push(last);
    dfs();
    path.pop();
  }
  best.delete(target);
  memo.set(key, best);
  return best;
}

// Memoize reachableInto (multi-source → one target, fastest) per (stable) trains array.
const intoCache = new WeakMap<MaxTrain[], Map<string, Map<string, Journey>>>();

function intoMemo(trains: MaxTrain[]): Map<string, Map<string, Journey>> {
  let m = intoCache.get(trains);
  if (!m) {
    m = new Map();
    intoCache.set(trains, m);
  }
  return m;
}

/**
 * For every station that can reach `target`, the FASTEST journey into it whose first
 * leg departs on `date` — the backward mirror of {@link reachableJourneys} (one
 * multi-source sweep), so the "where can I come FROM" browse costs a single pass
 * instead of a per-origin search. Same connection rules (hub changes, layover window,
 * no station twice) as the forward search. Derived from {@link latestReturns} but
 * without the home-by ceiling and keeping the shortest journey (or, with
 * `earliestArrival`, the earliest-arriving one), not the latest.
 */
export function reachableInto(
  trains: MaxTrain[],
  target: string,
  date: string,
  opts: ConnectionOptions = {},
): Map<string, Journey> {
  const maxConn = opts.maxConnections ?? 1;
  const hubSet = new Set(opts.hubs ?? HUB_STATIONS);
  const minC = opts.minConnectionMin ?? MIN_CONNECTION_MIN;
  const span = Math.max(2, Math.floor(opts.spanDays ?? 2));
  const baseMaxC = opts.maxConnectionMin ?? MAX_CONNECTION_MIN;
  const maxC = span > 2 ? Math.max(baseMaxC, (span - 1) * 1440) : baseMaxC;

  const memo = intoMemo(trains);
  const key = `${target}@${date}|${maxConn}|${minC}-${maxC}|${span}|${opts.departAfter ?? ""}|${opts.departBefore ?? ""}|${opts.arriveBefore ?? ""}|${opts.maxDurationMin ?? ""}|${opts.trainType ?? ""}|${opts.excludeNight ? "nonight" : ""}|${opts.onlyNight ? "onlynight" : ""}|${opts.earliestArrival ? "earlyarr" : ""}|${[...hubSet].join(",")}`;
  const cached = memo.get(key);
  if (cached) return cached;

  const idx = availableByDate(trains);
  let pool: MaxTrain[] = [];
  for (let i = 0; i < span; i++) pool.push(...(idx.get(addDays(date, i)) ?? []));
  if (opts.trainType) pool = pool.filter((t) => (t.axe ?? "") === opts.trainType);
  if (opts.excludeNight) pool = pool.filter((t) => !isNightTrain(t));

  const after = opts.departAfter ? parseTimeToMinutes(opts.departAfter) : undefined;
  const before = opts.departBefore ? parseTimeToMinutes(opts.departBefore) : undefined;
  const arriveBy = opts.arriveBefore ? parseTimeToMinutes(opts.arriveBefore) : undefined;
  const maxDur = opts.maxDurationMin;

  // Index by ARRIVAL station, to walk a journey backward from `target`.
  const byDestination = new Map<string, MaxTrain[]>();
  for (const t of pool) {
    const arr = byDestination.get(t.destination);
    if (arr) arr.push(t);
    else byDestination.set(t.destination, [t]);
  }

  const best = new Map<string, Journey>();
  const path: MaxTrain[] = []; // reverse order; path[0] = the first (earliest) leg

  const consider = (): void => {
    const head = path[0];
    if (!head || head.date !== date) return; // the first leg must depart on `date`
    if (after !== undefined && head.departMin < after) return;
    if (before !== undefined && head.departMin > before) return;
    const last = path[path.length - 1];
    if (!last) return;
    if (opts.onlyNight && !isNightTrain(last)) return;
    const j = toJourney([...path]);
    if (maxDur != null && j.totalDurationMin > maxDur) return;
    if (arriveBy !== undefined && journeyArriveAbs(j) > arriveBy) return;
    const cur = best.get(head.origin);
    // Keep the shortest journey into the target, or with earliestArrival the one arriving
    // soonest (ties → shorter), as reachableJourneys does.
    const better =
      !cur ||
      (opts.earliestArrival
        ? journeyArriveAbs(j) < journeyArriveAbs(cur) ||
          (journeyArriveAbs(j) === journeyArriveAbs(cur) && j.totalDurationMin < cur.totalDurationMin)
        : j.totalDurationMin < cur.totalDurationMin);
    if (better) best.set(head.origin, j);
  };

  const dfs = (): void => {
    consider();
    if (path.length - 1 >= maxConn) return;
    const head = path[0];
    if (!head || !hubSet.has(head.origin)) return; // a prepended change must be at a hub
    const visited = new Set<string>();
    for (const l of path) {
      visited.add(l.origin);
      visited.add(l.destination);
    }
    const headDep = absoluteMinute(head.date, head.departMin);
    for (const pv of byDestination.get(head.origin) ?? []) {
      if (visited.has(pv.origin)) continue;
      const layover = headDep - absoluteMinute(pv.date, pv.arriveMin);
      if (layover < minC || layover > maxC) continue;
      path.unshift(pv);
      dfs();
      path.shift();
    }
  };

  for (const last of byDestination.get(target) ?? []) {
    path.push(last);
    dfs();
    path.pop();
  }
  best.delete(target);
  memo.set(key, best);
  return best;
}

/**
 * How many calendar days a journey straddles: 1 = same-day, 2 = arrives the next
 * day, etc. Computed from the LAST leg's own date plus its past-midnight rollover
 * (overnight stopovers can put later legs days after the first), relative to the
 * journey's start date.
 */
export function journeySpanDays(j: Journey): number {
  const last = j.legs[j.legs.length - 1];
  if (!last) return 1;
  const endDay = dayIndex(last.date) + Math.floor(last.arriveMin / 1440);
  return endDay - dayIndex(j.date) + 1;
}

// --- cache transfer (background-worker warming) -----------------------------
// A serialisable snapshot of the connection caches, so a worker can run the heavy
// search compute off the main thread and hand the results back to warm these caches:
// the (synchronous) render then runs as cache hits. Journey values are plain objects,
// so they structured-clone across the worker boundary.

type ReachEntries = [string, [string, Journey][]][];

export interface ConnCacheDump {
  journeys: [string, Journey[]][];
  reach: ReachEntries;
  returns: ReachEntries;
  into: ReachEntries;
}

const dumpReach = (m: Map<string, Map<string, Journey>>): ReachEntries =>
  [...m].map(([k, v]) => [k, [...v]]);

/** Snapshot every connection cache for a (stable) trains array. */
export function dumpConnCaches(trains: MaxTrain[]): ConnCacheDump {
  return {
    journeys: [...journeyMemo(trains)],
    reach: dumpReach(reachMemo(trains)),
    returns: dumpReach(returnMemo(trains)),
    into: dumpReach(intoMemo(trains)),
  };
}

/** Merge a {@link dumpConnCaches} snapshot into the caches for a trains array, so
 *  later lookups with the same keys return instantly instead of recomputing. */
export function restoreConnCaches(trains: MaxTrain[], d: ConnCacheDump): void {
  const jm = journeyMemo(trains);
  for (const [k, v] of d.journeys) jm.set(k, v);
  const rm = reachMemo(trains);
  for (const [k, v] of d.reach) rm.set(k, new Map(v));
  const retm = returnMemo(trains);
  for (const [k, v] of d.returns) retm.set(k, new Map(v));
  const im = intoMemo(trains);
  for (const [k, v] of d.into) im.set(k, new Map(v));
}

/** Empty every connection cache for a trains array (the worker clears before each
 *  warm so its dump carries only that search's working set, not the whole session). */
export function clearConnCaches(trains: MaxTrain[]): void {
  journeyMemo(trains).clear();
  reachMemo(trains).clear();
  returnMemo(trains).clear();
  intoMemo(trains).clear();
}
