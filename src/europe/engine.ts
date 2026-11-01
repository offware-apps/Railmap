// Vendored from train-api (github.com/offware-apps/train-api, src/search.ts): keep the two
// files identical apart from this header, so fixes flow both ways.

/**
 * Journey search on trip bundles (v2): the fastest ways from one place to another on a
 * date, with changes, across every operator loaded.
 *
 * Stations are matched across operators by position (and by name where a source has no
 * coordinates), and grouped into towns, so a change can cross town (Paris Nord to Gare de
 * Lyon) without any hand-written list. The search is a connection scan with one label per
 * number of trains used: one pass over the day's hops, sorted by departure, finds the
 * earliest arrival with 1, 2, … trains at once. Repeating it from just after each found
 * departure gives the next journeys; the ones another beats (leaving later, arriving
 * earlier, with no more changes) are dropped.
 *
 * Pure: no imports. It runs in a browser worker, Node or a server; copy this file.
 */

/** A trip bundle as published under /v2/ (see src/bundle.ts). */
export interface SearchBundle {
  v: 2;
  operator: string;
  dates: string[];
  stations: [string, number | null, number | null][];
  families: string[];
  trips: [string, number, string, number[], number[]][];
}

/** One station, as every operator serving it names it. */
export interface Place {
  id: string;
  name: string;
  lat: number | null;
  lon: number | null;
  /** The town's id: every place of one town shares it. */
  city: string;
  stations: { operator: string; name: string }[];
  /** How many trips call here: how busy the place is, to rank places. */
  calls: number;
}

/** What a name or an id resolves to: one station, or every station of a town. */
export interface Match {
  id: string;
  name: string;
  kind: "city" | "station";
  /** Indexes into `places`. */
  places: number[];
}

export interface Leg {
  operator: string;
  trainNo: string;
  category?: string;
  from: string;
  to: string;
  /** Local times at each end, "YYYY-MM-DDTHH:MM". */
  departure: string;
  arrival: string;
  /** Stops after `from`, `to` included. */
  stops: number;
}

export interface Journey {
  departure: string;
  arrival: string;
  /** Minutes door to door, time zones accounted for. */
  duration: number;
  changes: number;
  legs: Leg[];
}

export interface NetworkOptions {
  /** Minutes to change trains within one station. Default 10. */
  change?: number;
  /** Minutes to change at a station two operators serve. Default 15. */
  changeOperators?: number;
  /** Minutes each operator's local time is ahead of Central European Time. */
  utcOffsets?: Record<string, number>;
}

export interface SearchOptions {
  /** Earliest departure, local "HH:MM" at the origin. Default 00:00. */
  time?: string;
  /** Most trains in one journey. Default 4 (3 changes). */
  maxTrains?: number;
  /** How many journeys to return, earliest departures first. Default 5. */
  results?: number;
}

/** Operators whose clock is not Central European Time, in minutes ahead of it. */
export const UTC_OFFSETS: Record<string, number> = { gb: -60, ie: -60, pt: -60, fi: 60, ee: 60, lv: 60, lt: 60, gr: 60, ro: 60, bg: 60 };

/** Words that say "station" in some language and don't tell stations apart. */
const GENERIC = new Set([
  "hbf", "hauptbahnhof", "bahnhof", "bf", "hb", "centraal", "centrale", "central", "centralstation", "c",
  "station", "stazione", "gare", "estacion", "estacio", "sbb", "cff", "ffs", "intramuros", "s", "h",
]);

/** Words that can start a station's name without naming its town. */
const NOT_A_TOWN = new Set(["saint", "st", "ste", "sainte", "san", "santa", "sankt", "le", "la", "les", "el", "los", "las", "de", "den", "der"]);

/** Accents folded, lowercase, punctuation to spaces, generic words dropped. "Zürich HB" → "zurich". */
export function normalize(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter((w) => w && !GENERIC.has(w))
    .join(" ");
}

function slug(s: string): string {
  return s.replace(/ /g, "-") || "station";
}

function title(s: string): string {
  return s.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/** Kilometres between two points. */
export function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = Math.PI / 180;
  const x = (lon2 - lon1) * r * Math.cos(((lat1 + lat2) / 2) * r);
  const y = (lat2 - lat1) * r;
  return 6371 * Math.sqrt(x * x + y * y);
}

