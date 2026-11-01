// Interrail across Europe on train-api's v2 files, with Railmap's station ids. Runs in the
// Europe worker; pure, so tests drive it directly.
//
// It scales by loading little: every operator's station list (small) makes the directory
// (the station fields, the map, and which operators meet in which town). A search then
// needs only the trip bundles of the operators on the way between its two towns (Paris to
// Madrid: SNCF and Renfe, not Finland's VR), and builds a search network over those alone.
//
// Station ids: a place SNCF serves keeps SNCF's name (the id the rest of the app, its map
// and its MAX data already use); any other place takes the directory's id ("amsterdam-centraal").

import { Network, type SearchBundle, type Journey as EngineJourney } from "./engine";

/** One operator's stations, as `v2/<operator>/stations.json` lists them. */
export interface StationList {
  operator: string;
  stations: [string, number | null, number | null][];
}

/** One place of the network, as the app lists and maps it. */
export interface EuropePlace {
  /** The app's station id. */
  id: string;
  name: string;
  lat: number | null;
  lon: number | null;
  /** The town's name ("Madrid" for each Madrid station). */
  town: string;
}

/** One train of a journey, between app station ids, in local times "YYYY-MM-DDTHH:MM". */
export interface EuropeLeg {
  operator: string;
  trainNo: string;
  category?: string;
  from: string;
  to: string;
  departure: string;
  arrival: string;
}

export interface EuropeJourney {
  /** Minutes door to door, time zones accounted for. */
  duration: number;
  legs: EuropeLeg[];
}

/** The fastest journey to one town, for the explore list. */
export interface ReachRow {
  /** App id of the place the journey arrives at. */
  station: string;
  journey: EuropeJourney;
}

/** Towns an explore search returns at most, busiest first. */
export const REACH_TOWNS = 150;

/** Search networks kept built, by operator set: a day's calendar reuses one. */
const KEEP_NETWORKS = 2;

/** A search network over some operators, and where each operator's station sits in it. */
interface SearchNet {
  net: Network;
  placeOf: Map<string, number>;
}

const key = (operator: string, name: string): string => `${operator}\u0000${name}`;

/** Breadth-first distances from `start` in the operator graph. */
function distances(graph: Map<string, Set<string>>, start: Iterable<string>): Map<string, number> {
  const dist = new Map<string, number>();
  let frontier = [...new Set(start)];
  for (const op of frontier) dist.set(op, 0);
  for (let d = 1; frontier.length > 0; d++) {
    const next: string[] = [];
    for (const op of frontier) {
      for (const n of graph.get(op) ?? []) {
        if (dist.has(n)) continue;
        dist.set(n, d);
        next.push(n);
      }
    }
    frontier = next;
  }
  return dist;
}

export class Europe {
  /** Every operator's stations, no trips: the station directory. */
  private readonly dir: Network;
  /** App station id of each directory place. */
  private readonly ids: string[];
  private readonly byId = new Map<string, number>();
  /** "operator\0station name" → directory place. */
  private readonly byStation = new Map<string, number>();
  /** Town id → its directory places. */
  private readonly towns = new Map<string, number[]>();
  /** Operators that meet in some town: a journey can change from one to the other. */
  private readonly graph = new Map<string, Set<string>>();
  private readonly sncfCoords: Record<string, [number, number]>;
  private readonly bundles = new Map<string, SearchBundle>();
  private readonly nets = new Map<string, SearchNet>();

  /**
   * `sncfCoords` places SNCF's stations, which its open data leaves without coordinates,
   * so they meet the other operators' stations on the map and in town.
   */
  constructor(lists: StationList[], sncfCoords: Record<string, [number, number]> = {}) {
    this.sncfCoords = sncfCoords;
    this.dir = new Network(
      lists.map((l) => ({ v: 2, operator: l.operator, dates: [], stations: this.placed(l.operator, l.stations), families: [], trips: [] })),
    );
    this.ids = this.dir.places.map((p, i) => {
      for (const s of p.stations) this.byStation.set(key(s.operator, s.name), i);
      const town = this.towns.get(p.city);
      if (town) town.push(i);
      else this.towns.set(p.city, [i]);
      return p.stations.find((s) => s.operator === "sncf")?.name ?? p.id;
    });
    this.ids.forEach((id, i) => {
      if (!this.byId.has(id)) this.byId.set(id, i);
    });
    // Every SNCF name answers, even when two share a place.
    this.dir.places.forEach((p, i) => {
      for (const s of p.stations) if (s.operator === "sncf" && !this.byId.has(s.name)) this.byId.set(s.name, i);
    });
    for (const l of lists) this.graph.set(l.operator, new Set());
    for (const members of this.towns.values()) {
      const ops = new Set(members.flatMap((i) => (this.dir.places[i]?.stations ?? []).map((s) => s.operator)));
      for (const a of ops) for (const b of ops) if (a !== b) this.graph.get(a)?.add(b);
    }
  }

  /** SNCF's stations with the app's positions. */
  private placed(operator: string, stations: StationList["stations"]): StationList["stations"] {
    if (operator !== "sncf") return stations;
    return stations.map(([name, lat, lon]) => {
      const at = this.sncfCoords[name];
      return lat === null && at ? [name, at[0], at[1]] : [name, lat, lon];
    });
  }

  /** Every place, as the app lists it. */
  directory(): EuropePlace[] {
    return this.dir.places.map((p, i) => ({ id: this.ids[i] as string, name: p.name, lat: p.lat, lon: p.lon, town: this.townName(i) }));
  }

  private townName(place: number): string {
    const p = this.dir.places[place];
    if (!p) return "";
    const members = this.towns.get(p.city) ?? [];
    return members.length > 1 ? (this.dir.resolve(p.city)?.name ?? p.name) : p.name;
  }

