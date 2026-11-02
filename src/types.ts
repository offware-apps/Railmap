// Domain types for Railmap.

/** The pass the user travels on: the two MAX subscriptions, or an Interrail pass. */
export type CardType = "jeune" | "senior" | "interrail";

/** Search intent. */
export type SearchMode = "from" | "to" | "od" | "best" | "tour";

/**
 * The "How long?" / stay choice — the whole trip-type control. `"sameday"` is a day
 * trip (hours on site); `` `n${N}` `` (n1, n2, … n10 …) is a FIXED round trip with
 * that many nights; `"flexible"` is a round trip whose return you pick on the return
 * calendar. (One-way is the absence of a stay, i.e. `SearchQuery.stay === undefined`.)
 *
 * A fixed N-night stay is deliberately decoupled from Flexible: any N (not just 1–3)
 * is a fixed stay, so the nights stepper is usable across its whole range and never
 * collapses a long fixed stay into Flexible mode. Only the Flexible pill sets
 * `"flexible"`.
 */
export type StayChoice = "sameday" | "flexible" | `n${number}`;

/**
 * A raw record as published by the SNCF `tgvmax` Open Data dataset.
 * One record ≈ one train, one origin→destination, one date.
 * Field names mirror the dataset (French) so the fetch script can map directly.
 */
export interface RawRecord {
  date: string; // "YYYY-MM-DD"
  origine: string;
  destination: string;
  heure_depart: string; // "HH:MM" or "HH:MM:SS"
  heure_arrivee: string;
  train_no: string;
  od_happy_card: string; // "OUI" => a MAX seat is reservable, "NON" => not
  axe?: string; // train axis / line, when present
}

/** A normalized train used throughout the app. */
export interface MaxTrain {
  date: string; // "YYYY-MM-DD"
  origin: string; // canonical station id (dataset label)
  destination: string;
  depart: string; // "HH:MM"
  arrive: string; // "HH:MM"
  departMin: number; // minutes from midnight (departure)
  arriveMin: number; // minutes from midnight (arrival, +1440 if past midnight)
  durationMin: number;
  trainNo: string;
  available: boolean; // bookable with the pass: MAX = od_happy_card "OUI"; Interrail = the train runs
  axe?: string;
}

/** A station with coordinates for the map + autocomplete. */
export interface Station {
  id: string; // canonical key (matches dataset `origine`/`destination`)
  label: string; // display name
  city?: string;
  lat: number;
  lng: number;
  region?: string;
  aliases?: string[];
}

/** One leg of a multi-city trip: an origin→destination pair on a specific date. */
export interface TripLeg {
  from: string;
  to: string;
  date: string;
}

