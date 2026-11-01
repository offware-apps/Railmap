// Interrail across Europe: every operator's trip bundle from train-api (v2) in one search
// network, with Railmap's station ids. Runs in the Europe worker; pure, so tests drive it
// directly.
//
// Station ids: a place SNCF serves keeps SNCF's name (the id the rest of the app, its map
// and its MAX data already use); any other place takes the engine's id ("amsterdam-centraal").

import { Network, type SearchBundle, type Journey as EngineJourney } from "./engine";

/** One place of the network, as the app lists and maps it. */
export interface EuropePlace {
  /** The app's station id. */
  id: string;
  name: string;
  lat: number | null;
  lon: number | null;
  /** The town's name ("Madrid" for each Madrid station). */
  town: string;
  /** How many trips call here, to rank places. */
  calls: number;
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

export class Europe {
  readonly net: Network;
  /** App station id of each place. */
  private readonly ids: string[];
  private readonly byId = new Map<string, number>();
  /** "operator\0station name" → place. */
  private readonly byStation = new Map<string, number>();
  /** Town id → its places. */
  private readonly towns = new Map<string, number[]>();

  /**
   * `sncfCoords` places SNCF's stations, which its open data leaves without coordinates,
   * so they meet the other operators' stations on the map and in town.
   */
  constructor(bundles: SearchBundle[], sncfCoords: Record<string, [number, number]> = {}) {
    const placed = bundles.map((b) =>
      b.operator !== "sncf"
        ? b
        : {
            ...b,
            stations: b.stations.map(([name, lat, lon]): [string, number | null, number | null] => {
              const at = sncfCoords[name];
              return lat === null && at ? [name, at[0], at[1]] : [name, lat, lon];
            }),
          },
    );
    this.net = new Network(placed);
    this.ids = this.net.places.map((p, i) => {
      for (const s of p.stations) this.byStation.set(`${s.operator}\u0000${s.name}`, i);
      const town = this.towns.get(p.city);
      if (town) town.push(i);
      else this.towns.set(p.city, [i]);
      return p.stations.find((s) => s.operator === "sncf")?.name ?? p.id;
    });
    this.ids.forEach((id, i) => {
      if (!this.byId.has(id)) this.byId.set(id, i);
    });
    // Every SNCF name answers, even when two share a place.
    this.net.places.forEach((p, i) => {
      for (const s of p.stations) if (s.operator === "sncf" && !this.byId.has(s.name)) this.byId.set(s.name, i);
    });
  }

  /** Every place, as the app lists it. */
  directory(): EuropePlace[] {
    return this.net.places.map((p, i) => ({
      id: this.ids[i] as string,
      name: p.name,
      lat: p.lat,
      lon: p.lon,
      town: this.townName(i),
      calls: p.calls,
    }));
  }

  private townName(place: number): string {
    const p = this.net.places[place];
    if (!p) return "";
    const members = this.towns.get(p.city) ?? [];
    return members.length > 1 ? (this.net.resolve(p.city)?.name ?? p.name) : p.name;
  }

  /** Does the network serve this app station id? */
  knows(id: string): boolean {
    return this.byId.has(id);
  }

  /** The places of the town an app station id belongs to: a search from or to it covers them all. */
  town(id: string): number[] {
    const i = this.byId.get(id);
    if (i === undefined) return [];
    return this.towns.get((this.net.places[i] as { city: string }).city) ?? [i];
  }

  /** Journeys leaving `from` on `date`, with at most `maxTrains` trains, earliest first. */
  journeys(from: string, to: string, date: string, maxTrains: number, results = 12): EuropeJourney[] {
    const a = this.town(from);
    const b = this.town(to);
    if (a.length === 0 || b.length === 0) return [];
    return this.net.journeys(a, b, date, { maxTrains, results }).map((j) => this.convert(j));
  }

  /**
   * Every town reachable from `from` on `date`, each with its fastest journey, keeping the
   * {@link REACH_TOWNS} busiest: a pass reaches thousands of village halts in a day.
   */
  reachable(from: string, date: string, maxTrains: number, step = 120): ReachRow[] {
    const origins = this.town(from);
    if (origins.length === 0) return [];
    const reached = this.net.reachable(origins, date, { maxTrains, step });
    const best = new Map<string, { place: number; journey: EngineJourney }>();
    const townCalls = new Map<string, number>();
    for (const [place, journey] of reached) {
      const p = this.net.places[place];
      if (!p) continue;
      townCalls.set(p.city, (townCalls.get(p.city) ?? 0) + p.calls);
      const cur = best.get(p.city);
      if (!cur || journey.duration < cur.journey.duration) best.set(p.city, { place, journey });
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
    const i = this.byStation.get(`${operator}\u0000${name}`);
    return i === undefined ? name : (this.ids[i] as string);
  }
}