  /** Does the network serve this app station id? */
  knows(id: string): boolean {
    return this.byId.has(id);
  }

  /** The directory places of the town an app station id belongs to: a search from or to it covers them all. */
  private town(id: string): number[] {
    const i = this.byId.get(id);
    if (i === undefined) return [];
    return this.towns.get((this.dir.places[i] as { city: string }).city) ?? [i];
  }

  private operatorsAt(id: string): Set<string> {
    return new Set(this.town(id).flatMap((i) => (this.dir.places[i]?.stations ?? []).map((s) => s.operator)));
  }

  /**
   * The operators a search needs. Between two towns: every operator on a shortest chain of
   * operators that meet in a town, or on one a single operator longer (a detour that may
   * still be faster). Explore from a town: its operators and their neighbours.
   */
  operatorsFor(from: string, to?: string): string[] {
    const a = this.operatorsAt(from);
    const fromA = distances(this.graph, a);
    if (to === undefined) return [...fromA].filter(([, d]) => d <= 1).map(([op]) => op).sort();
    const b = this.operatorsAt(to);
    const fromB = distances(this.graph, b);
    let shortest = Infinity;
    for (const [op, d] of fromA) shortest = Math.min(shortest, d + (fromB.get(op) ?? Infinity));
    if (shortest === Infinity) return [...new Set([...a, ...b])].sort();
    return [...fromA].filter(([op, d]) => d + (fromB.get(op) ?? Infinity) <= shortest + 1).map(([op]) => op).sort();
  }

  /** Of `operators`, those whose trip bundle isn't loaded yet. */
  missing(operators: string[]): string[] {
    return operators.filter((op) => !this.bundles.has(op));
  }

  addBundle(b: SearchBundle): void {
    this.bundles.set(b.operator, { ...b, stations: this.placed(b.operator, b.stations) });
  }

  /** The search network over these operators' loaded bundles, built once. */
  private network(operators: string[]): SearchNet | null {
    const ops = operators.filter((op) => this.bundles.has(op)).sort();
    if (ops.length === 0) return null;
    const k = ops.join(",");
    let hit = this.nets.get(k);
    if (hit) {
      this.nets.delete(k);
      this.nets.set(k, hit);
      return hit;
    }
    const net = new Network(ops.map((op) => this.bundles.get(op) as SearchBundle));
    const placeOf = new Map<string, number>();
    net.places.forEach((p, i) => {
      for (const s of p.stations) placeOf.set(key(s.operator, s.name), i);
    });
    hit = { net, placeOf };
    this.nets.set(k, hit);
    while (this.nets.size > KEEP_NETWORKS) this.nets.delete(this.nets.keys().next().value as string);
    return hit;
  }

  /** The places of a search network that stand for an app station's town. */
  private places(s: SearchNet, id: string): number[] {
    const out = new Set<number>();
    for (const i of this.town(id)) {
      for (const st of this.dir.places[i]?.stations ?? []) {
        const p = s.placeOf.get(key(st.operator, st.name));
        if (p !== undefined) out.add(p);
      }
    }
    return [...out];
  }

  /** Journeys leaving `from` on `date` with at most `maxTrains` trains, earliest first, over the loaded `operators`. */
  journeys(from: string, to: string, date: string, maxTrains: number, operators = this.operatorsFor(from, to), results = 12): EuropeJourney[] {
    const s = this.network(operators);
    if (!s) return [];
    const a = this.places(s, from);
    const b = this.places(s, to);
    if (a.length === 0 || b.length === 0) return [];
    return s.net.journeys(a, b, date, { maxTrains, results }).map((j) => this.convert(j));
  }

  /**
   * Every town reachable from `from` on `date`, each with its fastest journey, keeping the
   * {@link REACH_TOWNS} busiest: a pass reaches thousands of village halts in a day.
   */
  reachable(from: string, date: string, maxTrains: number, operators = this.operatorsFor(from), step = 120): ReachRow[] {
    const s = this.network(operators);
    if (!s) return [];
    const origins = this.places(s, from);
    if (origins.length === 0) return [];
    const reached = s.net.reachable(origins, date, { maxTrains, step });
    const best = new Map<string, { place: number; journey: EngineJourney }>();
    const townCalls = new Map<string, number>();
    for (const [place, journey] of reached) {
      const p = s.net.places[place];
      const st = p?.stations[0];
      const d = st ? this.byStation.get(key(st.operator, st.name)) : undefined;
      const town = d === undefined ? undefined : this.dir.places[d]?.city;
      if (!p || d === undefined || !town) continue;
      townCalls.set(town, (townCalls.get(town) ?? 0) + p.calls);
      const cur = best.get(town);
      if (!cur || journey.duration < cur.journey.duration) best.set(town, { place: d, journey });
    }
    return [...best.entries()]
      .sort((x, y) => (townCalls.get(y[0]) ?? 0) - (townCalls.get(x[0]) ?? 0))
      .slice(0, REACH_TOWNS)
      .map(([, b]) => ({ station: this.ids[b.place] as string, journey: this.convert(b.journey) }));
  }

  private convert(j: EngineJourney): EuropeJourney {
    return {
      duration: j.duration,
      legs: j.legs.map((l) => {
        const leg: EuropeLeg = {
          operator: l.operator,
          trainNo: l.trainNo,
          from: this.stationId(l.operator, l.from),
          to: this.stationId(l.operator, l.to),
          departure: l.departure,
          arrival: l.arrival,
        };
        if (l.category) leg.category = l.category;
        return leg;
      }),
    };
  }

  private stationId(operator: string, name: string): string {
    if (operator === "sncf") return name;
    const i = this.byStation.get(key(operator, name));
    return i === undefined ? name : (this.ids[i] as string);
  }
}