/** Two stations closer than this are one station. */
const SAME_STATION_KM = 0.3;
/** Two stations of one name closer than this are one station. */
const SAME_NAME_KM = 3;
/** Stations of one town are at most this far apart. */
const TOWN_KM = 20;
/** Minutes to cross town when a station's position is unknown. */
const CROSS_TOWN = 60;

class UnionFind {
  private readonly parent: Int32Array;
  constructor(n: number) {
    this.parent = Int32Array.from({ length: n }, (_, i) => i);
  }
  find(i: number): number {
    let r = i;
    while (this.parent[r] !== r) r = this.parent[r] as number;
    while (this.parent[i] !== r) {
      const next = this.parent[i] as number;
      this.parent[i] = r;
      i = next;
    }
    return r;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[Math.max(ra, rb)] = Math.min(ra, rb);
  }
}

interface RawStation {
  operator: string;
  name: string;
  norm: string;
  lat: number | null;
  lon: number | null;
}

/** Every pair of located items closer than `km`, by a sweep over latitude. */
function closePairs(items: { lat: number; lon: number; i: number }[], km: number, onPair: (a: number, b: number, d: number) => void): void {
  const sorted = [...items].sort((a, b) => a.lat - b.lat);
  const dLat = km / 111;
  for (let x = 0; x < sorted.length; x++) {
    const a = sorted[x] as { lat: number; lon: number; i: number };
    for (let y = x + 1; y < sorted.length; y++) {
      const b = sorted[y] as { lat: number; lon: number; i: number };
      if (b.lat - a.lat > dLat) break;
      const d = distanceKm(a.lat, a.lon, b.lat, b.lon);
      if (d <= km) onPair(a.i, b.i, d);
    }
  }
}

/** A search date's hops, sorted by departure; times in minutes from midnight CET of that date. */
interface Hops {
  dep: Int32Array;
  arr: Int32Array;
  from: Int32Array;
  to: Int32Array;
  /** Trip instance: global trip index + day slot × trip count. */
  inst: Int32Array;
  /** Position of the hop's first stop in its trip. */
  hop: Int16Array;
}

const INF = 0x3fffffff;
/** Service days around the search date whose trips can matter: the day before runs past midnight. */
const DAY_SLOTS = [-1, 0, 1];

function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