/** A fully-specified search. Serializable to/from the URL. */
export interface SearchQuery {
  mode: SearchMode;
  origin?: string;
  destination?: string;
  date: string; // "YYYY-MM-DD"
  card: CardType;
  departAfter?: string; // "HH:MM"
  departBefore?: string; // "HH:MM"
  arriveBefore?: string; // "HH:MM" — latest acceptable arrival
  maxDurationMin?: number;
  trainType?: string;
  /** Max changes allowed: 0 = direct only, 1 = one change, 2 = two changes. */
  maxConnections: number;
  /** Allow long overnight layovers at a hub (evening train → sleep → morning train). */
  overnight?: boolean;
  /** Exclude night trains (leave late / arrive past midnight) when true. */
  excludeNight?: boolean;
  /** Only keep journeys that include a night train (sleep aboard) when true. */
  onlyNight?: boolean;
  /** Force the journey to pass through this station ("exact trip" mode only). */
  via?: string;
  /**
   * "Hidden train" (hidden-city ticketing) toggle for "exact trip" mode. When set,
   * also surface trains that call at your destination on the way to a stop *beyond*
   * it — you book the longer ticket (same départ) and step off early. See
   * {@link file://./core/hidden.ts}.
   */
  hidden?: boolean;
  /** Flexible dates: also search ±N days around `date` ("exact trip" mode). */
  flexDays?: number;
  /** Return date for a round trip ("aller-retour"): the day to travel back. */
  returnDate?: string;
  /**
   * How long the trip stays away — the single "How long?" / stay control beside the
   * date field, and the whole trip-type choice. `undefined` = a plain one-way trip (no
   * return); otherwise a return is wanted and the value fixes the stay:
   *  - `"sameday"` — there and back the same day (metric = hours on site),
   *  - `"n1"` / `"n2"` / `"n3"` — a round trip with exactly 1 / 2 / 3 nights,
   *  - `"flexible"` — a round trip whose return you pick on the return calendar.
   * It makes day-vs-round self-evident, so it replaces the old `tripShape` flag: a day
   * trip is simply the `"sameday"` case, not a distinct mode.
   */
  stay?: StayChoice;
  /** Explicit multi-city legs (Multiville): each an origin→destination on its own date. */
  legs?: TripLeg[];
  /** Region filter, used by "best" mode. */
  region?: string;
  /** Cities to visit, used by "tour" mode. */
  cities?: string[];
  /** Min / max days spent in each city before the next hop ("tour" mode). */
  minDays?: number;
  maxDays?: number;
  /** Cap on the tour's total straight-line distance, in km ("tour" mode). */
  maxKm?: number;
  /** Cap on each hop's straight-line distance, in km ("tour" mode). */
  maxLegKm?: number;
  /** Cap on each hop's travel time, in minutes ("tour" mode — time over distance). */
  maxLegDurationMin?: number;
  /** Floor on each hop's travel time, in minutes ("tour" — e.g. require long legs / night trains). */
  minLegDurationMin?: number;
  /**
   * Cap on a journey's total day-span ("exact trip" mode). Overnight stopovers
   * can chain trains across several days; this limits how many calendar days the
   * whole trip may straddle (1 = same-day, 2 = arrives the next day, …).
   */
  maxSpanDays?: number;
  /** Finish the tour at the destination on or before this date ("tour" mode). */
  tourEndDate?: string;
  /**
   * Search radius in km around the endpoints ("exact trip" mode). When set, the
   * map draws a circle around the origin and destination and the results suggest
   * nearby stations with free MAX seats — so you can pay a short hop to/from a
   * station that does have a free train when the exact route has none.
   */
  radiusKm?: number;
  /**
   * "Round trip" toggle for "Where to?" mode: instead of the plain destinations
   * list, show round trips from the origin (out and back, both free MAX), ranked
   * by how long you get away. Pairs with `nights` (0 = same-day) and `flexNights`.
   */
  roundTrip?: boolean;
  /** Nights away for a round-trip search: 0 = same-day (default), N = an N-night stay. */
  nights?: number;
  /** Treat `nights` as a maximum and keep the longest feasible stay per city. */
  flexNights?: boolean;
  /** Same-day round trips only: minimum hours on site to count (default 4). */
  stayMinHours?: number;
  /** Allow a round-trip return arriving up to ~02:00 the next morning (else by midnight). */
  lateReturn?: boolean;
  /** How to order the results list (browse / ideas). "rec" = the mode's default rank. */
  sort?: SortKey;
}

/** Result ordering for the destination / ideas lists. */
export type SortKey = "rec" | "trains" | "days" | "closest" | "fastest" | "name" | "arrival" | "departure";

/** A direct or multi-leg (1..3 legs) journey. */
export interface Journey {
  date: string;
  origin: string;
  destination: string;
  legs: MaxTrain[];
  departMin: number;
  arriveMin: number;
  totalDurationMin: number;
  connectionMin?: number; // single-change layover (back-compat convenience)
  hub?: string; // single-change hub (back-compat convenience)
  layovers: number[]; // layover before each leg after the first
  hubs: string[]; // interchange stations, in order
}

/** One day in the 30-day availability calendar for a route. */
export interface CalendarDay {
  date: string;
  available: boolean;
  count: number; // number of free-MAX trains that day
  /**
   * The exact route has no free seat this day, but substituting ONE endpoint for a
   * station within the search radius reaches it (radius search only) — still
   * reachable via a short paid hop. Rendered in a distinct calendar colour.
   */
  nearby?: boolean;
  /**
   * Reachable this day ONLY by substituting BOTH endpoints — leaving from a nearby
   * station AND arriving at a nearby one (radius search only). The most effort, so
   * it gets its own calendar colour, distinct from the single-substitution one.
   */
  nearbyBoth?: boolean;
}

/** Dataset freshness metadata. */
export interface DataMeta {
  updatedAt: string; // ISO timestamp of the last snapshot
  source: string;
  recordCount: number;
  isSample?: boolean;
}