function hhmm(min: number): string {
  const m = ((min % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** Local "YYYY-MM-DDTHH:MM" for minutes from midnight of `date` (may run past 1440 or below 0). */
function stamp(date: string, min: number): string {
  return `${addDays(date, Math.floor(min / 1440))}T${hhmm(min)}`;
}

function runsOn(mask: string, i: number): boolean {
  const digit = mask.charCodeAt(i >> 2);
  if (Number.isNaN(digit)) return false;
  const n = digit <= 57 ? digit - 48 : (digit | 32) - 87;
  return (n & (1 << (i & 3))) !== 0;
}

/** One scan's labels, per number of trains k (index k*n + place). */
interface Labels {
  n: number;
  K: number;
  arrival: Int32Array;
  legBoard: Int32Array;
  legAlight: Int32Array;
  readyFrom: Int32Array;
  readyLevel: Int8Array;
  atTarget: Int32Array;
  targetPlace: Int32Array;
}

interface Found {
  dep: number;
  arr: number;
  journey: Journey;
}

export class Network {
  readonly places: Place[] = [];
  private readonly bundles: SearchBundle[];
  /** Per bundle: each station index → place index. */
  private readonly placeOf: Int32Array[];
  /** Per bundle: the global index of its first trip. */
  private readonly tripBase: number[];
  private readonly tripCount: number;
  private readonly offsets: number[];
  /** Minutes to change trains at each place. */
  private readonly change: Int32Array;
  /** Per place: the other places of its town, with the minutes to cross. */
  private readonly walks: { to: number; minutes: number }[][];
  private readonly cities = new Map<string, { name: string; places: number[] }>();
  private readonly hopsCache = new Map<string, Hops>();

  constructor(bundles: SearchBundle[], opts: NetworkOptions = {}) {
    this.bundles = bundles;
    const offsets = { ...UTC_OFFSETS, ...opts.utcOffsets };
    this.offsets = bundles.map((b) => offsets[b.operator] ?? 0);
    let base = 0;
    this.tripBase = bundles.map((b) => {
      const at = base;
      base += b.trips.length;
      return at;
    });
    this.tripCount = base;

    // 1. Every operator's stations, each once.
    const raw: RawStation[] = [];
    const rawIdx = new Map<string, number>();
    const stationRaw = bundles.map((b) =>
      Int32Array.from(b.stations, ([name, lat, lon]) => {
        const key = `${b.operator}\u0000${name}`;
        let i = rawIdx.get(key);
        if (i === undefined) {
          i = raw.length;
          rawIdx.set(key, i);
          raw.push({ operator: b.operator, name, norm: normalize(name) || name.toLowerCase(), lat, lon });
        }
        return i;
      }),
    );

    // 2. One place per station: close together, or the same name nearby (or with no position).
    const same = new UnionFind(raw.length);
    const located = raw.flatMap((s, i) => (s.lat === null || s.lon === null ? [] : [{ lat: s.lat, lon: s.lon, i }]));
    closePairs(located, SAME_NAME_KM, (a, b, d) => {
      if (d <= SAME_STATION_KM || (raw[a] as RawStation).norm === (raw[b] as RawStation).norm) same.union(a, b);
    });
    const byNorm = new Map<string, number[]>();
    raw.forEach((s, i) => {
      const list = byNorm.get(s.norm);
      if (list) list.push(i);
      else byNorm.set(s.norm, [i]);
    });
    for (const list of byNorm.values()) {
      const unlocated = list.filter((i) => (raw[i] as RawStation).lat === null);
      if (unlocated.length === 0) continue;
      // A name with no position joins the station of that name, when only one has it.
      const roots = new Set(list.filter((i) => (raw[i] as RawStation).lat !== null).map((i) => same.find(i)));
      const target = roots.size === 1 ? [...roots][0] as number : unlocated[0] as number;
      for (const i of unlocated) same.union(i, target);
    }
    // How many trips call at each station: a place is named after its busiest one.
    const calls = new Int32Array(raw.length);
    bundles.forEach((b, bi) => {
      const ids = stationRaw[bi] as Int32Array;
      for (const t of b.trips) for (const si of t[3]) calls[ids[si] as number] = (calls[ids[si] as number] as number) + 1;
    });
    const rawPlace = new Int32Array(raw.length);
    const rootPlace = new Map<number, number>();
    const namedBy: number[] = [];
    raw.forEach((s, i) => {
      const root = same.find(i);
      let p = rootPlace.get(root);
      if (p === undefined) {
        p = this.places.length;
        rootPlace.set(root, p);
        this.places.push({ id: "", name: s.name, lat: s.lat, lon: s.lon, city: "", stations: [], calls: 0 });
        namedBy.push(i);
      }
      const place = this.places[p] as Place;
      place.stations.push({ operator: s.operator, name: s.name });
      place.calls += calls[i] as number;
      // Named and placed after its busiest station with a position (GTFS names read best).
      const cur = raw[namedBy[p] as number] as RawStation;
      const located = s.lat !== null && s.lon !== null;
      const curLocated = cur.lat !== null && cur.lon !== null;
      if ((located && !curLocated) || (located === curLocated && (calls[i] as number) > (calls[namedBy[p] as number] as number))) {
        namedBy[p] = i;
        place.name = s.name;
        place.lat = s.lat;
        place.lon = s.lon;
      }
      rawPlace[i] = p;
    });
    // A name the place's other stations agree on beats a busier one: first the name most
    // of them normalize to ("Zürich HB" over the quay's "Zürich, Bahnhofquai"), then one
    // sharing a word with most (Munich is "München Hbf", not the tram stop "Hauptbahnhof
    // (U, Tram)" that merged into it), then the busiest.
    const byPlace: number[][] = this.places.map(() => []);
    raw.forEach((_, i) => byPlace[rawPlace[i] as number]?.push(i));
    const words = raw.map((s) => new Set(s.norm.split(" ").filter((w) => w.length >= 3)));
    byPlace.forEach((list, p) => {
      if (list.length < 3) return;
      const located = (i: number): boolean => raw[i]?.lat !== null && raw[i]?.lon !== null;
      const score = (i: number): [number, number, number] => {
        let same = 0;
        let shared = 0;
        for (const j of list) {
          if (j === i) continue;
          if (raw[j]?.norm === raw[i]?.norm) same++;
          if ([...(words[i] as Set<string>)].some((w) => words[j]?.has(w))) shared++;
        }
        return [same, shared, calls[i] as number];
      };
      const better = (a: [number, number, number], b: [number, number, number]): boolean =>
        a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] > b[2];
      const cur = namedBy[p] as number;
      let best = cur;
      let bestScore = score(cur);
      for (const i of list) {
        if (located(i) !== located(cur)) continue;
        const sc = score(i);
        if (better(sc, bestScore)) {
          best = i;
          bestScore = sc;
        }
      }
      if (best === cur) return;
      const s = raw[best] as RawStation;
      const place = this.places[p] as Place;
      namedBy[p] = best;
      place.name = s.name;
      place.lat = s.lat;
      place.lon = s.lon;
    });
    this.placeOf = stationRaw.map((ids) => Int32Array.from(ids, (i) => rawPlace[i] as number));
    const n = this.places.length;
    const change = opts.change ?? 10;
    const changeOperators = opts.changeOperators ?? 15;
    this.change = Int32Array.from(this.places, (p) =>
      new Set(p.stations.map((s) => s.operator)).size > 1 ? changeOperators : change,
    );

    // 3. Towns: places whose names start with one town's name, near each other.
    const townWord = this.places.map((p) => {
      const w = normalize(p.name).split(" ")[0] ?? "";
      return w.length >= 3 && !NOT_A_TOWN.has(w) && !/^\d+$/.test(w) ? w : "";
    });
    const town = new UnionFind(n);
    const placedLocated = this.places.flatMap((p, i) => (p.lat === null || p.lon === null ? [] : [{ lat: p.lat, lon: p.lon, i }]));
    closePairs(placedLocated, TOWN_KM, (a, b) => {
      if (townWord[a] && townWord[a] === townWord[b]) town.union(a, b);
    });
    const townsByWord = new Map<string, Set<number>>();
    placedLocated.forEach(({ i }) => {
      const w = townWord[i] as string;
      if (!w) return;
      const set = townsByWord.get(w) ?? new Set<number>();
      set.add(town.find(i));
      townsByWord.set(w, set);
    });
    this.places.forEach((p, i) => {
      const w = townWord[i] as string;
      if (p.lat !== null || !w) return;
      const roots = townsByWord.get(w);
      if (roots?.size === 1) town.union(i, [...roots][0] as number);
    });
    const members = new Map<number, number[]>();
    for (let i = 0; i < n; i++) {
      const r = town.find(i);
      const list = members.get(r);
      if (list) list.push(i);
      else members.set(r, [i]);
    }
    this.walks = Array.from({ length: n }, () => []);
    const usedIds = new Set<string>();
    for (const list of members.values()) {
      if (list.length < 2) continue;
      for (const a of list) {
        for (const b of list) {
          if (a === b) continue;
          const pa = this.places[a] as Place;
          const pb = this.places[b] as Place;
          const minutes =
            pa.lat === null || pa.lon === null || pb.lat === null || pb.lon === null
              ? CROSS_TOWN
              : Math.min(CROSS_TOWN, Math.max(20, Math.round(15 + 8 * distanceKm(pa.lat, pa.lon, pb.lat, pb.lon))));
          (this.walks[a] as { to: number; minutes: number }[]).push({ to: b, minutes });
        }
      }
      const word = townWord[list[0] as number] as string;
      let id = slug(word);
      for (let k = 2; usedIds.has(id); k++) id = `${slug(word)}-${k}`;
      usedIds.add(id);
      this.cities.set(id, { name: title(word), places: list });
      for (const i of list) (this.places[i] as Place).city = id;
    }
    this.places.forEach((p) => {
      const base = slug(normalize(p.name) || p.name.toLowerCase());
      let id = base;
      for (let k = 2; usedIds.has(id); k++) id = `${base}-${k}`;
      usedIds.add(id);
      p.id = id;
      if (!p.city) p.city = id;
    });
  }

  /** The place of one operator's station, or -1. */
  placeIndex(operator: string, name: string): number {
    const bi = this.bundles.findIndex((b) => b.operator === operator);
    if (bi < 0) return -1;
    const si = (this.bundles[bi] as SearchBundle).stations.findIndex((s) => s[0] === name);
    return si < 0 ? -1 : ((this.placeOf[bi] as Int32Array)[si] ?? -1);
  }

  /** Every service date some bundle covers, sorted. */
  dates(): string[] {
    return [...new Set(this.bundles.flatMap((b) => b.dates))].sort();
  }

  /** Towns and stations whose names contain the query, best first. */
  find(query: string, limit = 10): Match[] {
    const q = normalize(query) || query.toLowerCase().trim();
    if (!q) return [];
    const scored: { m: Match; score: number }[] = [];
    const score = (names: string[]): number => {
      let best = Infinity;
      for (const n of names) {
        if (n === q) best = Math.min(best, 0);
        else if (n.startsWith(q)) best = Math.min(best, 1);
        else if (n.includes(q)) best = Math.min(best, 2);
      }
      return best;
    };
    for (const [id, c] of this.cities) {
      const s = score([normalize(c.name)]);
      // A town ranks above its own stations.
      if (s < Infinity) scored.push({ m: { id, name: c.name, kind: "city", places: c.places }, score: s * 1000 - 500 });
    }
    this.places.forEach((p, i) => {
      const s = score([normalize(p.name), ...p.stations.map((st) => normalize(st.name))]);
      if (s < Infinity) scored.push({ m: { id: p.id, name: p.name, kind: "station", places: [i] }, score: s * 1000 - p.stations.length });
    });
    return scored.sort((a, b) => a.score - b.score).slice(0, limit).map((s) => s.m);
  }

  /** A town or station by id, else the best match for a name. */
  resolve(idOrName: string): Match | null {
    const city = this.cities.get(idOrName);
    if (city) return { id: idOrName, name: city.name, kind: "city", places: city.places };
    const i = this.places.findIndex((p) => p.id === idOrName);
    if (i >= 0) return { id: idOrName, name: (this.places[i] as Place).name, kind: "station", places: [i] };
    return this.find(idOrName, 1)[0] ?? null;
  }

  /** The hops of every trip that can run on `date`, on one clock: minutes from midnight CET of `date`. */
  private hops(date: string): Hops {
    const hit = this.hopsCache.get(date);
    if (hit) return hit;
    // Two passes over the trips running: count, then fill typed arrays (a day of Europe is
    // hundreds of thousands of hops; plain arrays of numbers would cost several times more).
    const each = (visit: (dep: number, arr: number, from: number, to: number, inst: number, hop: number) => void): void => {
      this.bundles.forEach((b, bi) => {
        const places = this.placeOf[bi] as Int32Array;
        const offset = this.offsets[bi] as number;
        DAY_SLOTS.forEach((d, slot) => {
          const di = b.dates.indexOf(addDays(date, d));
          if (di < 0) return;
          const shift = d * 1440 - offset;
          b.trips.forEach((t, ti) => {
            if (!runsOn(t[2], di)) return;
            const ids = t[3];
            const min = t[4];
            const inst = (this.tripBase[bi] as number) + ti + slot * this.tripCount;
            for (let i = 0; i + 1 < ids.length; i++) {
              const from = places[ids[i] as number] ?? -1;
              const to = places[ids[i + 1] as number] ?? -1;
              const dep = min[2 * i + 1] as number;
              const arr = min[2 * i + 2] as number;
              if (from < 0 || to < 0 || arr < dep) continue;
              visit(dep + shift, arr + shift, from, to, inst, i);
            }
          });
        });
      });
    };
    let count = 0;
    let minDep = INF;
    let maxDep = -INF;
    each((dep) => {
      count++;
      if (dep < minDep) minDep = dep;
      if (dep > maxDep) maxDep = dep;
    });
    // Counting sort by departure minute: times span a few days, so it's linear.
    const buckets = new Int32Array(count ? maxDep - minDep + 2 : 1);
    each((dep) => {
      buckets[dep - minDep + 1] = (buckets[dep - minDep + 1] as number) + 1;
    });
    for (let i = 1; i < buckets.length; i++) buckets[i] = (buckets[i] as number) + (buckets[i - 1] as number);
    const hops: Hops = {
      dep: new Int32Array(count),
      arr: new Int32Array(count),
      from: new Int32Array(count),
      to: new Int32Array(count),
      inst: new Int32Array(count),
      hop: new Int16Array(count),
    };
    each((dep, arr, from, to, inst, hop) => {
      const at = buckets[dep - minDep] as number;
      buckets[dep - minDep] = at + 1;
      hops.dep[at] = dep;
      hops.arr[at] = arr;
      hops.from[at] = from;
      hops.to[at] = to;
      hops.inst[at] = inst;
      hops.hop[at] = hop;
    });
    this.hopsCache.set(date, hops);
    // Keep the last few dates searched.
    while (this.hopsCache.size > 4) this.hopsCache.delete(this.hopsCache.keys().next().value as string);
    return hops;
  }

  /** Journeys from one town or station to another on `date` (local "YYYY-MM-DD" at the origin). */
  journeys(from: Match | number[], to: Match | number[], date: string, opts: SearchOptions = {}): Journey[] {
    const origins = Array.isArray(from) ? from : from.places;
    const targets = Array.isArray(to) ? to : to.places;
    if (origins.length === 0 || targets.length === 0 || origins.some((p) => targets.includes(p))) return [];
    const wanted = opts.results ?? 5;
    const maxTrains = Math.min(8, Math.max(1, opts.maxTrains ?? 4));
    const hops = this.hops(date);
    const originOffset = this.offsetAt(origins[0] as number);
    let start = (opts.time ? Number(opts.time.slice(0, 2)) * 60 + Number(opts.time.slice(3, 5)) : 0) - originOffset;
    // Journeys leave on the date asked for, by the origin's clock; they may arrive later.
    const dayEnd = 1440 - originOffset;
    const found: Found[] = [];
    const seen = new Set<string>();
    for (let pass = 0; pass < wanted * 4 && start < dayEnd; pass++) {
      const batch = this.scan(hops, origins, targets, start, maxTrains, date).filter((j) => j.dep < dayEnd);
      if (batch.length === 0) break;
      let first = Infinity;
      for (const j of batch) {
        first = Math.min(first, j.dep);
        const key = j.journey.legs.map((l) => `${l.operator}/${l.trainNo}/${l.departure}`).join("|");
        if (seen.has(key)) continue;
        seen.add(key);
        found.push(j);
      }
      start = first + 1;
      if (paretoFront(found).length >= wanted) break;
    }
    return paretoFront(found)
      .sort((a, b) => a.dep - b.dep || a.arr - b.arr)
      .slice(0, wanted)
      .map((j) => j.journey);
  }

  private offsetAt(place: number): number {
    const op = this.places[place]?.stations[0]?.operator ?? "";
    const bi = this.bundles.findIndex((b) => b.operator === op);
    return bi >= 0 ? (this.offsets[bi] as number) : 0;
  }

  /**
   * One connection scan from `start`, with one label per number of trains. With targets,
   * it stops once nothing leaving later can reach one sooner; without, it labels every
   * place reached before `until`.
   */
  private labels(h: Hops, origins: number[], isTarget: Uint8Array | null, start: number, K: number, until = INF): Labels {
    const n = this.places.length;
    // ready[k*n + p]: earliest time to board a train at p having used at most k trains.
    const ready = new Int32Array((K + 1) * n).fill(INF);
    // How it was reached: -1 the origin, -2 by arriving there, else the place walked from.
    const readyFrom = new Int32Array((K + 1) * n).fill(-1);
    const readyLevel = new Int8Array((K + 1) * n);
    // arrival[k*n + p], and the leg that got there: boarding hop and alighting hop.
    const arrival = new Int32Array((K + 1) * n).fill(INF);
    const legBoard = new Int32Array((K + 1) * n);
    const legAlight = new Int32Array((K + 1) * n);
    const atTarget = new Int32Array(K + 1).fill(INF);
    const targetPlace = new Int32Array(K + 1).fill(-1);
    for (const o of origins) {
      for (let k = 0; k <= K; k++) ready[k * n + o] = start;
      for (const w of this.walks[o] ?? []) {
        if (isTarget?.[w.to] || origins.includes(w.to)) continue;
        for (let k = 0; k <= K; k++) ready[k * n + w.to] = Math.min(ready[k * n + w.to] as number, start + w.minutes);
      }
    }
    // Per trip instance: the fewest trains used once on it, and where it was boarded.
    const onTrip = new Int8Array(this.tripCount * DAY_SLOTS.length).fill(127);
    const boardHop = new Int32Array(this.tripCount * DAY_SLOTS.length);

    let lo = 0;
    let hi = h.dep.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((h.dep[mid] as number) < start) lo = mid + 1;
      else hi = mid;
    }
    let best = until;
    for (let c = lo; c < h.dep.length; c++) {
      const dep = h.dep[c] as number;
      if (dep >= best) break;
      const inst = h.inst[c] as number;
      const from = h.from[c] as number;
      let k = onTrip[inst] as number;
      for (let j = 1; j < Math.min(k, K + 1); j++) {
        if ((ready[(j - 1) * n + from] as number) <= dep) {
          k = j;
          onTrip[inst] = j;
          boardHop[inst] = c;
          break;
        }
      }
      if (k > K) continue;
      const to = h.to[c] as number;
      const arr = h.arr[c] as number;
      const at = k * n + to;
      if (arr >= (arrival[at] as number)) continue;
      arrival[at] = arr;
      legBoard[at] = boardHop[inst] as number;
      legAlight[at] = c;
      if (isTarget?.[to]) {
        for (let kk = k; kk <= K; kk++) {
          if (arr < (atTarget[kk] as number)) {
            atTarget[kk] = arr;
            targetPlace[kk] = to;
          }
        }
        best = Math.min(best, arr);
        continue;
      }
      const r = arr + (this.change[to] as number);
      for (let kk = k; kk <= K; kk++) {
        if (r < (ready[kk * n + to] as number)) {
          ready[kk * n + to] = r;
          readyFrom[kk * n + to] = -2;
          readyLevel[kk * n + to] = k;
        }
        for (const w of this.walks[to] ?? []) {
          const rw = arr + w.minutes;
          if (rw < (ready[kk * n + w.to] as number)) {
            ready[kk * n + w.to] = rw;
            readyFrom[kk * n + w.to] = to;
            readyLevel[kk * n + w.to] = k;
          }
        }
      }
    }
    return { n, K, arrival, legBoard, legAlight, readyFrom, readyLevel, atTarget, targetPlace };
  }

  /** For each number of trains, the earliest arrival at a target, where one more train arrives sooner. */
  private scan(h: Hops, origins: number[], targets: number[], start: number, maxTrains: number, date: string): Found[] {
    const isTarget = new Uint8Array(this.places.length);
    for (const t of targets) isTarget[t] = 1;
    const l = this.labels(h, origins, isTarget, start, maxTrains);
    const out: Found[] = [];
    let previous = INF;
    for (let k = 1; k <= maxTrains; k++) {
      const a = l.atTarget[k] as number;
      if (a >= previous) continue;
      previous = a;
      const hops = this.trace(h, l, k, l.targetPlace[k] as number);
      const journey = hops && this.journeyOf(h, hops, date);
      if (journey) out.push(journey);
    }
    return out;
  }

  /**
   * Every place reachable from `from` on `date`, each with its fastest journey (the
   * shortest door to door, then the earliest). Departures are tried every `step` minutes
   * from `opts.time`, and journeys may take up to `maxMinutes`.
   */
  reachable(
    from: Match | number[],
    date: string,
    opts: Omit<SearchOptions, "results"> & { step?: number; maxMinutes?: number } = {},
  ): Map<number, Journey> {
    const origins = Array.isArray(from) ? from : from.places;
    const out = new Map<number, Journey>();
    if (origins.length === 0) return out;
    const K = Math.min(8, Math.max(1, opts.maxTrains ?? 4));
    const step = Math.max(15, opts.step ?? 60);
    const maxMinutes = opts.maxMinutes ?? 24 * 60;
    const h = this.hops(date);
    const originOffset = this.offsetAt(origins[0] as number);
    const first = (opts.time ? Number(opts.time.slice(0, 2)) * 60 + Number(opts.time.slice(3, 5)) : 0) - originOffset;
    const dayEnd = 1440 - originOffset;
    const skip = new Set(origins);
    for (const o of origins) for (const w of this.walks[o] ?? []) skip.add(w.to);
    const best = new Map<number, { dep: number; arr: number; hops: [number, number][] }>();
    for (let start = first; start < dayEnd; start += step) {
      const l = this.labels(h, origins, null, start, K, start + maxMinutes);
      for (let p = 0; p < l.n; p++) {
        if (skip.has(p)) continue;
        let k = 0;
        let a = INF;
        for (let kk = 1; kk <= K; kk++) {
          const v = l.arrival[kk * l.n + p] as number;
          if (v < a) {
            a = v;
            k = kk;
          }
        }
        if (k === 0) continue;
        const hops = this.trace(h, l, k, p);
        if (!hops?.length) continue;
        const dep = h.dep[(hops[0] as [number, number])[0]] as number;
        if (dep >= dayEnd) continue;
        const prev = best.get(p);
        if (!prev || a - dep < prev.arr - prev.dep || (a - dep === prev.arr - prev.dep && a < prev.arr)) best.set(p, { dep, arr: a, hops });
      }
    }
    for (const [p, b] of best) {
      const j = this.journeyOf(h, b.hops, date);
      if (j) out.set(p, j.journey);
    }
    return out;
  }

  /** The hops (boarding, alighting) of the journey labelled at `place` with `level` trains. */
  private trace(h: Hops, l: Labels, level: number, place: number): [number, number][] | null {
    const { n, arrival, legBoard, legAlight, readyFrom, readyLevel } = l;
    const hops: [number, number][] = [];
    let p = place;
    let k = level;
    // The label at the fewest trains that got there.
    while (k > 1 && (arrival[(k - 1) * n + p] as number) <= (arrival[k * n + p] as number)) k--;
    for (let guard = 0; guard < 16; guard++) {
      const at = k * n + p;
      if ((arrival[at] as number) >= INF) return null;
      const board = legBoard[at] as number;
      hops.unshift([board, legAlight[at] as number]);
      const boardPlace = h.from[board] as number;
      if (k === 1) return hops;
      const r = (k - 1) * n + boardPlace;
      const how = readyFrom[r] as number;
      if (how === -1) return hops;
      p = how === -2 ? boardPlace : how;
      k = readyLevel[r] as number;
    }
    return null;
  }

  private journeyOf(h: Hops, hops: [number, number][], date: string): Found | null {
    const legs: Leg[] = [];
    for (const [b, a] of hops) {
      const inst = h.inst[b] as number;
      const g = inst % this.tripCount;
      let bi = 0;
      while (bi + 1 < this.bundles.length && (this.tripBase[bi + 1] as number) <= g) bi++;
      const bundle = this.bundles[bi] as SearchBundle;
      const trip = bundle.trips[g - (this.tripBase[bi] as number)] as SearchBundle["trips"][number];
      const offset = this.offsets[bi] as number;
      const first = h.hop[b] as number;
      const last = (h.hop[a] as number) + 1;
      const leg: Leg = {
        operator: bundle.operator,
        trainNo: trip[0],
        from: bundle.stations[trip[3][first] as number]?.[0] ?? "",
        to: bundle.stations[trip[3][last] as number]?.[0] ?? "",
        departure: stamp(date, (h.dep[b] as number) + offset),
        arrival: stamp(date, (h.arr[a] as number) + offset),
        stops: last - first,
      };
      if (trip[1] >= 0) leg.category = bundle.families[trip[1]];
      legs.push(leg);
    }
    const first = hops[0];
    const last = hops[hops.length - 1];
    const l0 = legs[0];
    const ln = legs[legs.length - 1];
    if (!first || !last || !l0 || !ln) return null;
    const dep = h.dep[first[0]] as number;
    const arr = h.arr[last[1]] as number;
    return {
      dep,
      arr,
      journey: { departure: l0.departure, arrival: ln.arrival, duration: arr - dep, changes: legs.length - 1, legs },
    };
  }
}

/** Drop every journey another beats: leaving no earlier, arriving no later, with no more changes. */
function paretoFront(list: Found[]): Found[] {
  return list.filter(
    (j) =>
      !list.some(
        (k) =>
          k !== j &&
          k.dep >= j.dep &&
          k.arr <= j.arr &&
          k.journey.changes <= j.journey.changes &&
          (k.dep > j.dep || k.arr < j.arr || k.journey.changes < j.journey.changes),
      ),
  );
}
