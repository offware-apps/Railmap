import { loadDataset, type Dataset } from "./data/dataset";
import { SNCF_PROFILE, parseCard, profileForCard, type DatasetProfile } from "./data/profile";
import { StationRegistry } from "./data/stations";
import type { CardType, SearchQuery, SearchMode, MaxTrain, Journey, SortKey, CalendarDay, StayChoice } from "./types";
import { stayNights, stayFromNights } from "./core/roundtrip";
import {
  reachableDestinations,
  reachableOrigins,
  reachableGroups,
  windowStats,
} from "./core/destinations";
import { filterTrains, isNightTrain, type FilterOptions } from "./core/search";
import { bestTripsAcrossWindow, stationsOnDate, reachableBest, type BestTrip, type ReachTrip } from "./core/best";
import {
  bestGetawayTo,
  getawayIdeas,
  reverseGetawayIdeas,
  sortGetaways,
  stayCalendar,
  type Getaway,
} from "./core/getaways";
import { planTours, planTourInOrder, planTourGreedy, arrivalDate, type Tour } from "./core/tour";
import { findJourneys, bestJourney, reachableJourneys, journeyArriveAbs, catchableAfter, toJourney, MAX_RESULTS } from "./core/connections";
import type { ConnectionOptions } from "./core/connections";
import { availabilityCalendar, reachableCountCalendar, dateRange } from "./core/calendar";
import { findHiddenTrains } from "./core/hidden";
import { addDays, dayIndex, formatDuration, minutesToHHMM } from "./util/time";
import { haversineKm } from "./util/geo";
import { tripCo2 } from "./util/eco";
import { el, clear, isTouch } from "./ui/dom";
import { buildShell, applyTheme, applyDensity, applyReduceMotion, applyMap, closeHeaderMenu } from "./ui/shell";
import { showPostcard } from "./ui/toast";
import { createForm } from "./ui/form";
import type { FormHandle, FormRefs, TripType, TripShape } from "./ui/form";
import type { RouteMap, MarkerInfo } from "./ui/map";
import * as render from "./ui/render";
import type { RenderCtx } from "./ui/render";
import { journeyToIcs, downloadText } from "./ui/ics";
import {
  showInfoModal,
  showBookingModal,
  showTripModal,
  showMultiTripModal,
  showTourModal,
  showSettingsModal,
  modalPopstate,
} from "./ui/modals";
import { generateBookingUrl } from "./util/booking";
import { t, setLang, getLang, isLang, setSeatUnknown } from "./i18n";
import * as store from "./state/store";
import {
  MAX_JEUNE_URL,
  MAX_SENIOR_URL,
  INTERRAIL_FRANCE_URL,
  INTERRAIL_PASS_URL,
  ADEME_CO2_URL,
  GITHUB_URL,
  GITHUB_ISSUES_URL,
  OVERNIGHT_MAX_CONNECTION_MIN,
  SAME_DAY_MIN_ON_SITE_MIN,
  trainApiBase,
} from "./config";
import { filterOptsFor, odConnOptsFor, odJourneyOptsFor, getawayOptsFor } from "./core/queryOpts";
import { warmSearch } from "./search/searchClient";
import { notify } from "./pwa/register";

interface Deps {
  trains: MaxTrain[];
  meta: Dataset["meta"];
  /** The dataset's profile: which pass's trains are loaded. */
  profile: DatasetProfile;
  /** The train-api base the trains came from ("" = the snapshot); the worker reads the same. */
  apiBase: string;
  registry: StationRegistry;
}

interface Refs extends FormRefs {
  title: HTMLElement;
  results: HTMLElement;
  mapEl: HTMLElement;
  favList: HTMLElement;
  tripList: HTMLElement;
  card: HTMLSelectElement;
}

let deps: Deps;
let query: SearchQuery;
let settings: store.Settings;
let rootRef: HTMLElement;
let refs: Refs;
let formApi: FormHandle;
let mapPromise: Promise<RouteMap> | null = null;
let mapInstance: RouteMap | null = null;
// Today (YYYY-MM-DD). MAX seats are only bookable ~30 days out, so the calendar
// and the date picker stay anchored to a today..today+30 window.
let today = "";
const BOOKING_WINDOW_DAYS = 30;
const APP_TITLE = document.title;
// Cap on connection-only ("via") destinations appended to a browse list.
const MAX_VIA_RESULTS = 30;
// Step-wise Back INSIDE a multi-step flow (the round-trip Aller/Retour accordion, the
// multi-city legs). While a later step is active, Back re-opens the previous step first
// — walking the flow backwards — instead of exiting it. The current render registers a
// handler here (cleared on each render); it returns true when it consumed the Back.
let activeStepBack: (() => boolean) | null = null;

// Set when a ONE-WAY destination is opened from the Ideas list: the exact-trip page then
// shows its availability calendar OPEN (the days you can go), since Ideas' whole promise is
// "tap a place → see when you can go" rather than landing on today's (maybe empty) trains.
let openOdCalendar = false;

let tripType: TripType = "simple";
// Number keys 1..3 select these tabs; "r" toggles round trip (see onGlobalKey).
const TRIP_TABS: readonly TripType[] = ["simple", "multi", "ideas"];

function tripTypeForQuery(q: SearchQuery): TripType {
  if (q.mode === "tour") return "multi";
  if (q.mode === "best") return "ideas";
  // Round trip is a toggle on the Trip tab now (not a tab), so a return date / rt flag
  // restores the Trip tab with the toggle on rather than a separate Return tab.
  return "simple";
}

/** Is a return wanted (the "How long?" control is off "One-way")? Same day is the
 *  0-night case of this — not a separate mode. */
function tripIsRound(): boolean {
  return query.stay !== undefined;
}

/**
 * The return date implied by a stay choice from a given departure. A fixed stay
 * (same day / N nights) lands on departure + N (clamped to the bookable window);
 * Flexible has no fixed length, so it proposes the same default as a plain round trip
 * (departure + 2) — the return calendar then adjusts it.
 */
function returnForStay(stay: StayChoice, depart: string): string {
  const n = stayNights(stay);
  if (n == null) return proposedReturn(depart); // flexible: the calendar decides
  return returnAfterNights(depart, n);
}

/** Departure + N nights: the nights stepper's return date for a round trip — used for any N
 *  (a fixed N-night stay is `` `n${N}` ``, fully decoupled from Flexible, so the explicit
 *  return day is departure + N for every N). Past the bookable window it has no return train,
 *  which the return leg says, rather than a shorter stay than the stepper reads. */
function returnAfterNights(depart: string, nights: number): string {
  return addDays(depart, Math.max(0, nights));
}


function deriveMode(): SearchMode {
  if (tripType === "multi") return "tour";
  if (tripType === "ideas") return "best";
  const o = resolveStation(refs.origin.value);
  const d = resolveStation(refs.destination.value);
  if (o && d) return "od";
  if (d && !o) return "to";
  return "from";
}

// PWA install prompt (Chromium "beforeinstallprompt"). Held until the user clicks.
interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: string }>;
}
let installPrompt: InstallPromptEvent | null = null;
// Proposed/edited return date for the round trip's return leg.
// Reset on each fresh od search so a new outbound re-proposes (outbound + 2 days).
let odReturnDate: string | null = null;
// Set when an outbound-day change re-anchored a round-trip return: surfaces the
// rt_return_moved notice on the next render, then clears itself.
let returnMoved = false;

/** Set (or clear with "") the inline status under the Search and Surprise buttons. */
function setSurpriseMsg(text: string): void {
  formApi?.setSurpriseMsg(text);
}

/** Remove every tour "city to visit" at once (staged — the search waits for the button). */
function clearTourCities(): void {
  formApi?.clearCities();
}

/** Straight-line km between two stations; Infinity if either lacks coordinates. */
function stationDistanceKm(a: string, b: string): number {
  const ca = deps.registry.coords(a);
  const cb = deps.registry.coords(b);
  return ca && cb ? haversineKm(ca, cb) : Infinity;
}

interface NearbyTrip {
  id: string;
  km: number;
  journey: Journey;
}

interface NearbyBothTrip {
  from: { id: string; km: number };
  to: { id: string; km: number };
  journey: Journey;
}

// How many nearby stations to consider when both endpoints must be substituted
// (the search is quadratic in this, so keep it small).
const BOTH_ENDS_CAP = 8;

/**
 * Paid-connection alternatives within `radiusKm` of the route endpoints, for when
 * the exact origin→destination has no free MAX seat:
 *  - `fromOrigin`: stations near the origin that DO have a free MAX journey to the
 *    destination (pay a short hop origin → that station, then ride free).
 *  - `toDest`: stations near the destination reachable by free MAX from the origin
 *    (ride free to that station, then pay a short hop on to the destination).
 * Each list is nearest-first and capped so the section stays scannable.
 */
function nearbyAlternatives(
  origin: string,
  destination: string,
  date: string,
  radiusKm: number,
  opts: ConnectionOptions,
): { fromOrigin: NearbyTrip[]; toDest: NearbyTrip[]; bothEnds: NearbyBothTrip[] } {
  const CAP = 8;
  const pool = deps.registry.list();
  const skip = new Set([origin, destination]);
  const near = (center: string): { id: string; km: number }[] =>
    pool
      .map((s) => ({ id: s.id, km: stationDistanceKm(center, s.id) }))
      .filter((x) => !skip.has(x.id) && Number.isFinite(x.km) && x.km > 0 && x.km <= radiusKm)
      .sort((a, b) => a.km - b.km);
  const nearOrigin = near(origin);
  const nearDest = near(destination);
  const collect = (cands: { id: string; km: number }[], findFree: (id: string) => Journey | null): NearbyTrip[] => {
    const out: NearbyTrip[] = [];
    for (const { id, km } of cands) {
      const journey = findFree(id);
      if (journey) out.push({ id, km, journey });
      if (out.length >= CAP) break;
    }
    return out;
  };
  const fromOrigin = collect(nearOrigin, (id) => bestJourney(deps.trains, id, destination, date, opts));
  const toDest = collect(nearDest, (id) => bestJourney(deps.trains, origin, id, date, opts));
  // Only when neither single substitution works is a double substitution (both
  // ends nearby) the *only* option — compute it then, and keep it small (quadratic).
  const bothEnds: NearbyBothTrip[] = [];
  if (fromOrigin.length === 0 && toDest.length === 0) {
    for (const from of nearOrigin.slice(0, BOTH_ENDS_CAP)) {
      for (const to of nearDest.slice(0, BOTH_ENDS_CAP)) {
        if (from.id === to.id) continue;
        const journey = bestJourney(deps.trains, from.id, to.id, date, opts);
        if (journey) {
          bothEnds.push({ from, to, journey });
          break; // one option per departure station keeps the list scannable
        }
      }
      if (bothEnds.length >= CAP) break;
    }
  }
  return { fromOrigin, toDest, bothEnds };
}

// How many nearby anchor substitutes to probe in a browse-mode radius search
// (nearest-first), and how many extra places to surface. Kept modest so the section
// stays scannable and the (linear-per-neighbour) scan stays quick.
const NEARBY_ANCHOR_CAP = 12;
const NEARBY_BROWSE_RESULTS = 30;

/** One extra browse destination/origin unlocked by hopping to a nearby anchor. */
interface NearbyBrowseTrip {
  /** The newly-reachable "other" station (a destination for "from", an origin for "to"). */
  station: string;
  /** The nearby anchor substitute you'd hop to/from, and its distance from the anchor. */
  via: string;
  km: number;
  /** The free-MAX direct leg between the nearby anchor and the other station. */
  journey: Journey;
}

/**
 * Browse-mode radius search. The anchor (your origin in "Where to?", your destination
 * in "Where from?") is substituted for stations within `radiusKm`, surfacing extra
 * places you could reach by paying a short hop to/from a neighbouring station — the
 * browse twin of {@link nearbyAlternatives}. Direct free-MAX legs only,
 * nearest-anchor-first, excluding places already listed.
 */
function nearbyBrowse(
  anchor: string,
  dir: "from" | "to",
  date: string,
  radiusKm: number,
  opts: FilterOptions,
  exclude: Set<string>,
): NearbyBrowseTrip[] {
  const near = deps.registry
    .list()
    .map((s) => ({ id: s.id, km: stationDistanceKm(anchor, s.id) }))
    .filter((x) => x.id !== anchor && Number.isFinite(x.km) && x.km > 0 && x.km <= radiusKm)
    .sort((a, b) => a.km - b.km)
    .slice(0, NEARBY_ANCHOR_CAP);
  // Keep the nearest-anchor option per newly-reachable station.
  const best = new Map<string, NearbyBrowseTrip>();
  for (const n of near) {
    const groups =
      dir === "from"
        ? reachableDestinations(deps.trains, n.id, date, opts)
        : reachableOrigins(deps.trains, n.id, date, opts);
    for (const g of groups) {
      const other = g.station;
      if (other === anchor || exclude.has(other)) continue;
      // Fastest direct leg between the neighbour and this station, as a one-leg journey.
      const leg = [...g.trains].sort((a, b) => a.durationMin - b.durationMin)[0];
      if (!leg) continue;
      const prev = best.get(other);
      if (!prev || n.km < prev.km) best.set(other, { station: other, via: n.id, km: n.km, journey: toJourney([leg]) });
    }
  }
  return [...best.values()]
    .sort((a, b) => a.km - b.km || a.journey.totalDurationMin - b.journey.totalDurationMin)
    .slice(0, NEARBY_BROWSE_RESULTS);
}

/**
 * Per-day "nearby reachability" for the radius calendar, when the exact route has
 * no free seat: level 1 = reachable by substituting ONE endpoint (a nearby start
 * OR a nearby finish); level 2 = reachable ONLY by substituting BOTH. Candidate
 * stations are fixed across days, so they're found once; each day short-circuits on
 * the first hit, and the (quadratic) both-ends check runs only when level 1 fails.
 */
function nearbyCalendarLevels(
  origin: string,
  destination: string,
  dates: string[],
  radiusKm: number,
  opts: ConnectionOptions,
): Map<string, 1 | 2> {
  const CAND_CAP = 12;
  const pool = deps.registry.list();
  const skip = new Set([origin, destination]);
  const nearest = (center: string): string[] =>
    pool
      .map((s) => ({ id: s.id, km: stationDistanceKm(center, s.id) }))
      .filter((x) => !skip.has(x.id) && Number.isFinite(x.km) && x.km > 0 && x.km <= radiusKm)
      .sort((a, b) => a.km - b.km)
      .slice(0, CAND_CAP)
      .map((x) => x.id);
  const nearOrigin = nearest(origin);
  const nearDest = nearest(destination);
  const bothOrigin = nearOrigin.slice(0, BOTH_ENDS_CAP);
  const bothDest = nearDest.slice(0, BOTH_ENDS_CAP);
  const out = new Map<string, 1 | 2>();
  for (const date of dates) {
    const single =
      nearOrigin.some((id) => bestJourney(deps.trains, id, destination, date, opts)) ||
      nearDest.some((id) => bestJourney(deps.trains, origin, id, date, opts));
    if (single) {
      out.set(date, 1);
      continue;
    }
    const both = bothOrigin.some((a) =>
      bothDest.some((b) => a !== b && bestJourney(deps.trains, a, b, date, opts)),
    );
    if (both) out.set(date, 2);
  }
  return out;
}

// Hard cap on how many cities one "find N" click can add, so a huge number can't
// freeze the planner.
const MAX_TOUR_FILL = 12;
// Bounds for the "find N cities" backtracking search so it always returns
// promptly: how many next-city options to weigh at each step, and a global
// plan-check budget. (Only-night destinations are pre-filtered, so the cap doesn't
// hide them.)
const TOUR_BRANCH = 24;
const TOUR_SEARCH_BUDGET = 900;

/** Cities to add per Surprise / Nearest click — the "Cities to add" input (≥1). */
function tourAddCount(): number {
  const n = Math.floor(Number(refs.tourCount.value.trim()));
  return Number.isFinite(n) && n >= 1 ? Math.min(MAX_TOUR_FILL, n) : 1;
}

/**
 * Grow the tour by `count` more cities — searching for ONE travel that strings all
 * of them together, not adding cities one greedy hop at a time. It backtracks: if a
 * choice dead-ends before reaching `count`, it tries another, so "Cities to add 5"
 * really finds a feasible 5-destination itinerary (or the longest one that exists).
 * `"nearest"` explores closest-first; `"random"` shuffles (Surprise me). Fills a
 * missing departure first; one re-render at the end.
 */
function growTour(mode: "nearest" | "random", count: number): void {
  setSurpriseMsg("");
  const avail = deps.trains.filter((tr) => tr.available);
  const inRegion = (id: string): boolean =>
    !query.region || deps.registry.get(id)?.region === query.region;

  // Need a departure to extend from — fill one (region-aware) if missing.
  let origin = query.origin;
  if (!origin) {
    const pool = [...new Set(avail.map((tr) => tr.origin))].filter(inRegion);
    origin = pool.length ? pool[Math.floor(Math.random() * pool.length)] : undefined;
  }
  if (!origin) {
    setSurpriseMsg(t("surprise_none"));
    return;
  }
  const start = origin;

  const lo = query.minDays ?? 1;
  const hi = Math.max(lo, query.maxDays ?? 3);
  // Honour "date flexibility": the first hop may leave within ±this many days of the
  // chosen date (never before today), so the search isn't pinned to a day with no (or
  // no night) departure.
  const startFlex = query.flexDays ?? 0;
  const planOpts = tourPlanOpts();
  // "Only night trains": a hop must END on a sleeper. With connections allowed,
  // reachableJourneys (below) already enforces that; direct-only needs an explicit
  // filter to night trains that run straight from the frontier.
  const onlyNightTour = Boolean(query.onlyNight);
  const withChanges = Boolean(query.maxConnections && query.maxConnections > 0);
  // The days a hop may depart, used to seed connection-aware candidates. The FIRST
  // hop leaves within ±startFlex of the chosen date (clamped to today), exactly the
  // window planSequence searches. A LATER hop leaves arrival+minDays..arrival+maxDays
  // — its real stay window — so a city reachable from an intermediate stop only on
  // that (later) date is still proposed; pinning every hop to the start date would
  // miss it. The direct path below is date-agnostic (scans every train), so this
  // only matters with changes.
  const startWindow = (): string[] => {
    const out: string[] = [];
    for (let i = -startFlex; i <= startFlex; i++) {
      const d = addDays(query.date, i);
      if (i === 0 || d >= today) out.push(d);
    }
    return out;
  };
  const stayWindow = (arrival: string): string[] => {
    const out: string[] = [];
    for (let i = lo; i <= hi; i++) out.push(addDays(arrival, i));
    return out;
  };
  // The next-city options from a frontier: every place the planner can actually
  // reach over `days`, unused, in-region, ordered by the mode (nearest needs
  // coordinates). When changes are allowed we seed from reachableJourneys
  // (connection- AND onlyNight-aware) across those days, not just direct trains on
  // the exact day — otherwise a city reachable only via a hub change (e.g. take a
  // train, then a connecting sleeper), or only on a flex/stay day, is never proposed.
  const reachableFrom = (frontier: string, days: string[]): string[] => {
    if (!withChanges) {
      return [...new Set(avail.filter((tr) => tr.origin === frontier).map((tr) => tr.destination))];
    }
    const dests = new Set<string>();
    for (const d of days)
      for (const dest of reachableJourneys(avail, frontier, d, planOpts).keys()) dests.add(dest);
    return [...dests];
  };
  const optionsFrom = (frontier: string, used: Set<string>, days: string[]): string[] => {
    let cs = reachableFrom(frontier, days).filter((d) => !used.has(d) && inRegion(d));
    if (onlyNightTour && !withChanges) {
      // Direct only: the sleeper must run straight from here. (With connections,
      // reachableJourneys already restricted to sleeper-arrival destinations.)
      const direct = new Set(
        avail.filter((tr) => tr.origin === frontier && isNightTrain(tr)).map((tr) => tr.destination),
      );
      cs = cs.filter((d) => direct.has(d));
    }
    if (mode === "nearest") {
      cs = cs.filter((d) => deps.registry.coords(d));
      if (deps.registry.coords(frontier)) {
        cs.sort((a, b) => stationDistanceKm(frontier, a) - stationDistanceKm(frontier, b));
      } else {
        cs.sort((a, b) => deps.registry.label(a).localeCompare(deps.registry.label(b)));
      }
    } else {
      cs.sort(() => Math.random() - 0.5);
    }
    // Day-train tours have hundreds of options — cap to keep the search snappy. The
    // night pool is already small (and must be fully weighed), so don't cap it.
    return onlyNightTour ? cs : cs.slice(0, TOUR_BRANCH);
  };
  let budget = TOUR_SEARCH_BUDGET;
  // Plan the whole in-order tour so far (returns the legs, or null if any hop is
  // infeasible). The arrival date of its last leg is when the traveller reaches the
  // frontier — which drives the NEXT hop's candidate window.
  const plan = (cities: string[]): Tour | null => {
    budget--;
    return planTourInOrder(deps.trains, start, cities, query.date, planOpts, lo, hi, stationDistanceKm, query.maxKm, query.maxLegKm, query.destination || undefined, query.destination ? query.tourEndDate : undefined, startFlex, today);
  };
  // Arrival date at a SPECIFIC city in the planned tour (the leg that ends there) —
  // not just the last leg: when a fixed destination is appended, the last leg lands
  // at the destination, so seeding from it would use the wrong (later) window for the
  // frontier we're actually extending from, dropping cities reachable in the right one.
  const arrivalAt = (tour: Tour, city: string): string => {
    const leg = tour.legs.find((j) => j.destination === city);
    return leg ? arrivalDate(leg) : query.date;
  };
  // Depth-first search with backtracking: extend `cities` by `remaining` more,
  // returning the FULL-depth itinerary if one exists (early out), else the deepest
  // feasible one found within the budget. `arrival` is when the traveller reaches the
  // current frontier (the chosen date for the start), so candidates are drawn from
  // the days the next hop could actually depart.
  const extend = (cities: string[], remaining: number, arrival: string): string[] => {
    if (remaining === 0 || budget <= 0) return cities;
    // The fixed finish (query.destination) is the END, never a nomad stop — exclude it
    // so it can't be proposed as a "city to add" (a ghost stop that plans away to the end).
    const used = new Set([start, ...cities, ...(query.destination ? [query.destination] : [])]);
    const frontier = cities[cities.length - 1] ?? start;
    const days = cities.length === 0 ? startWindow() : stayWindow(arrival);
    let deepest = cities;
    for (const c of optionsFrom(frontier, used, days)) {
      if (budget <= 0) break;
      const next = [...cities, c];
      const tour = plan(next); // the whole in-order tour so far must still plan
      if (!tour) continue;
      const result = extend(next, remaining - 1, arrivalAt(tour, c)); // seed from the NEW frontier c
      if (result.length === cities.length + remaining) return result; // reached count
      if (result.length > deepest.length) deepest = result; // keep the longest partial
    }
    return deepest;
  };

  const base = formApi.getTourCities();
  // Seed the arrival at the existing frontier (if any) so the first new hop departs
  // from the right day. If the existing cities don't even plan, there's nothing to grow.
  const baseTour = base.length ? plan(base) : null;
  const baseFrontier = base[base.length - 1];
  const nextCities =
    base.length && !baseTour
      ? base
      : extend(base, count, baseTour && baseFrontier ? arrivalAt(baseTour, baseFrontier) : query.date);
  const added = nextCities.length - base.length;

  if (added === 0) {
    // Couldn't add any city. Still commit the snapshotted form (a freshly-filled
    // departure, a removed finish/filter) so the view and URL reflect what's now in
    // the form — not a stale query that would keep a just-removed destination — then
    // flag that nothing was added.
    query = { ...query, origin };
    syncFormFromQuery();
    applyAndRun();
    setSurpriseMsg(t("surprise_none"));
    return;
  }
  query = { ...query, origin, cities: [...nextCities] };
  syncFormFromQuery();
  applyAndRun();
}

/** Tour "nearest stop": fill up to N closest reachable stops that keep it feasible. */
function addNearestCity(): void {
  // Snapshot the live form first (see surpriseMe): growTour rebuilds the query and
  // re-syncs the form, so it must start from the current form state — not a stale
  // query that would bring back a just-removed destination / staged edit.
  query = readQueryFromForm();
  growTour("nearest", tourAddCount());
}

/**
 * Best-effort guess that this is a weak device or a metered/slow connection, so a
 * first-time visitor gets the light experience (no map, no motion) by default. Only
 * consulted when the user has never saved settings — an explicit choice always wins.
 */
function isLowEndDevice(): boolean {
  const nav = navigator as Navigator & {
    deviceMemory?: number;
    connection?: { saveData?: boolean; effectiveType?: string };
  };
  // Data Saver on, or a 2G/slow-2G connection: treat as low-end regardless of CPU.
  const conn = nav.connection;
  if (conn?.saveData === true) return true;
  if (conn?.effectiveType === "slow-2g" || conn?.effectiveType === "2g") return true;
  // ≤2 GB RAM or ≤2 logical cores: the map + tiles + animations are the first thing
  // to jank on these. Both are coarse, privacy-friendly hints (undefined on Safari).
  if (typeof nav.deviceMemory === "number" && nav.deviceMemory <= 2) return true;
  if (typeof nav.hardwareConcurrency === "number" && nav.hardwareConcurrency <= 2) return true;
  return false;
}

/**
 * On an apparently weak device / slow connection, offer the light experience — but
 * only as a one-time, dismissible suggestion, never a silent override, and never more
 * than once ever (whether accepted or dismissed). Skipped entirely once the user has
 * saved any settings of their own.
 */
function maybeSuggestLowEnd(): void {
  if (store.hasStoredSettings() || store.wasLowEndPrompted() || !isLowEndDevice()) return;
  store.markLowEndPrompted();
  showPostcard({
    title: t("lowend_prompt_title"),
    message: t("lowend_prompt_msg"),
    actionLabel: t("lowend_prompt_enable"),
    onAction: () => {
      settings = { ...settings, reduceMotion: true, map: false, density: "compact" };
      store.saveSettings(settings);
      applyReduceMotion(true);
      applyMap(false);
      applyDensity("compact");
      runSearch();
    },
  });
}

async function promptInstall(): Promise<void> {
  // Use the browser's native prompt when it offered one (Chromium/Android).
  if (installPrompt) {
    try {
      await installPrompt.prompt();
      await installPrompt.userChoice.catch(() => undefined);
      installPrompt = null;
      return;
    } catch {
      // The native prompt threw (e.g. already consumed): fall through to the modal.
      installPrompt = null;
    }
  }
  // No usable native prompt (iOS Safari, Firefox, already installed elsewhere):
  // show a modal explaining it couldn't auto-install and how to do it manually.
  showInfoModal(t("act_install"), [t("install_unavailable"), t("install_help")]);
}

export function initApp(root: HTMLElement, dataset: Dataset, registry: StationRegistry): void {
  deps = {
    trains: dataset.trains,
    meta: dataset.meta,
    profile: dataset.profile ?? SNCF_PROFILE,
    apiBase: dataset.apiBase ?? "",
    registry,
  };
  setSeatUnknown(!deps.profile.seatKnown);
  datasets.clear();
  datasets.set(deps.profile.id, Promise.resolve(dataset));
  rootRef = root;
  settings = store.loadSettings();
  const urlLang = new URLSearchParams(location.search).get("lang");
  applyTheme(settings.theme);
  applyDensity(settings.density);
  applyReduceMotion(settings.reduceMotion);
  applyMap(settings.map);
  setLang(isLang(urlLang) ? urlLang : settings.lang);
  // Every station present in the dataset becomes searchable (the curated registry
  // only covers map coordinates for the major ones).
  registry.addMissing(dataset.trains.flatMap((t) => [t.origin, t.destination]));

  today = new Date().toISOString().slice(0, 10);
  query = store.urlHasQuery()
    ? queryFromUrl()
    : { mode: "from", date: today, card: settings.card, maxConnections: 1, hidden: true };

  // A genuine page reload restores the form from the URL but does NOT auto-run the
  // search — results wait for the Search button, matching how form edits are now
  // staged (see "Don't auto-run on form edits"). Otherwise every reload silently
  // recomputes. A fresh navigation — the first visit, or a shared/deep link opened
  // from elsewhere — still shows results immediately, so shared links keep working.
  rebuild(!(store.urlHasQuery() && isPageReload()));
  checkWatchedRoutes();
  maybeSuggestLowEnd();

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    installPrompt = e as InstallPromptEvent;
  });
  window.addEventListener("appinstalled", () => {
    installPrompt = null;
  });

  // Keep the map-first canvas sized to the viewport below the bars as they reflow.
  window.addEventListener("resize", updateRailMetrics);

  // Global keyboard shortcuts (mode switch, focus, day nav, surprise, run, help).
  document.addEventListener("keydown", onGlobalKey);

  document.addEventListener("click", (ev) => {
    const nav = document.querySelector<HTMLElement>(".header-nav.menu-open");
    if (nav && !nav.contains(ev.target as Node)) closeHeaderMenu();
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") closeHeaderMenu();
  });

  // Native browser Back/Forward: restore the page from the URL. The browser history is the
  // single back-stack; the entry's `detail` flag (read by renderSearch) keeps the in-app
  // "Retour" in step with where the history now sits.
  window.addEventListener("popstate", (ev) => {
    if (modalPopstate(ev.state)) return; // Back closed a dialog; the page under it stays
    const searched = queryFromUrl();
    const state = entryState();
    if (!switchPass(searched.card, () => restoreEntry(searched, state))) restoreEntry(searched, state);
  });
}

/** Show the history entry Back/Forward landed on: its form, tab and results. */
function restoreEntry(searched: SearchQuery, state: Partial<HistoryState>): void {
  // Restore the FORM and tab from this entry's snapshot (the bare landing's is landingForm
  // when set), then the RESULTS from the URL; an entry with no snapshot uses the URL.
  const formQuery = (!store.urlHasQuery() && landingForm) || state.form || searched;
  // The URL decides the SCREEN: a renderable query, or the saved-trips page, is a results
  // page; anything else is the form screen, where renderSearch shows no results.
  const onResults = queryIsRenderable(searched) || Boolean(state.saved);
  query = formQuery;
  syncFormFromQuery();
  query = onResults ? searched : formQuery;
  runSearch(state.scroll);
  // On mobile the form and the results are two different screens. Back/Forward must
  // move between them too, following the URL (onResults), not `query`.
  setMobileForm(!onResults);
}

// Each pass's timetable, by profile id, once asked for: switching back is instant.
const datasets = new Map<string, Promise<Dataset>>();
// Bumped by every switchPass, so a slow load the user has since moved on from is dropped.
let passSwitchToken = 0;
// Another pass's trains are loading: searches wait for them (switchPass re-runs its own).
let passPending = false;

/**
 * A pass whose trains aren't the ones loaded (MAX ↔ Interrail) needs the other timetable:
 * load it while the page stays up (the results dim under a spinner until the next search
 * paints), swap it in, then call `done`. Returns true when that is under way, false when
 * the loaded trains already fit.
 */
function switchPass(card: CardType, done: () => void): boolean {
  const token = ++passSwitchToken;
  const profile = profileForCard(card);
  if (profile.id === deps.profile.id) {
    passPending = false; // back to the loaded pass before the other one arrived
    return false;
  }
  let pending = datasets.get(profile.id);
  if (!pending) {
    pending = loadDataset(profile, trainApiBase());
    datasets.set(profile.id, pending);
    pending.catch(() => datasets.delete(profile.id));
  }
  passPending = true;
  setPassLoading(true);
  pending.then(
    (dataset) => {
      if (token !== passSwitchToken) return;
      passPending = false;
      useDataset(dataset);
      done();
    },
    (err: unknown) => {
      if (token !== passSwitchToken) return;
      console.error(err);
      passPending = false;
      setPassLoading(false);
      showPostcard({
        title: t("err_load"),
        message: t(`card_${card}`),
        actionLabel: t("act_retry"),
        onAction: () => void switchPass(card, done),
      });
    },
  );
  return true;
}

/** Make `dataset` the trains every search reads, and the stations the form suggests. */
function useDataset(dataset: Dataset): void {
  deps = {
    ...deps,
    trains: dataset.trains,
    meta: dataset.meta,
    profile: dataset.profile ?? SNCF_PROFILE,
    apiBase: dataset.apiBase ?? "",
  };
  setSeatUnknown(!deps.profile.seatKnown);
  deps.registry.setPresent(dataset.trains.flatMap((tr) => [tr.origin, tr.destination]));
  formApi.setStationLabels(deps.registry.list().map((s) => s.label));
  const updated = rootRef.querySelector(".updated");
  if (updated) updated.textContent = footerUpdatedText();
  deferFormCalRepaint();
}

/** Dim the page's results under a spinner while another pass's timetable loads and searches. */
function setPassLoading(on: boolean): void {
  rootRef.classList.toggle("pass-loading", on);
  refs.results.setAttribute("aria-busy", String(on));
  rootRef.querySelector(".pass-spinner")?.remove();
  if (on) {
    rootRef.append(
      el("div", { class: "pass-spinner", attrs: { role: "status", "aria-label": t("loading") } }, [
        el("span", { class: "spinner", attrs: { "aria-hidden": "true" } }),
        el("span", { text: t("loading") }),
      ]),
    );
  }
}

/**
 * Parse the query from the URL, resolve its station names, snap its dates back into the
 * bookable window, and correct the address bar to match. The date <input> is clamped
 * to [today, today+29], so the search form can never produce an out-of-range date — but
 * a stale or shared link can. An out-of-window date would otherwise collapse the ±flex
 * browse window (only the chosen, unbookable day is in range) and skew the exact-trip
 * return calendar, so fall back to today.
 */
function queryFromUrl(): SearchQuery {
  const params = new URLSearchParams(location.search);
  const linked = params.toString();
  const q = store.queryFromParams(params, today);
  // A link without card= (a shared link, a route page) keeps the card the user saved.
  if (!params.has("card")) q.card = settings.card;
  const lastBookable = addDays(today, BOOKING_WINDOW_DAYS - 1);
  const inWindow = (d: string): boolean => d >= today && d <= lastBookable;
  if (!inWindow(q.date)) q.date = today;
  // The return date is bounded like the outbound: a stale shared link with an
  // out-of-window rdate would otherwise skew the return calendar or read as "no
  // return" — drop it so the search re-proposes a sensible one.
  if (q.returnDate && !inWindow(q.returnDate)) q.returnDate = undefined;
  // Keep the stay choice consistent with the (now window-clamped) dates. A concrete
  // return on/after the outbound maps to the matching fixed stay — same day, or N nights;
  // an explicit Flexible pick is left as Flexible (its length is the return calendar's to
  // decide). store.queryFromParams already resolved legacy rt=/rdate= links into a stay
  // using the raw params; this re-derives the fixed case after the date clamp so they
  // never drift.
  if (q.returnDate && q.mode === "od" && q.returnDate >= q.date && q.stay !== "flexible") {
    q.stay = stayFromNights(dayIndex(q.returnDate) - dayIndex(q.date));
  }
  // A linked station name ("paris", "LILLE") becomes the id the data uses; a name
  // matching no station is kept, and renderSearch reports it.
  const station = (name: string): string => deps.registry.resolve(name) ?? name;
  if (q.origin) q.origin = station(q.origin);
  if (q.destination) q.destination = station(q.destination);
  if (q.via) q.via = station(q.via);
  q.cities = q.cities?.map(station);
  // Multi-city legs are clamped too: a leg outside the bookable window can never
  // have a free MAX seat, so pull it back to today rather than showing an empty leg.
  q.legs = q.legs?.map((l) => ({
    from: station(l.from),
    to: station(l.to),
    date: inWindow(l.date) ? l.date : today,
  }));
  // The tour "finish by" date only constrains the plan when it's inside the window.
  if (q.tourEndDate && !inWindow(q.tourEndDate)) q.tourEndDate = undefined;
  // Write every value dropped, clamped or resolved above back into the address bar, in
  // place, so a reload or a shared link carries what is on screen.
  const parsed = store.queryToParams(q);
  for (const key of ["from", "to", "via", "cities", "legs", "date", "rdate", "by", "after", "before", "arrbefore"]) {
    if (!params.has(key)) continue;
    const value = parsed.get(key);
    if (value) params.set(key, value);
    else params.delete(key);
  }
  if (params.toString() !== linked) {
    history.replaceState(history.state, "", `${location.pathname}?${params.toString()}`);
  }
  return q;
}

function rebuild(autoRun = true): void {
  buildLayout(rootRef);
  syncFormFromQuery();
  if (autoRun) runSearch();
  else showSearchPrompt();
  updateRailMetrics();
  setMobileForm(!(autoRun && queryIsRenderable(query)));
}

/**
 * Whether this page view is a browser reload, as opposed to a fresh navigation
 * (first visit, typed URL, or a shared/deep link). Used to hold back the search
 * on reload — the restored form waits for the Search button — while still running
 * it automatically when someone opens a link. Unknown navigation types (and jsdom,
 * where the entry is "navigate") count as "not a reload", so links keep auto-running.
 */
function isPageReload(): boolean {
  const nav = performance.getEntriesByType?.("navigation") as PerformanceNavigationTiming[] | undefined;
  return nav?.[0]?.type === "reload";
}

/**
 * Results placeholder shown when a reload restored the form but we're deliberately
 * waiting for the Search button rather than recomputing. Clicking Search (or the
 * "g" shortcut) runs the restored query as-is.
 */
function showSearchPrompt(): void {
  searchHeldBack = true;
  clear(refs.results);
  refs.results.append(render.emptyEl(t("prompt_search")));
  showBaseMap();
}

/** True while the reload prompt above is up: the restored form is deliberately waiting for
 *  the Search button, so nothing — a live filter change included — may run a search behind
 *  it. Cleared the moment a search actually runs. */
let searchHeldBack = false;

// --- station resolution -----------------------------------------------------

function resolveStation(text: string): string | undefined {
  return deps.registry.resolve(text);
}

// --- formatting / context ---------------------------------------------------

function formatDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  return new Intl.DateTimeFormat(getLang(), {
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(d);
}

/** Short weekday name for a date (e.g. "Sat" / "sam." / "土"), localized. */
function formatWeekday(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  return new Intl.DateTimeFormat(getLang(), { weekday: "short" }).format(d);
}

function isWeekend(iso: string): boolean {
  const day = new Date(`${iso}T00:00:00`).getDay();
  return day === 0 || day === 6;
}

// Wikivoyage language editions that exist; others (e.g. ko) fall back to English.
const WIKIVOYAGE_LANGS = new Set(["fr", "en", "es", "de", "it", "zh"]);

/** Travel-guide (Wikivoyage) URL for a station's city, in the current language. */
function cityInfoUrl(id: string): string {
  const lang = getLang();
  const wv = WIKIVOYAGE_LANGS.has(lang) ? lang : "en";
  const article = deps.registry.city(id).replace(/ /g, "_");
  return `https://${wv}.wikivoyage.org/wiki/${encodeURIComponent(article)}`;
}

function ctx(): RenderCtx {
  return {
    label: (id) => deps.registry.label(id),
    formatDate,
    formatWeekday,
    // Deep-link to SNCF Connect with the trip pre-filled (clean station names, the
    // journey date, and the departure time). Connecting trips book per-leg instead.
    bookUrl: (origin, destination, date, time) =>
      generateBookingUrl(deps.registry.label(origin), deps.registry.label(destination), date, time),
    cityInfoUrl,
    onOpenRoute: (origin, destination, open) => {
      // Drop any "via" carried over from a previous exact-trip search: drilling into
      // a specific route (often a connecting one) shouldn't be filtered through an
      // unrelated hub, which would force it through a station it doesn't pass and
      // show nothing. A getaway or Ideas row passes a day it's feasible (open.date) — not
      // today, which may have no train, or an outbound and no return.
      const date = open?.date ?? query.date;
      const returnDate = open?.date && query.returnDate ? undefined : query.returnDate;
      // Opening a ONE-WAY idea (Ideas list, no stay) → reveal the dates: the exact-trip
      // page shows its availability calendar open, on the idea's first day.
      openOdCalendar = query.mode === "best" && !query.stay;
      query = { ...query, mode: "od", origin, destination, via: undefined, date, returnDate };
      syncFormFromQuery();
      // Push a browser entry marked as a DETAIL page: the list stays one Back away, and the
      // in-app Retour shows. The browser history is the single back-stack.
      applyAndRun(true, true);
      setMobileForm(false);
      // One clean scroll to the new page's heading (focus uses preventScroll so
      // this is the only scroll, not a jump-then-smooth).
      refs.title.scrollIntoView({ behavior: "smooth", block: "start" });
    },
    onShowJourney: (j) => {
      showRoute([j.origin, ...j.hubs, j.destination]);
      refs.mapEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
    },
    onShowTour: (tour) => {
      const first = tour.legs[0];
      const stops = first ? [first.origin, ...tour.legs.map((l) => l.destination)] : [];
      showRoute(stops);
      refs.mapEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
    },
    distanceKm: (a, b) => stationDistanceKm(a, b),
    // Picking a calendar day only changes the date: refresh in place (no spinner,
    // no teardown flash) and keep the scroll position so the calendar appears to
    // just move its highlight instead of vanishing and rebuilding.
    onSelectDay: (date) => {
      // Only the exact-route / browse calendars are interactive (they pick the travel day);
      // the Ideas/discovery calendars are read-only heat-maps, so this never fires for them.
      if (date === query.date) return;
      query = { ...query, date };
      refreshInPlace();
    },
    onIcs: (j) => {
      const summary = `MAX ${deps.registry.label(j.origin)} → ${deps.registry.label(j.destination)}`;
      const slug = j.legs.map((l) => l.trainNo.replace(/[^a-zA-Z0-9-]/g, "")).join("-");
      downloadText(`max-${j.date}-${slug}.ics`, journeyToIcs(j, summary));
    },
    onBookSteps: (j) => showBookingModal(j, ctx()),
    isFavorite: (route) => store.isFavorite(route),
    onToggleFavorite: (route) => {
      store.toggleFavorite(route);
      renderFavorites();
    },
    isTripSaved: (out, inb) => store.isTripSaved(store.tripId(out, inb)),
    onToggleTrip: (out, inb) => {
      store.toggleTrip(buildSavedTrip(out, inb));
      renderSavedTrips();
    },
    isTourSaved: (tour) => store.isTripSaved(store.tourId(tour)),
    onToggleTour: (tour) => {
      store.toggleTrip(buildSavedTour(tour));
      renderSavedTrips();
    },
  };
}

/** Snapshot a multi-city tour as a saved trip (its first leg labels the rail row). */
function buildSavedTour(tour: Tour): store.SavedTrip {
  return {
    id: store.tourId(tour),
    kind: "tour",
    outbound: tour.legs[0]!,
    tour,
    savedAt: Date.now(),
  };
}

/** Snapshot a journey (one-way) or a round trip (with `inbound`) as a saved trip. */
function buildSavedTrip(outbound: Journey, inbound?: Journey): store.SavedTrip {
  return {
    id: store.tripId(outbound, inbound),
    kind: inbound ? "round" : "one-way",
    outbound,
    ...(inbound ? { inbound } : {}),
    savedAt: Date.now(),
  };
}

// --- query <-> form ---------------------------------------------------------

function syncFormFromQuery(): void {
  setSurpriseMsg(""); // a navigation clears any stale "surprise" notice
  formRangeAwait = false; // a fresh sync ends any in-progress Flexible range pick
  tripType = tripTypeForQuery(query);
  // On the Multi tab, restore the surface the URL was serialized from: explicit legs
  // only ever come from the legs editor, while cities / a start / a finish only travel
  // from the planner (readQueryFromForm drops each on the other surface). A tour query
  // carrying none of them — an empty legs editor — stays on the default, legs.
  const planned =
    (query.cities && query.cities.length > 0) || Boolean(query.origin) || Boolean(query.destination);
  formApi.setMultiMode(query.legs && query.legs.length > 0 ? "legs" : planned ? "plan" : "legs");
  formApi.setActiveTab(tripType);
  refs.origin.value = query.origin ? deps.registry.label(query.origin) : "";
  refs.destination.value = query.destination ? deps.registry.label(query.destination) : "";
  refs.via.value = query.via ? deps.registry.label(query.via) : "";
  // Values set here are always resolved, so clear any stale invalid flag.
  for (const f of [refs.origin, refs.destination, refs.via]) f.classList.remove("is-invalid");
  // A single outbound date now; the return (when round-trip) is picked in the results.
  refs.departDate.setMargin(query.flexDays ?? 0);
  refs.departDate.setDate(query.date);
  refs.date.value = query.date;
  if (query.legs && query.legs.length > 0) {
    formApi.setLegs(
      query.legs.map((l) => ({
        from: l.from ? deps.registry.label(l.from) : "",
        to: l.to ? deps.registry.label(l.to) : "",
        date: l.date,
      })),
    );
  }
  refs.endDate.value = query.tourEndDate ?? "";
  refs.card.value = query.card;
  refs.departAfter.value = query.departAfter ?? "";
  refs.departBefore.value = query.departBefore ?? "";
  refs.arriveBefore.value = query.arriveBefore ?? "";
  refs.maxDuration.value = query.maxDurationMin != null ? String(query.maxDurationMin) : "";
  refs.maxSpanDays.value = query.maxSpanDays != null ? String(query.maxSpanDays) : "";
  refs.radius.value = query.radiusKm != null ? String(query.radiusKm) : "";
  refs.hidden.checked = Boolean(query.hidden);
  refs.trainType.value = query.trainType ?? "";
  refs.maxConnections.value = String(query.maxConnections);
  // Same-day min time on site: fall back to the default (4 h) when the query carries none.
  refs.stayMin.value = String(query.stayMinHours ?? SAME_DAY_MIN_ON_SITE_MIN / 60);
  refs.overnight.checked = Boolean(query.overnight);
  refs.night.checked = !query.excludeNight; // checked = night trains included
  refs.onlyNight.checked = Boolean(query.onlyNight);
  // The trip-type control mirrors the query: no stay → one-way (stepper hidden); a fixed
  // stay → round trip with N nights, taken from the concrete return span when present else
  // from the stay choice; Flexible → the calendar-pick mode (stepper inert-but-in-place, the
  // Trip-tab range calendar is the length control), seeded with the concrete span so a switch
  // to fixed reads the real count.
  // These setters repaint the control WITHOUT firing a change event.
  if (query.stay === undefined) {
    formApi.setStayNights(null);
  } else if (query.stay === "flexible") {
    formApi.setFlexible(query.returnDate ? Math.max(0, dayIndex(query.returnDate) - dayIndex(query.date)) : null);
  } else {
    formApi.setStayNights(
      query.returnDate ? Math.max(0, dayIndex(query.returnDate) - dayIndex(query.date)) : (stayNights(query.stay) ?? 1),
    );
  }
  refs.region.value = query.region ?? "";
  // Cities only travel in the URL from the tour-plan surface, so a query built on
  // another tab carries none — restoring "no cities" from it would wipe the chips on
  // a plain Back. Sync them on the Multi tab only (legs get the same treatment above).
  if (tripType === "multi") formApi.setTourCities(query.cities ?? []);
  refs.cities.value = "";
  refs.minDays.value = String(query.minDays ?? 1);
  refs.maxDays.value = String(query.maxDays ?? 3);
  refs.maxKm.value = query.maxKm != null ? String(query.maxKm) : "";
  refs.maxLegKm.value = query.maxLegKm != null ? String(query.maxLegKm) : "";
  refs.maxLegDuration.value = query.maxLegDurationMin != null ? String(query.maxLegDurationMin) : "";
  refs.minLegDuration.value = query.minLegDurationMin != null ? String(query.minLegDurationMin) : "";
  formApi.updateFieldVisibility(tripType);
  repaintFormCalendar(); // the route/shape/date just changed — repaint the home-form calendar
}

function readQueryFromForm(): SearchQuery {
  const maxDur = Number(refs.maxDuration.value.trim());
  const maxKm = Number(refs.maxKm.value.trim());
  const maxLegKm = Number(refs.maxLegKm.value.trim());
  const maxLegDur = Number(refs.maxLegDuration.value.trim());
  const minLegDur = Number(refs.minLegDuration.value.trim());
  const span = Number(refs.maxSpanDays.value.trim());
  const rad = Number(refs.radius.value.trim());
  const mode = deriveMode();
  // The Multi tab hosts two surfaces (both mode "tour"): "plan" produces a city
  // list for the planner, "legs" produces explicit hops. Reading only the active
  // surface's fields keeps a value carried over from another tab (a destination, a
  // stale city) from leaking into the query behind a hidden field.
  const legsMode = mode === "tour" && formApi.getMultiMode() === "legs";
  const planMode = mode === "tour" && formApi.getMultiMode() === "plan";
  const usesDestination = mode === "od" || mode === "to" || planMode;
  // The "How long?" / stay control is the single source of truth for whether a return is
  // wanted AND for the stay length. It applies to an exact route (od → outbound + a
  // return derived from the stay, adjustable on the results calendar), a browse from an
  // origin (from → discovery), Ideas (best), and a destination-only "to" (kept so the
  // armed prompt can ask for an origin without dropping the intent). "One-way" (Just
  // going) leaves it undefined.
  // NB: "best" (the Ideas tab) is NOT here — Ideas is a self-contained ONE-WAY reachability
  // list ("where can I go, and with how many changes"), independent of the Trip tab's stay.
  const modeTakesStay = mode === "od" || mode === "from" || mode === "to";
  const rawNights = tripType === "simple" ? formApi.getStayNights() : null;
  // The nights count is the source of truth for a FIXED stay: null → one-way, else 0..3 map
  // to the fixed stays. Flexible is a separate flag: its stay is "flexible" and its return
  // is the day the user picked on the return calendar (carried on the query), NOT a derived
  // departure + N. od carries the EXPLICIT return date; discovery ("from"/"best") derives
  // its return from the getaway sweep instead, so it only needs the stay.
  const formFlexible = tripType === "simple" && modeTakesStay && formApi.isFlexible();
  const formNights = rawNights !== null && modeTakesStay ? rawNights : null;
  const stay: StayChoice | undefined = formFlexible ? "flexible" : formNights !== null ? stayFromNights(formNights) : undefined;
  // "Minimum time there" (hours) applies only to a same-day round trip; the default (4 h)
  // is left implicit so it never clutters the URL — only a non-default choice is carried.
  const rawStayMin = Number(refs.stayMin.value);
  const stayMinHours =
    stay === "sameday" && Number.isFinite(rawStayMin) && rawStayMin > 0 && rawStayMin !== SAME_DAY_MIN_ON_SITE_MIN / 60
      ? rawStayMin
      : undefined;
  const outDate = refs.date.value || query.date;
  // Flexible keeps the return the user picked on the calendar (still in window and on/after
  // the outbound).
  const flexReturn = query.returnDate && query.returnDate >= outDate ? query.returnDate : undefined;
  // A stay derives an explicit return for an exact route only (discovery derives its own from
  // the sweep): departure + the stepper's nights, which in Flexible is the range's span.
  const stayReturn = mode === "od" && formNights !== null ? returnAfterNights(outDate, formNights) : undefined;
  // Flexible carries the return the user picked on the calendar in EVERY stay-taking mode —
  // not just an exact route. Origin-only ("from") and destination-only ("to") discovery use
  // départ→retour as the getaway window (see getawayOptsFor), so dropping it here was what
  // left the arrival un-pickable when only one endpoint was filled. With no pick yet, an exact
  // route keeps the current span, so switching to Flexible or moving its departure keeps the stay.
  const returnDate = formFlexible ? (flexReturn ?? stayReturn) : stayReturn;
  return {
    mode,
    origin: legsMode ? undefined : resolveStation(refs.origin.value),
    destination: usesDestination ? resolveStation(refs.destination.value) : undefined,
    via: mode === "od" ? resolveStation(refs.via.value) : undefined,
    flexDays: refs.departDate.getMargin() || undefined,
    stay,
    stayMinHours,
    returnDate,
    legs: legsMode
      ? formApi
          .getLegValues()
          .map((l) => ({
            from: resolveStation(l.from) ?? "",
            to: resolveStation(l.to) ?? "",
            date: l.date || query.date,
          }))
          .filter((l) => l.from && l.to)
      : undefined,
    date: refs.date.value || query.date,
    card: parseCard(refs.card.value),
    departAfter: refs.departAfter.value || undefined,
    departBefore: refs.departBefore.value || undefined,
    arriveBefore: refs.arriveBefore.value || undefined,
    maxDurationMin: Number.isFinite(maxDur) && maxDur > 0 ? maxDur : undefined,
    trainType: refs.trainType.value || undefined,
    maxConnections: Number(refs.maxConnections.value),
    overnight: refs.overnight.checked || undefined,
    // Night trains: unchecked drops them; checked includes them, and the nested
    // "only" checkbox then narrows to sleep-aboard journeys.
    excludeNight: !refs.night.checked || undefined,
    onlyNight: (refs.night.checked && refs.onlyNight.checked) || undefined,
    region: refs.region.value || undefined,
    // Chips hold the committed cities; also fold in any text still in the input
    // (typed but not yet turned into a chip) so a pending entry isn't lost. Only the
    // tour-plan surface owns cities — legs mode / other tabs must not carry them.
    cities: planMode
      ? [
          ...new Set([
            ...formApi.getTourCities(),
            ...refs.cities.value
              .split(",")
              .map((s) => resolveStation(s))
              .filter((s): s is string => Boolean(s)),
          ]),
        ]
      : undefined,
    minDays: clampDays(refs.minDays.value, 1),
    maxDays: clampDays(refs.maxDays.value, 3),
    maxKm: Number.isFinite(maxKm) && maxKm > 0 ? Math.floor(maxKm) : undefined,
    maxLegKm: Number.isFinite(maxLegKm) && maxLegKm > 0 ? Math.floor(maxLegKm) : undefined,
    maxLegDurationMin:
      planMode && Number.isFinite(maxLegDur) && maxLegDur > 0
        ? Math.max(30, Math.floor(maxLegDur))
        : undefined,
    minLegDurationMin:
      planMode && Number.isFinite(minLegDur) && minLegDur > 0 ? Math.floor(minLegDur) : undefined,
    maxSpanDays:
      mode === "od" && Number.isFinite(span) && span >= 1 ? Math.min(14, Math.floor(span)) : undefined,
    // Search radius (km): exact trip, plus the browse modes ("Where to?" / "Where
    // from?"), where it substitutes the anchor for a nearby station.
    radiusKm:
      (mode === "od" || mode === "from" || mode === "to") && Number.isFinite(rad) && rad >= 10
        ? Math.min(300, Math.floor(rad))
        : undefined,
    // "Hidden train" (hidden-city ticketing) is a global preference (Advanced, on by
    // default, present on every tab), so it's read regardless of mode; only the exact
    // trip actually surfaces hidden trains, the other modes just carry the flag.
    hidden: refs.hidden.checked || undefined,
    // The "finish by" date only applies to a tour plan with a fixed finish.
    tourEndDate:
      planMode && resolveStation(refs.destination.value) ? refs.endDate.value || undefined : undefined,
    // The sort lives in the results toolbar, not the form — carry it through.
    sort: query.sort,
  };
}

/** A history-entry payload carrying a snapshot of the live form, so a gesture-Back /
 *  popstate can restore staged (un-searched) edits — departure, destination, filters —
 *  instead of resetting them (state preservation across navigation). */
interface HistoryState {
  form: SearchQuery;
  /** True on a drilled-in DETAIL page (a route opened from a list, or the saved-trips page):
   *  the in-app "Retour" shows and Back returns to the underlying list. The browser history
   *  is the single back-stack — this flag just marks which entries are drill-ins. */
  detail?: boolean;
  /** The saved-trips page: renderSearch shows it in place of the search under it. */
  saved?: boolean;
  /** Pushed off the bare landing form by an in-place refinement (the trip-type toggle, the
   *  nights, Flexible): the user is still on the form, so it is the landing's form too. */
  landing?: boolean;
  /** The list's scroll offset, stamped when a navigation leaves the entry. */
  scroll?: number;
}
/** The current history entry's state, empty on an entry the app never stamped. */
function entryState(): Partial<HistoryState> {
  const s: unknown = history.state;
  return s && typeof s === "object" ? (s as Partial<HistoryState>) : {};
}
/** Whether the current history entry is a drilled-in detail page. */
function currentDetail(): boolean {
  return Boolean(entryState().detail);
}
// The latest form of the entry pushed off the bare landing by an in-place refinement, which
// a Back to the landing restores; null when a Search or a drill-in left the landing instead.
let landingForm: SearchQuery | null = null;
/** Stamp the current entry with `query` and the live form, keeping its other flags. */
function restamp(): void {
  const state = { ...entryState(), form: readQueryFromForm() };
  if (state.landing) landingForm = state.form;
  store.updateUrl(query, state);
}
/** Stamp the entry a navigation leaves: the list's scroll offset, which Back restores, and
 *  on the bare landing the form as the user left it. */
function leaveEntry(): void {
  const state = { ...entryState(), scroll: listScroller().scrollTop };
  if (!store.urlHasQuery()) {
    state.form = readQueryFromForm();
    landingForm = null;
  }
  history.replaceState(state, "", location.href);
}

/** Parse a day-count input into 1..14, falling back to `fallback`. */
function clampDays(raw: string, fallback: number): number {
  const n = Math.floor(Number(raw.trim()));
  return Number.isFinite(n) && n >= 1 ? Math.min(14, n) : fallback;
}

/** The default return day for a round trip: two days after departure, clamped to the window. */
function proposedReturn(depart: string): string {
  const lastBookable = addDays(today, BOOKING_WINDOW_DAYS - 1);
  const two = addDays(depart, 2);
  return two > lastBookable ? lastBookable : two;
}

/**
 * Commit the current `query` to the URL + history and run the search.
 *
 * `push` distinguishes a genuine NAVIGATION (form → results via Search, drilling into a
 * route, opening the saved page — a new Back target) from an in-place REFINEMENT of the
 * view already on screen (a trip-type / nights / Flexible toggle). A navigation pushes a
 * new history entry; a refinement replaces the current one, so toggling never piles up
 * history entries you must Back through ("Back needs ~10 presses, same screen repeats").
 *
 * Either way the entry carries a live form snapshot, so a browser Back / popstate restores
 * the exact filled form that produced the page instead of wiping it (state preservation).
 * The one exception: the FIRST commit off the bare home form always pushes once (even a
 * refinement), so there is a home/form entry to Back to — otherwise an in-place refinement
 * on the landing screen would leave no way back to the form.
 */
function applyAndRun(push = true, detail = false): void {
  const leavingBareForm = !store.urlHasQuery();
  // Never push a history entry identical to the one already on screen. Toggling round trip
  // on the home form runs the search (pushing a results entry), so pressing Search right
  // after would push a SECOND identical results entry — leaving two duplicate screens and
  // making Back need two presses to reach the form ("I go round trip, I search, then have to
  // return twice"). If the query we're committing is the same search already in the URL,
  // replace in place instead of pushing a duplicate.
  const alreadyShown = store.urlHasQuery() && store.queryToParams(query).toString() === location.search.replace(/^\?/, "");
  if ((push || leavingBareForm) && !alreadyShown) {
    leaveEntry();
    // Push a browser history entry so the native Back button returns to the prior page,
    // stashing a snapshot of the live form on the entry so a gesture-Back / popstate can
    // restore the exact form that produced this page instead of wiping it. `detail` marks a
    // drilled-in page (route from a list) so renderSearch shows the in-app Retour.
    const form = readQueryFromForm();
    const landing = leavingBareForm && !push;
    if (landing) landingForm = form;
    store.pushUrl(query, { form, detail, landing });
  } else {
    // In-place refinement of the view already on screen: REPLACE the current entry (still
    // stamping the live form snapshot, so Back restores the filled form) so a run of
    // toggles adds zero history entries. The entry keeps its flags — a refine stays on the
    // same (possibly drilled-in) page.
    restamp();
  }
  settings = { ...settings, card: query.card };
  store.saveSettings(settings);
  runSearch();
  // Move focus to the results heading so screen-reader users hear the new context,
  // but don't let focus yank the scroll — callers control scrolling explicitly.
  refs.title.focus({ preventScroll: true });
}

/**
 * Re-render the current query in place: synchronous (no spinner flash), keeping
 * the scroll position. Used for cheap updates like changing the calendar day,
 * where a full teardown + spinner + scroll-to-top is jarring.
 */
/** The scroll container the results actually live in: the drawer's own scroller on
 *  mobile (the window does NOT scroll there), else the window. */
function resultsScroller(): HTMLElement | null {
  const drawer = document.querySelector<HTMLElement>(".drawer-scroll");
  return drawer && drawer.scrollHeight > drawer.clientHeight + 1 ? drawer : null;
}

/** The element the result list scrolls in: the drawer on a phone, the main column on a
 *  desktop, else the page. */
function listScroller(): Element {
  const scrolls = (e: Element | null): e is Element => Boolean(e && /auto|scroll/.test(getComputedStyle(e).overflowY));
  return (
    [".drawer-scroll", ".main-col"].map((s) => document.querySelector(s)).find(scrolls) ??
    document.scrollingElement ??
    document.documentElement
  );
}

/** Scroll the list to `top`, following it while its chunks render in, until it gets there
 *  or stops growing. */
function scrollListTo(top: number): void {
  const gen = renderGen;
  const scroller = listScroller();
  let height = -1;
  const step = (): void => {
    if (gen !== renderGen || scroller.scrollHeight === height) return;
    height = scroller.scrollHeight;
    scroller.scrollTop = top;
    if (scroller.scrollTop < top - 1) requestAnimationFrame(step);
  };
  step();
}

/**
 * Gently reveal an element that sits BELOW the current fold — and only then. A calendar
 * tap must never jerk the page/drawer UP (David: "clicking a date scrolls up, why?"), so
 * this is a one-way scroll: if the target is already visible or above the fold, it does
 * nothing. Used to surface genuinely-new content, the return leg the first time it opens,
 * never to re-anchor on every tap.
 */
function revealElement(target: HTMLElement | null): void {
  if (!target) return;
  const rect = target.getBoundingClientRect();
  const scroller = resultsScroller();
  const top = scroller ? scroller.getBoundingClientRect().top : 0;
  const bottom = scroller ? scroller.getBoundingClientRect().bottom : window.innerHeight;
  // Already on screen (or scrolled past above) → leave the scroll exactly where it is.
  if (rect.top >= top && rect.top <= bottom) return;
  if (rect.top < top) return; // above the fold — never scroll up to it
  target.scrollIntoView({ block: "start", behavior: "smooth" });
}

function refreshInPlace(): void {
  // Restamp the entry with a FRESH form snapshot (not just the URL): an in-place refine —
  // completing a Flexible range, moving the return — changes the form, and a Back must
  // restore that latest form, not the snapshot frozen before the refine. The entry keeps
  // its flags: an in-place refresh (calendar day, moving the return) stays on the same page.
  restamp();
  const scroller = resultsScroller();
  const scrollY = scroller ? scroller.scrollTop : window.scrollY;
  // A calendar-day pick is usually what triggers an in-place refresh. If a day cell had
  // keyboard focus, the teardown below destroys it and focus falls to <body>; note it so
  // we can put focus back on the equivalent (selected) cell after the re-render.
  const active = document.activeElement;
  const restoreCalFocus =
    active instanceof HTMLElement && active.classList.contains("cal-cell") && refs.results.contains(active);
  // Mirror ONLY the date back to its input — a calendar-day pick or day-shift is the
  // only form-bound value an in-place refresh changes. Deliberately do NOT re-sync the
  // whole form from `query` here: that clobbered a staged, not-yet-searched edit — a
  // ticked "Night trains", a tour city chip — because those live in the form (and
  // `tourCities`) but aren't folded into `query` until Search. Re-syncing silently
  // reset them, which is the "my filter / cities disappeared" bug. A day picked under the
  // results moves the form calendar's day too.
  const dateMoved = refs.date.value !== query.date;
  refs.date.value = query.date;
  refs.departDate.setDate(query.date);
  if (dateMoved) deferFormCalRepaint();
  formApi.refreshTourEndDate();
  clear(refs.results);
  renderSearch();
  if (scroller) {
    scroller.scrollTop = scrollY;
  } else {
    window.scrollTo({ top: scrollY });
  }
  if (restoreCalFocus) refs.results.querySelector<HTMLElement>(".cal-cell.sel")?.focus({ preventScroll: true });
}

// --- reactive home-form calendar --------------------------------------------

// Flexible Trip-tab range picker: are we AWAITING the return tap (a departure was just
// tapped)? Starts false so the FIRST tap sets a fresh departure even when the form already
// carries one from a deep link / prior state; a departure tap arms it, the return tap (or a
// shape change / navigation) clears it. See pickFormRange.
let formRangeAwait = false;
let formCalTimer = 0;
/** Debounced repaint: origin typing fires per keystroke, and the origin-only round-trip
 *  sweep is the one heavy path — coalesce bursts so it runs once the value settles. */
function scheduleFormCalRepaint(): void {
  if (formCalTimer) clearTimeout(formCalTimer);
  formCalTimer = setTimeout(() => {
    formCalTimer = 0;
    repaintFormCalendar();
  }, 140) as unknown as number;
}

/** Repaint on the NEXT frame rather than inline, cancelling any pending debounced pass: the
 *  control's own visual update (a select's new value, a flipped switch) paints first, then
 *  the availability sweep — which can take ~1s cold for a hub like Paris — runs. */
function deferFormCalRepaint(): void {
  if (formCalTimer) {
    clearTimeout(formCalTimer);
    formCalTimer = 0;
  }
  requestAnimationFrame(() => repaintFormCalendar());
}

/**
 * A committed FILTER change — max correspondances, the via hub, the time window, the night
 * rules… Unlike a typed route edit, which stays staged so the search doesn't chase every
 * keystroke, a filter is one deliberate choice, so it applies to everything on screen at
 * once: the form calendar repaints, and the results already showing that route re-run in
 * place, taking their own calendars with them.
 *
 * Three cases deliberately stay staged, because there is nothing on screen to bring up to
 * date and running a search behind the user's back would be a surprise: the bare landing
 * form (nothing searched yet), the reload prompt (`searchHeldBack` — it waits for Search by
 * design), and a form whose ROUTE has been edited but not yet searched. That last one keeps
 * the older contract intact: a staged destination never rides along on a filter change; it
 * waits for Search, and the filter goes with it.
 */
function applyFilterChange(): void {
  deferFormCalRepaint();
  if (searchHeldBack || !store.urlHasQuery()) return;
  const fq = readQueryFromForm();
  if (!queryIsRenderable(fq) || !sameTargetAs(fq, query)) return;
  query = fq;
  refreshInPlace();
}

/** Whether two queries search the same THING — the route/legs/cities and the day — so one can
 *  replace the other in place. Filters, sort and stay length are deliberately not compared:
 *  they're what the refresh is applying. */
function sameTargetAs(a: SearchQuery, b: SearchQuery): boolean {
  const key = (q: SearchQuery): string =>
    JSON.stringify([q.mode, q.origin ?? "", q.destination ?? "", q.date, q.legs ?? [], q.cities ?? []]);
  return key(a) === key(b);
}

/**
 * Paint the Trip-tab home form's availability calendar for the CURRENT controls, so a
 * green day always means "a trip is possible that day" for the chosen shape:
 *  - no origin            → a neutral, tappable month + a "pick a departure station" hint;
 *  - origin+dest, one-way → availabilityCalendar (a departure exists), as runOdSearch;
 *  - origin+dest, same day → stayCalendar 'hours' (a there-and-back-same-day works);
 *  - origin+dest, N nights → stayCalendar 'nights' (an N-night round trip is feasible);
 *  - origin only, one-way  → reachableCountCalendar (the days you can leave);
 *  - origin only, round/day → getawayIdeas().perDay (days a getaway is possible).
 * The option helpers (odConnOptsFor / getawayOptsFor) are the SAME ones the real search
 * uses, so the per-day journey sweeps hit the warm memo caches instead of recomputing.
 */
function repaintFormCalendar(): void {
  const mount = refs?.formCalendar;
  if (!mount || !deps) return;
  // Only the Trip tab uses the reactive calendar as its picker; clear it elsewhere so no
  // stale grid lingers (the block is display:none on the other tabs anyway).
  if (tripType !== "simple") {
    clear(mount);
    return;
  }
  const { trains } = deps;
  const o = resolveStation(refs.origin.value);
  const d = resolveStation(refs.destination.value);
  const nights = formApi.getStayNights(); // null = one-way, else 0..N
  const round = nights !== null;
  // Flexible → the inline month becomes a departure→return RANGE picker (requirement 2):
  // `selected` is the departure, the return is `query.returnDate` (in window, on/after it),
  // else — a link with none — on an exact route the departure + 2 its results propose. While
  // the return tap is awaited there is none yet. Other shapes keep the single-date picker.
  const flexRange = formApi.isFlexible();
  const selected = refs.date.value || query.date;
  const windowDates = dateRange(today, BOOKING_WINDOW_DAYS);
  const pickedReturn = query.returnDate && query.returnDate >= selected ? query.returnDate : undefined;
  const rangeEnd =
    flexRange && !formRangeAwait ? (pickedReturn ?? (o && d ? proposedReturn(selected) : undefined)) : undefined;
  const rangeOpt = flexRange ? { end: rangeEnd, awaiting: formRangeAwait } : undefined;
  // A query snapshot read purely to derive the SAME options the eventual search will use.
  const fq = readQueryFromForm();

  // Keep the collapsed-header summary in step with the picked day — in Flexible it spells
  // out the two endpoints ("Aller: … → Retour: …") or prompts for the return, and the
  // inert stepper reads the range's nights.
  if (flexRange) {
    const dep = selected ? formatDate(selected) : "";
    if (rangeEnd) formApi.setFlexible(dayIndex(rangeEnd) - dayIndex(selected));
    refs.formCalPicked.textContent = rangeEnd
      ? t("form_cal_range", { from: dep, to: formatDate(rangeEnd) })
      : t("form_cal_range_await", { from: dep });
  } else {
    refs.formCalPicked.textContent = selected ? t("form_cal_departed", { date: formatDate(selected) }) : "";
  }

  const calCtx: RenderCtx = { ...ctx(), onSelectDay: flexRange ? pickFormRange : pickFormDay };
  clear(mount);

  // Neutral month before EITHER endpoint is chosen — plain, tappable, never a dead grid.
  if (!o && !d) {
    const neutralDays: CalendarDay[] = windowDates.map((date) => ({ date, available: false, count: 0 }));
    mount.append(
      render.calendarEl(neutralDays, calCtx, selected, {
        title: t("form_cal_title"),
        hideTitle: true, // the collapsible header already reads "Quand partir ?" — don't repeat it
        neutral: true,
        hint: t("form_cal_hint"),
      }),
    );
    return;
  }

  let cal: CalendarDay[];
  let calOpts: Parameters<typeof render.calendarEl>[3];
  if (o && d) {
    // Span-aware, exactly like the results list this calendar previews (odJourneyOptsFor).
    const { journeyOpts, accept } = odJourneyOptsFor(fq, o, d);
    if (!round) {
      cal = availabilityCalendar(trains, o, d, windowDates, journeyOpts, accept);
      calOpts = { title: t("form_cal_title"), hideTitle: true };
    } else if (nights === 0 && !flexRange) {
      cal = stayCalendar(trains, o, d, windowDates, getawayOptsFor(fq), "hours");
      calOpts = { title: t("form_cal_title"), hideTitle: true, count: (h: number) => t("daytrip_cal_hours", { dur: formatDuration(h * 60) }), countLegend: t("cal_legend_hours") };
    } else if (flexRange) {
      // Flexible: show the availability for the LEG being picked — the OUTBOUND (o→d) while
      // choosing the departure, the RETURN (d→o) once the departure is set and we're awaiting
      // the return tap — so a green day (and its count) means "trains run that day for what
      // you're picking right now" (David: "available trains per day for departure or return
      // depending on what you're choosing").
      if (formRangeAwait) {
        // A day before the departure is no return: a tap there restarts the range.
        const ret = odJourneyOptsFor(fq, d, o);
        cal = availabilityCalendar(trains, d, o, windowDates, ret.journeyOpts, ret.accept).map((day) =>
          day.date < selected ? { ...day, available: false, count: 0 } : day,
        );
        calOpts = { title: t("form_cal_title"), hideTitle: true, countLegend: t("cal_legend_return") };
      } else {
        cal = availabilityCalendar(trains, o, d, windowDates, journeyOpts, accept);
        calOpts = { title: t("form_cal_title"), hideTitle: true, countLegend: t("cal_legend_depart") };
      }
    } else {
      // Fixed N-night round trip: the days an N-night there-and-back is feasible.
      cal = stayCalendar(trains, o, d, windowDates, getawayOptsFor(fq), "nights");
      calOpts = { title: t("form_cal_title"), hideTitle: true, count: (n: number) => t("getaway_nights", { n }), countLegend: t("cal_legend_nights") };
    }
  } else if (o) {
    if (!round) {
      // Origin only, one-way: the days you can leave (connection-aware; count = destinations).
      cal = reachableCountCalendar(trains, o, windowDates, { ...filterOptsFor(fq), maxConnections: fq.maxConnections });
    } else {
      // Origin only, round / same-day: the days a getaway is possible — the same two-sweep
      // pass runGetaways uses, whose per-day sweeps are memoized, so a repaint is cheap.
      cal = getawayIdeas(trains, o, windowDates, getawayOptsFor(fq)).perDay;
    }
    calOpts = { title: t("form_cal_title"), hideTitle: true, count: (n: number) => t("best_cal_count", { n }), countLegend: t("cal_legend_dest") };
  } else {
    // Destination only (no origin): browse by ARRIVAL — which days you can reach `d`, and
    // from how many origins. One-way counts reachable origins; round/same-day counts the
    // origins you could round-trip from (reverse getaway). Mirrors the origin-only case so
    // "only a destination" never shows a dead, empty grid. `d` is guaranteed here: the
    // `!o && !d` case early-returned, and `o` is falsy in this branch, so `d` is set.
    const dest = d as string;
    if (!round) {
      cal = reachableCountCalendar(trains, dest, windowDates, { ...filterOptsFor(fq), maxConnections: fq.maxConnections }, "to");
    } else {
      cal = reverseGetawayIdeas(trains, dest, windowDates, getawayOptsFor(fq)).perDay;
    }
    calOpts = { title: t("form_cal_title"), hideTitle: true, count: (n: number) => t("best_cal_count", { n }), countLegend: t("cal_legend_origin") };
  }
  // In Flexible, overlay the departure→return range + the two-step prompt onto whichever
  // availability calendar was built above.
  if (rangeOpt && calOpts) {
    calOpts = { ...calOpts, range: rangeOpt, hint: t("form_cal_flex_hint") };
  }
  mount.append(render.calendarEl(cal, calCtx, selected, calOpts));
}

/**
 * A day tapped on the home-form calendar: set the departure (query.date + the form's date
 * field), then — if the route is complete — show/refresh that day's trip in place, so the
 * calendar doubles as a working picker. An incomplete route just stages the date.
 */
function pickFormDay(date: string): void {
  refs.date.value = date;
  refs.departDate.setDate(date);
  commitFormPick();
}

/** Run the form's picked day(s): refresh the results for the same route, else search. */
function commitFormPick(): void {
  const fq = readQueryFromForm();
  // The bare landing shows no results to refresh, so a pick there is a navigation.
  const sameRoute =
    store.urlHasQuery() &&
    query.origin === fq.origin &&
    query.destination === fq.destination &&
    (query.mode === "od" || tripIsRound());
  query = fq;
  // Run as soon as the query is searchable — an exact route OR a one-ended discovery
  // (origin-only "from"/"best", destination-only "to") — so tapping a day refreshes the
  // results AND the map even with a single endpoint filled (David: "destination-only same
  // day, the calendar selection doesn't update the map"). Only a truly empty query stays
  // staged.
  if (queryIsRenderable(query)) {
    if (sameRoute) refreshInPlace();
    else applyAndRun();
  }
  repaintFormCalendar();
}

/**
 * A day tapped on the Flexible Trip-tab calendar, which is a departure→return RANGE picker
 * (requirement 2). The first tap stages the departure on the form and arms the calendar for
 * the return; the next tap on/after it sets the return (query.returnDate) with stay
 * "flexible" and runs the range like a single-day pick, while an earlier tap restarts. A tap
 * once the range is complete begins a fresh range.
 */
function pickFormRange(date: string): void {
  const out = refs.date.value || query.date;
  if (formRangeAwait && date >= out) {
    formRangeAwait = false;
    query = { ...query, returnDate: date };
    commitFormPick();
    return;
  }
  // The departure stays on the form, its header reading it as pending until the return
  // tap; `query`, the URL and the results keep the range already on screen meanwhile.
  formRangeAwait = true;
  refs.date.value = date;
  refs.departDate.setDate(date);
  repaintFormCalendar();
}

// --- search execution -------------------------------------------------------

/**
 * Connection options for the tour planner. Each tour hop is a single journey, so
 * the per-train time cap maps onto a journey's total-duration limit; a hop longer
 * than that is never considered. (Overnight stays are modelled by the per-city day
 * window, not a long layover, so the tour doesn't widen the connection ceiling.)
 */
function tourPlanOpts() {
  return {
    maxConnections: query.maxConnections,
    ...(query.maxLegDurationMin ? { maxDurationMin: query.maxLegDurationMin } : {}),
    ...(query.minLegDurationMin ? { minDurationMin: query.minLegDurationMin } : {}),
    // The train-type and depart-time filters are shown in every mode's Advanced
    // panel, so honour them here too — otherwise a tour silently ignores them.
    ...(query.trainType ? { trainType: query.trainType } : {}),
    ...(query.departAfter ? { departAfter: query.departAfter } : {}),
    ...(query.departBefore ? { departBefore: query.departBefore } : {}),
    ...(query.arriveBefore ? { arriveBefore: query.arriveBefore } : {}),
    ...(query.excludeNight ? { excludeNight: true } : {}),
    ...(query.onlyNight ? { onlyNight: true } : {}),
    // Overnight stopovers widen the layover ceiling, so a hop can wait a whole day
    // at a hub — e.g. step off a night train in the morning and pick up the next
    // night train that evening (a sleeper every day).
    ...(query.overnight ? { maxConnectionMin: OVERNIGHT_MAX_CONNECTION_MIN } : {}),
  };
}

function filterOpts() {
  return filterOptsFor(query);
}

// --- result sorting ---------------------------------------------------------

const SORT_LABEL = {
  rec: "sort_rec",
  trains: "sort_trains",
  days: "sort_days",
  closest: "sort_closest",
  fastest: "sort_fastest",
  name: "sort_name",
  arrival: "sort_arrival",
  departure: "sort_departure",
} as const;

/** Build the sort-picker option list for a mode from its applicable keys. */
function sortOptions(keys: SortKey[]): { value: SortKey; label: string }[] {
  return keys.map((k) => ({ value: k, label: t(SORT_LABEL[k]) }));
}

/** Re-rank the current list to the chosen key (no recompute) and refresh in place. */
function onSort(key: SortKey): void {
  query = { ...query, sort: key === "rec" ? undefined : key };
  refreshInPlace();
}

interface SortAccessors<T> {
  name: (x: T) => string;
  trains?: (x: T) => number;
  days?: (x: T) => number;
  distanceKm?: (x: T) => number;
  durationMin?: (x: T) => number;
  arriveMin?: (x: T) => number; // absolute arrival minutes (earliest first)
  departMin?: (x: T) => number; // departure minutes (earliest first)
}

/**
 * Re-order a list by the active sort key, leaving the mode's natural rank (and the
 * default "rec") untouched. A key with no accessor for this list is a no-op, so
 * each mode can offer just the keys that make sense. Sorts a copy.
 */
function applySort<T>(items: T[], acc: SortAccessors<T>): T[] {
  const key = query.sort;
  if (!key || key === "rec") return items;
  const arr = [...items];
  switch (key) {
    case "trains":
      if (acc.trains) arr.sort((a, b) => acc.trains!(b) - acc.trains!(a));
      break;
    case "days":
      if (acc.days) arr.sort((a, b) => acc.days!(b) - acc.days!(a));
      break;
    case "closest":
      if (acc.distanceKm) arr.sort((a, b) => acc.distanceKm!(a) - acc.distanceKm!(b));
      break;
    case "fastest":
      if (acc.durationMin) arr.sort((a, b) => acc.durationMin!(a) - acc.durationMin!(b));
      break;
    case "arrival":
      if (acc.arriveMin) arr.sort((a, b) => acc.arriveMin!(a) - acc.arriveMin!(b));
      break;
    case "departure":
      if (acc.departMin) arr.sort((a, b) => acc.departMin!(a) - acc.departMin!(b));
      break;
    case "name":
      arr.sort((a, b) => acc.name(a).localeCompare(acc.name(b)));
      break;
  }
  return arr;
}

/**
 * Round-trip ("getaway") search options, derived from the trip shape: a day trip is
 * a same-day round trip (nights 0, bestGetawayTo's default), a round trip keeps the
 * longest feasible stay (flexibleNights). Shared by the discovery lists and calendars.
 */
function getawayOpts() {
  return getawayOptsFor(query);
}

// Pending deferred-render frame, so an in-flight search can be cancelled (Escape).
let pendingRaf = 0;

// Bumped whenever a search starts or is cancelled, so a stale off-thread warm that
// finishes late never renders over a newer (or abandoned) search.
let searchToken = 0;
let searchLoading = false;

/** Cancel a search that's still showing its spinner (before its results render). */
function cancelLoading(): boolean {
  if (!searchLoading) return false;
  searchLoading = false;
  searchToken++; // invalidate any in-flight warm's completion
  if (pendingRaf) {
    cancelAnimationFrame(pendingRaf);
    pendingRaf = 0;
  }
  clear(refs.results); // drop the spinner — the search is abandoned
  setPassLoading(false);
  return true;
}

/** Run the current query and render it; `scrollTo` puts the list back at that offset. */
function runSearch(scrollTo?: number): void {
  if (passPending) return; // switchPass searches once the pass's trains are in
  searchToken++;
  const token = searchToken;
  searchLoading = true;
  searchHeldBack = false;
  if (pendingRaf) {
    cancelAnimationFrame(pendingRaf);
    pendingRaf = 0;
  }
  // Right after a pass switch, the previous results stay up, dimmed under the pass's
  // spinner, until these are ready: the page never goes blank in between.
  const switching = rootRef.classList.contains("pass-loading");
  if (!switching) {
    clear(refs.results);
    // Delayed spinner: CSS keeps it invisible for 150ms, so instant searches never
    // flash it, while heavy modes show it.
    refs.results.append(
      el("div", { class: "loading", attrs: { role: "status", "aria-label": t("loading") } }, [
        el("span", { class: "spinner", attrs: { "aria-hidden": "true" } }),
      ]),
    );
  }
  // Two frames so the spinner paints before the (now mostly cache-hit) render swaps in.
  const paint = (): void => {
    pendingRaf = requestAnimationFrame(() => {
      pendingRaf = requestAnimationFrame(() => {
        pendingRaf = 0;
        if (token !== searchToken) return; // superseded or cancelled
        searchLoading = false;
        clear(refs.results);
        renderSearch();
        if (switching) setPassLoading(false);
        if (scrollTo !== undefined) scrollListTo(scrollTo);
      });
    });
  };
  // No Worker (old browsers, and the jsdom test env): render straight away on the main
  // thread, exactly as before the worker existed.
  if (typeof Worker === "undefined") {
    paint();
    return;
  }
  // Otherwise pre-compute the heavy search primitives on the background worker so the
  // main thread stays responsive; the render then reads them straight from cache. If
  // the worker can't help, warmSearch resolves quickly and the render computes on-thread.
  void warmSearch(deps.trains, query, today, deps.apiBase).then(() => {
    if (token !== searchToken) return;
    paint();
  });
}

function updateDocTitle(): void {
  const label = (id: string) => deps.registry.label(id);
  let context = "";
  if (query.mode === "od" && query.origin && query.destination) {
    context = `${label(query.origin)} → ${label(query.destination)} · ${formatDate(query.date)}`;
  } else if (query.mode === "from" && query.origin) {
    context = `${t("mode_from")} ${label(query.origin)}`;
  } else if (query.mode === "to" && query.destination) {
    context = `${t("mode_to")} ${label(query.destination)}`;
  } else if (query.mode === "best" && query.origin) {
    context = `${t("mode_best")} · ${label(query.origin)}`;
  } else if (query.mode === "tour" && query.origin) {
    context = `${t("mode_tour")} · ${label(query.origin)}`;
  }
  document.title = context ? `${context} — ${t("appName")}` : APP_TITLE;
}

async function shareCurrentUrl(onCopied: () => void): Promise<void> {
  const url = location.href;
  if (navigator.share) {
    try {
      await navigator.share({ title: document.title, url });
    } catch {
      return;
    }
    return;
  }
  try {
    await navigator.clipboard.writeText(url);
    onCopied();
  } catch {
    return;
  }
}

// Bumped on every render, so an in-flight chunked list (see appendInChunks) stops
// building cards the moment a newer search/render replaces it.
let renderGen = 0;

/**
 * Append a long list to `container` in small batches across animation frames, so
 * building hundreds of cards never blocks a single frame: the first batch paints at
 * once, the rest fill in over the following frames. Self-cancels when a newer render
 * bumps renderGen. (Under the jsdom test shim rAF runs synchronously, so the whole
 * list still renders within the call.)
 */
function appendInChunks<T>(
  container: HTMLElement,
  items: T[],
  build: (item: T, i: number) => Node,
  first = 18,
  batch = 18,
): void {
  const gen = renderGen;
  let i = 0;
  const put = (count: number): void => {
    const frag = document.createDocumentFragment();
    const end = Math.min(i + count, items.length);
    for (; i < end; i++) frag.append(build(items[i]!, i));
    container.append(frag);
  };
  put(first);
  const step = (): void => {
    if (gen !== renderGen || i >= items.length) return;
    put(batch);
    requestAnimationFrame(step);
  };
  if (i < items.length) requestAnimationFrame(step);
}

function renderSearch(): void {
  renderGen++;
  activeStepBack = null; // each render re-registers its own step-back (if any)
  rootRef.dataset.detail = currentDetail() ? "on" : "";
  if (entryState().saved) return renderSavedPage();
  // A bare URL is the landing form: a filled form restored there waits for Search.
  if (!store.urlHasQuery() && queryIsRenderable(query)) {
    document.title = APP_TITLE;
    refs.title.textContent = "";
    showSearchPrompt();
    updateSearchBar();
    return;
  }
  const c = ctx();
  updateDocTitle();

  // NB: the map is drawn by exactly ONE call per render — the mode's own show()/
  // route(), or showBaseMap() on an empty state (via showHint / a "nothing to plot"
  // branch). Don't reset to the France basemap up front and then re-fit to markers:
  // that was a visible zoom-out-then-in on every search (jarring on Surprise me).

  // Back to the previous list (instant — journeys are memoized).
  if (currentDetail()) {
    refs.results.append(
      el("button", { class: "back-btn", type: "button", text: `← ${t("act_back")}`, on: { click: goBack } }),
    );
  }

  // Only a link can name a station the registry lacks (the form resolves to known ids):
  // say so, rather than "No MAX seat" for a place that does not exist.
  const unknown = [
    query.origin,
    query.destination,
    query.via,
    ...(query.cities ?? []),
    ...(query.legs ?? []).flatMap((l) => [l.from, l.to]),
  ].find((s) => s && !deps.registry.get(s));
  if (unknown) {
    refs.title.textContent = "";
    refs.results.append(render.emptyEl(t("err_station", { station: unknown })));
    showBaseMap();
    updateSearchBar();
    return;
  }

  // MAX SENIOR free tickets are weekday-only — flag a weekend outbound, and (round trip)
  // a weekend RETURN on a later day, since either leg must be booked free.
  // No open data says whether an Interrail seat is left: say so above every result.
  if (!deps.profile.seatKnown) {
    refs.results.append(el("p", { class: "notice", text: `${t("interrail_seat_notice")} ${t("how_ir_home")}` }));
  }
  if (query.card === "senior") {
    if (isWeekend(query.date)) {
      refs.results.append(el("p", { class: "notice", text: t("senior_weekend_warn") }));
    }
    const retDay = query.returnDate;
    if (tripIsRound() && retDay && retDay !== query.date && isWeekend(retDay)) {
      refs.results.append(el("p", { class: "notice", text: t("senior_weekend_return_warn") }));
    }
  }

  // An exact trip says what the train saves in CO₂ against driving or flying it.
  if (query.mode === "od" && query.origin && query.destination) {
    const km = stationDistanceKm(query.origin, query.destination);
    if (Number.isFinite(km) && km >= 1) {
      const co2 = tripCo2(Math.round(km));
      const fmt = new Intl.NumberFormat(getLang());
      const kg = (v: number) => fmt.format(v < 10 ? Math.round(v * 10) / 10 : Math.round(v));
      refs.results.append(
        el("p", {
          class: "eco-line",
          text: t("eco_trip", { train: kg(co2.train), car: kg(co2.car), plane: kg(co2.plane), km: fmt.format(co2.km) }),
        }),
      );
    }
  }

  if (query.mode === "from") {
    runBrowse(c, "from");
  } else if (query.mode === "to") {
    runBrowse(c, "to");
  } else if (query.mode === "best") {
    runBestSearch(c);
  } else if (query.mode === "tour") {
    runTourSearch(c);
  } else if (tripIsRound()) {
    // Exact route + a return wanted: the 2-leg day-trip / round-trip accordion.
    runTripSearch(c);
  } else {
    runOdSearch(c); // one-way exact trip
  }
  updateSearchBar();
}

/**
 * "from"/"to" browse. Direct destinations keep their rich expandable cards;
 * when changes are allowed, every extra place reachable only via a connection
 * is appended as a compact "via" row, so raising the connections setting really
 * does surface more destinations.
 */
function runBrowse(c: RenderCtx, dir: "from" | "to"): void {
  const { trains, registry } = deps;
  const anchor = dir === "from" ? query.origin : query.destination;
  // Day-trip / round-trip discovery plans a RETURN, so it needs a departure. From an
  // origin, list where you can go and get back; a destination-only (or empty) state
  // shows an armed prompt asking for an origin instead of a silent no-op.
  if (tripIsRound()) {
    if (dir === "from" && anchor) return runGetaways(c, anchor);
    // Destination-only round trip: reverse discovery — "from where can you round-trip to
    // reach this station?" — rather than a dead "add an origin" prompt (bug: a round trip
    // with only a destination did nothing useful).
    if (dir === "to" && anchor) return runReverseGetaways(c, anchor);
    return runArmedPrompt();
  }
  if (!anchor) return showHint(dir === "from" ? refs.origin : refs.destination);
  refs.title.textContent = t(dir === "from" ? "res_from_title" : "res_to_title", {
    station: registry.label(anchor),
    date: formatDate(query.date),
  });
  const countKey = dir === "from" ? "res_destinations" : "res_origins";

  // The list spans the chosen day, or — when "flexible dates" is on — a ±N-day
  // window around it. Every place shown has a free-MAX train within that span, so
  // there are no empty "0 this day" rows; widening the window surfaces more places.
  const flex = query.flexDays ?? 0;
  const lastBookable = addDays(today, BOOKING_WINDOW_DAYS - 1);
  const windowDates: string[] = [];
  for (let i = -flex; i <= flex; i++) {
    const d = addDays(query.date, i);
    // The selected date is always included; flex neighbours are clamped to the
    // bookable window.
    if (i === 0 || (d >= today && d <= lastBookable)) windowDates.push(d);
  }
  // Each card's train count and fastest time cover that span, as its list does.
  const groups = reachableGroups(trains, anchor, dir, windowDates, filterOpts());
  const directStations = new Set(groups.map((g) => g.station));

  // Total MAX availability over the booking window (today on), per destination, so each
  // card shows how many tickets exist before drilling into the exact-trip calendar.
  // Rank the list by that total (most-served first) — the "statistic" view.
  const stats = windowStats(trains, anchor, dir, dateRange(today, BOOKING_WINDOW_DAYS), filterOpts());
  groups.sort(
    (a, b) =>
      (stats.get(b.station)?.trains ?? 0) - (stats.get(a.station)?.trains ?? 0) ||
      a.station.localeCompare(b.station),
  );

  // Destinations reachable only with a change (not already direct), capped so the
  // "via" list stays compact like the direct list. Search the SAME ±flex window as
  // the direct list (keeping the shortest journey per station) — otherwise widening
  // flexibility surfaces more direct places but never any extra connecting ones.
  const connecting = ((): ReachTrip[] => {
    if (query.maxConnections <= 0) return [];
    const viaOpts = { ...filterOpts(), maxConnections: query.maxConnections };
    const byStation = new Map<string, ReachTrip>();
    for (const d of windowDates) {
      for (const tr of reachableBest(trains, anchor, d, stationsOnDate(trains, d), viaOpts, dir)) {
        if (tr.journey.legs.length <= 1 || directStations.has(tr.station)) continue;
        const cur = byStation.get(tr.station);
        if (!cur || tr.journey.totalDurationMin < cur.journey.totalDurationMin) byStation.set(tr.station, tr);
      }
    }
    return [...byStation.values()]
      .sort((a, b) => a.journey.totalDurationMin - b.journey.totalDurationMin)
      .slice(0, MAX_VIA_RESULTS);
  })();

  const total = groups.length + connecting.length;

  // Radius (browse): extra places reachable by hopping to a nearby anchor station,
  // excluding everywhere already listed. Computed on the selected day, and used both
  // to fill an otherwise-empty result and as a supplement below the main list.
  const already = new Set<string>([...directStations, ...connecting.map((tr) => tr.station)]);
  const nearby = query.radiusKm
    ? nearbyBrowse(anchor, dir, query.date, query.radiusKm, filterOpts(), already)
    : [];

  if (total === 0 && nearby.length === 0) {
    refs.results.append(render.emptyEl(t("res_none")));
    // Point at the next day the form calendar marks green, when there is one.
    const window = dateRange(today, BOOKING_WINDOW_DAYS);
    const opts = { ...filterOpts(), maxConnections: query.maxConnections };
    const next = nextAvailableDay(reachableCountCalendar(trains, anchor, window, opts, dir));
    if (next) refs.results.append(nextDayEl(next));
    refs.results.append(render.hintEl(t("res_none_hint")));
    showMap(anchor, []);
    return;
  }

  // One chunked list in reading order: direct cards, then via rows, then the nearby
  // section, so a later batch of direct cards never lands below the other two.
  const rows: (() => Node)[] = [];
  if (total > 0) {
    // Sort applies to the direct destinations (the rich cards); "rec" keeps the
    // most-served default. Via rows follow, in their duration order.
    const sortedGroups = applySort(groups, {
      name: (g) => registry.label(g.station),
      distanceKm: (g) => stationDistanceKm(anchor, g.station),
      durationMin: (g) => g.minDurationMin,
    });
    refs.results.append(
      render.listToolbarEl(
        t(countKey, { n: total }),
        query.sort ?? "rec",
        sortOptions(["rec", "fastest", "closest", "name"]),
        onSort,
      ),
    );
    for (const g of sortedGroups)
      rows.push(() => render.groupCardEl(g, dir, anchor, c, g.count, stats.get(g.station), flex));
    for (const tr of connecting) rows.push(() => render.reachTripRowEl(tr.station, tr.journey, c));
  }

  // Nearby paid-hop alternatives: a station near your anchor reaches (or is reached
  // by) somewhere your exact anchor doesn't. Each row names that station and opens its route.
  const radiusKm = query.radiusKm;
  if (radiusKm) {
    rows.push(() => {
      const sec = el("section", { class: "nearby" }, [
        el("h3", { text: t("nearby_title", { km: radiusKm }) }),
        el("p", { class: "muted small", text: t(dir === "from" ? "nearby_browse_from" : "nearby_browse_to") }),
      ]);
      if (nearby.length === 0) sec.append(render.emptyEl(t("nearby_none")));
      for (const n of nearby) {
        const note = t(dir === "from" ? "nearby_from_km" : "nearby_to_km", {
          station: registry.label(n.via),
          km: Math.round(n.km),
        });
        sec.append(render.nearbyTripRowEl(n.station, note, n.journey, c));
      }
      return sec;
    });
  }
  appendInChunks(refs.results, rows, (row) => row());

  // Tint map pins by how many changes each place takes: direct = green, each
  // extra connection pushes toward red (see RouteMap.reachColor).
  const mapInfo = new Map<string, MarkerInfo>();
  for (const g of groups) mapInfo.set(g.station, { title: registry.label(g.station), connections: 0 });
  for (const tr of connecting)
    mapInfo.set(tr.station, {
      title: registry.label(tr.station),
      connections: tr.journey.legs.length - 1,
    });
  showMap(
    anchor,
    [...groups.map((g) => g.station), ...connecting.map((tr) => tr.station), ...nearby.map((n) => n.station)],
    mapInfo,
  );
  // Draw the search-radius circle around the anchor and mark the nearby substitutes.
  if (query.radiusKm) showRadius([{ id: anchor, km: query.radiusKm }], nearby.map((n) => n.via));
}

/**
 * Round-trip DISCOVERY from an origin (no destination yet): which cities you can go to
 * and get back — each ranked by its best stay (hours on site when a same-day trip is the
 * best, nights when an overnight is). The possible-days calendar (auto-shown, prominent
 * in discovery) counts reachable destinations per day from the chosen departure onward;
 * clicking a destination row drops into the with-destination flow for that place.
 */
function runGetaways(c: RenderCtx, origin: string): void {
  const { trains, registry } = deps;
  const nights = query.stay ? stayNights(query.stay) : null;
  refs.title.textContent = t("rt_finder_title", {
    station: registry.label(origin),
    date: formatDate(query.date),
    stay: nights == null ? t("stay_flexible") : nights === 0 ? t("nights_sameday") : t("getaway_nights", { n: nights }),
  });
  // DAY-SCOPED: list the round trips you can start on the chosen day, so the count matches
  // the "When to leave?" calendar's number for that day (pick another day → that day's list).
  // A window-wide union would say "65 possible" while the calendar cell says "8 that day".
  const shown = asOpened(getawayIdeas(trains, origin, [query.date], getawayOpts()).trips);
  if (shown.length === 0) {
    refs.results.append(render.emptyEl(t("getaway_none")));
    // Never a dead end: the next day with a round trip, and the one-way list.
    const next = nextAvailableDay(getawayIdeas(trains, origin, dateRange(today, BOOKING_WINDOW_DAYS), getawayOpts()).perDay);
    if (next) refs.results.append(nextDayEl(next));
    refs.results.append(actionEl(t("getaway_oneway_btn"), () => applyTripShape("oneway")));
    showMap(origin, []);
    return;
  }
  refs.results.append(el("p", { class: "muted count", text: t("getaway_count", { n: shown.length }) }));
  appendInChunks(refs.results, shown, (trip) => {
    // The headline metric that VARIES between places: hours on site when the best trip
    // there is same-day (0 nights), nights away otherwise — self-evident per place, no
    // separate mode.
    const metric =
      trip.nights === 0
        ? t("daytrip_cal_hours", { dur: formatDuration(trip.onSiteMin ?? 0) })
        : t("getaway_nights", { n: trip.nights });
    return render.getawayCityRowEl(trip, c, { metric });
  });
  showMap(
    origin,
    shown.map((trip) => trip.destination),
    reachInfo(shown.map((trip) => ({ station: trip.destination, connections: trip.outbound.legs.length - 1 }))),
  );
}

/** A stay's returns on a later day, fastest first: the trip page's return list, whose first
 *  is the return it picks by default. */
function stayReturns(q: SearchQuery, origin: string, destination: string, retDate: string): Journey[] {
  const { journeyOpts, accept } = odJourneyOptsFor(q, origin, destination);
  return findJourneys(deps.trains, destination, origin, retDate, journeyOpts)
    .filter(accept)
    .sort((a, b) => a.totalDurationMin - b.totalDurationMin || a.departMin - b.departMin);
}

/** Discovery cards as the trips they open: a stay's travel time counts the return that trip
 *  picks by default (`stayReturns`), not the sweep's latest one home, so card and trip agree.
 *  A same-day card already counts the trip's default, the latest return home by midnight. */
function asOpened(trips: Getaway[]): Getaway[] {
  const opened: SearchQuery = { ...query, mode: "od", via: undefined };
  return trips
    .map((trip) => {
      if (trip.nights === 0) return trip;
      const back = stayReturns(opened, trip.outbound.origin, trip.outbound.destination, trip.back.date)[0];
      return back ? { ...trip, back, travelMin: trip.outbound.totalDurationMin + back.totalDurationMin } : trip;
    })
    .sort(sortGetaways);
}

/**
 * Reverse round-trip discovery: a round trip with only a DESTINATION filled. Lists the
 * origins you can round-trip FROM to reach `destination` (and come back), each a real
 * free-MAX there-and-back, ranked like the forward getaway list. Tapping an origin opens
 * that exact O → destination trip. Mirrors {@link runGetaways} with the roles swapped.
 */
function runReverseGetaways(c: RenderCtx, destination: string): void {
  const { trains, registry } = deps;
  refs.title.textContent = t("rt_reverse_title", { station: registry.label(destination) });
  // DAY-SCOPED (mirrors runGetaways): list the origins you can round-trip from on the chosen
  // day, so the count matches the "When to leave?" calendar's number for that day.
  // `trip.destination` here names the discovered ORIGIN (reverseGetawayIdeas relabels it).
  const shown = asOpened(reverseGetawayIdeas(trains, destination, [query.date], getawayOpts()).trips);
  if (shown.length === 0) {
    refs.results.append(render.emptyEl(t("getaway_none")));
    showMap(destination, []);
    return;
  }
  refs.results.append(el("p", { class: "muted count", text: t("rt_reverse_count", { n: shown.length }) }));
  appendInChunks(refs.results, shown, (trip) => {
    const metric =
      trip.nights === 0
        ? t("daytrip_cal_hours", { dur: formatDuration(trip.onSiteMin ?? 0) })
        : t("getaway_nights", { n: trip.nights });
    // openTo = the fixed destination: the card names the origin and opens origin → dest.
    return render.getawayCityRowEl(trip, c, { metric, openTo: destination });
  });
  // Plot the fixed destination plus each candidate origin around it.
  showMap(
    destination,
    shown.map((trip) => trip.destination),
    reachInfo(shown.map((trip) => ({ station: trip.destination, connections: trip.outbound.legs.length - 1 }))),
  );
}

/** Day/round trip with no origin (or a destination only): ask for a departure. */
function runArmedPrompt(): void {
  refs.title.textContent = "";
  refs.results.append(render.emptyEl(t("rt_need_origin")));
  showBaseMap();
  offerFocus(refs.origin);
}

/** A typed multi-city leg's journeys on its date, fastest first, then earliest. */
function legJourneys(leg: { from: string; to: string; date: string }): Journey[] {
  const opts = { ...filterOpts(), maxConnections: query.maxConnections };
  return findJourneys(deps.trains, leg.from, leg.to, leg.date, opts).sort(
    (a, b) => a.totalDurationMin - b.totalDurationMin || a.departMin - b.departMin,
  );
}

function runMultiCity(c: RenderCtx): void {
  const { trains, registry } = deps;
  const legs = (query.legs ?? []).filter((l) => l.from && l.to);
  if (legs.length === 0) {
    refs.results.append(render.emptyEl(t("multi_hint")));
    showBaseMap();
    return;
  }
  refs.title.textContent = t("multi_title", { n: legs.length });
  const stations: string[] = [];
  const chosen: (Journey | null)[] = legs.map(() => null);
  const windowDates = dateRange(today, BOOKING_WINDOW_DAYS);

  // The legs render as an accordion: each leg's calendar + full train list collapse
  // to just the chosen train once you pick one, so a long list doesn't push the next
  // leg far down the page. Picking a train collapses its leg, opens the next, and
  // scrolls to it; picking the LAST leg opens the whole-trip ticket modal. The head
  // toggles a leg open/closed by hand. A leg with nothing to pick stays open so its
  // message is never hidden.
  interface LegUI {
    sec: HTMLElement;
    head: HTMLElement;
    num: HTMLElement;
    summary: HTMLElement;
    calEl: HTMLElement;
    /** Every journey on the leg's date, fastest first. */
    journeys: Journey[];
    /** The leg's notice and train cards, rebuilt by fillLeg. */
    nodes: HTMLElement[];
    chosenCard: HTMLElement | null;
    collapsed: boolean;
    empty: boolean;
  }
  const legUI: LegUI[] = [];
  // Refresh a collapsed leg's one-line summary + its ✓/number badge from chosen[i].
  const refreshSummary = (i: number): void => {
    const ui = legUI[i];
    if (!ui) return;
    const j = chosen[i];
    clear(ui.summary);
    if (j) ui.summary.append(render.journeySummaryEl(j, c));
    ui.num.textContent = ui.collapsed && j ? "✓" : String(i + 1);
    ui.num.classList.toggle("is-done", ui.collapsed && Boolean(j));
  };
  const setCollapsed = (i: number, collapsed: boolean): void => {
    const ui = legUI[i];
    if (!ui) return;
    ui.collapsed = collapsed && !ui.empty; // a seatless leg stays open — nothing to collapse to
    ui.sec.classList.toggle("mc-collapsed", ui.collapsed);
    ui.head.setAttribute("aria-expanded", String(!ui.collapsed));
    ui.calEl.style.display = ui.collapsed ? "none" : "";
    for (const n of ui.nodes) n.style.display = !ui.collapsed || n === ui.chosenCard ? "" : "none";
    refreshSummary(i);
  };
  // List the journeys of leg i still catchable after leg i-1's pick arrives, keeping
  // leg i's own pick when it is among them, else the fastest.
  const fillLeg = (i: number): void => {
    const ui = legUI[i]!;
    const prev = chosen[i - 1] ?? null;
    const options = catchableAfter(ui.journeys, prev);
    const keep = chosen[i];
    chosen[i] = keep && options.includes(keep) ? keep : (options[0] ?? null);
    for (const n of ui.nodes) n.remove();
    ui.nodes = [];
    ui.chosenCard = null;
    ui.empty = options.length === 0;
    if (prev && (options.length < ui.journeys.length || legs[i]!.date < arrivalDate(prev))) {
      // Some (or all) of this leg's trains leave before the previous leg arrives.
      const arrival = { date: formatDate(arrivalDate(prev)), time: minutesToHHMM(journeyArriveAbs(prev)) };
      ui.nodes.push(
        options.length
          ? render.hintEl(t("mc_after", arrival))
          : el("p", { class: "notice", text: t("mc_missed", arrival) }),
      );
    } else if (options.length === 0) {
      ui.nodes.push(render.emptyEl(t("res_none")));
    }
    for (const j of options) {
      // Clicking a card (body or arrow) picks that train: collapse this leg to its
      // summary and step to the next one — see pickLeg.
      const card: HTMLElement = render.journeyEl(j, c, {
        selected: j === chosen[i],
        onPick: () => pickLeg(i, card, j),
        onArrow: () => pickLeg(i, card, j),
      });
      if (j === chosen[i]) ui.chosenCard = card;
      ui.nodes.push(card);
    }
    ui.sec.append(...ui.nodes);
  };
  const pickLeg = (i: number, card: HTMLElement, j: Journey): void => {
    chosen[i] = j;
    const ui = legUI[i];
    if (ui) ui.chosenCard = card;
    // Every later leg now starts from this arrival: re-list each in trip order.
    for (let k = i + 1; k < legUI.length; k++) {
      fillLeg(k);
      setCollapsed(k, legUI[k]!.collapsed);
    }
    setCollapsed(i, true); // collapse this leg to its summary…
    const next = legUI[i + 1];
    if (next) {
      // …open the next one and gently reveal it if it's below the fold (never scroll up).
      setCollapsed(i + 1, false);
      revealElement(next.sec);
    } else {
      // Last leg chosen → the whole itinerary is settled; open the trip ticket modal.
      showMultiTripModal(
        legs.map((lg, k) => ({ from: lg.from, to: lg.to, date: lg.date, journey: chosen[k] ?? null })),
        c,
      );
    }
  };
  // Pick a leg's date straight from the results: update that leg in the query and
  // MIRROR the date into just its form field (like refreshInPlace mirrors the main
  // date), then re-render in place. Deliberately NOT syncFormFromQuery — a full
  // re-sync would wipe staged, not-yet-searched edits (a toggled filter, a half-typed
  // extra leg), the "my filter disappeared" bug refreshInPlace exists to avoid.
  const setLegDate = (i: number, d: string): void => {
    if (legs[i]?.date === d) return;
    formApi.setLegDate(i, d);
    query = { ...query, legs: legs.map((lg, k) => (k === i ? { ...lg, date: d } : lg)) };
    refreshInPlace();
  };
  legs.forEach((leg, i) => {
    const opts = { ...filterOpts(), maxConnections: query.maxConnections };
    const journeys = legJourneys(leg);
    // The head is a button: collapsed it shows a ✓ + the picked train's summary;
    // clicking it re-opens the leg to change the choice (the "go back" affordance).
    // Its name is its content (number, route, date, pick); aria-expanded gives the state.
    const num = el("span", { class: "mc-num", text: String(i + 1) });
    const summary = el("span", { class: "mc-pick-slot" });
    const head = el(
      "button",
      {
        class: "mc-result-head",
        type: "button",
        attrs: { "aria-expanded": "true" },
        on: { click: () => setCollapsed(i, !legUI[i]!.collapsed) },
      },
      [
        num,
        el("span", { class: "mc-route" }, [
          el("bdi", { text: registry.label(leg.from) }),
          el("span", { class: "muted", text: " → " }),
          el("bdi", { text: registry.label(leg.to) }),
        ]),
        el("span", { class: "mc-date muted", text: formatDate(leg.date) }),
        summary,
        el("span", { class: "mc-chev", attrs: { "aria-hidden": "true" } }),
      ],
    );
    // Which days this leg has a free MAX seat, shown right here in the results so you
    // can see (and pick) an available date without opening the leg's own calendar —
    // including when the chosen day has no train, or none after the previous leg.
    // Clicking a day sets it and re-runs.
    const legCal = availabilityCalendar(trains, leg.from, leg.to, windowDates, opts);
    const legCtx: RenderCtx = { ...c, onSelectDay: (d) => setLegDate(i, d) };
    const calEl = render.calendarEl(legCal, legCtx, leg.date);
    const sec = el("section", { class: "mc-result" }, [head, calEl]);
    legUI[i] = { sec, head, num, summary, calEl, journeys, nodes: [], chosenCard: null, collapsed: false, empty: false };
    fillLeg(i);
    refs.results.append(sec);
    stations.push(leg.from);
    const next = legs[i + 1];
    if (!next || next.from !== leg.to) stations.push(leg.to);
  });
  // Start as a stepper: the first leg open to pick, every later leg collapsed to its
  // (fastest) default so the page stays short. Empty legs ignore this and stay open.
  legs.forEach((_, i) => setCollapsed(i, i > 0));
  // Step-wise Back: while a later leg is the active (open) step, Back re-opens the
  // previous leg to change it BEFORE exiting the whole multi-city flow — the stepper
  // walks backwards, mirroring how picking a leg walks forwards.
  activeStepBack = (): boolean => {
    const openIdx = legUI.findIndex((ui) => ui && !ui.collapsed);
    const prev = openIdx - 1;
    if (openIdx > 0 && legUI[prev] && chosen[prev] && !legUI[prev]!.empty) {
      setCollapsed(openIdx, true);
      setCollapsed(prev, false);
      legUI[prev]!.head.focus({ preventScroll: true });
      return true;
    }
    return false;
  };
  showRoute(stations);
}

function runTourSearch(c: RenderCtx): void {
  const { trains, registry } = deps;
  // The Multi tab's "legs" surface (or any URL carrying explicit legs) renders the
  // hand-typed itinerary; the "plan" surface below runs the city planner.
  if (formApi.getMultiMode() === "legs" || (query.legs && query.legs.length > 0)) return runMultiCity(c);
  if (!query.origin) return showHint(refs.origin);
  refs.title.textContent = t("tour_title", {
    station: registry.label(query.origin),
    date: formatDate(query.date),
  });
  const cities = query.cities ?? [];
  if (cities.length === 0) {
    refs.results.append(render.emptyEl(t("tour_hint")));
    showBaseMap();
    return;
  }
  const lo = query.minDays ?? 1;
  const hi = Math.max(lo, query.maxDays ?? 3);
  const planOpts = tourPlanOpts();
  const maxKm = query.maxKm; // optional cap on the tour's total straight-line km
  const legKm = query.maxLegKm; // optional cap on each hop's straight-line km
  // Optional fixed finish: end the tour at this city (may equal the start → a loop
  // back home). Empty = open-ended (end wherever the last nomad stop lands). With a
  // finish set, an optional end date requires arriving there on or before it.
  const end = query.destination || undefined;
  const endDate = end ? query.tourEndDate : undefined;
  // Flexible departure: the first hop may leave within ±flexDays of the chosen date
  // (never before today), so a tour is found even when nothing leaves on that exact day.
  const startFlex = query.flexDays ?? 0;
  // Up to 5 cities: try every order and pick the fastest. Beyond that, permuting
  // is factorial, so order them greedily (nearest reachable city each hop). If the
  // greedy route dead-ends, fall back to the typed order — a Surprise / "nearest
  // stop" run already builds a feasible chain in that order.
  let tours: Tour[];
  if (cities.length <= 5) {
    tours = planTours(trains, query.origin, cities, query.date, planOpts, 10, lo, hi, stationDistanceKm, maxKm, legKm, end, endDate, startFlex, today);
  } else {
    const single =
      planTourGreedy(trains, query.origin, cities, query.date, planOpts, lo, hi, stationDistanceKm, maxKm, legKm, end, endDate, startFlex, today) ??
      planTourInOrder(trains, query.origin, cities, query.date, planOpts, lo, hi, stationDistanceKm, maxKm, legKm, end, endDate, startFlex, today);
    tours = single ? [single] : [];
  }
  if (tours.length === 0) {
    refs.results.append(render.emptyEl(t("tour_none")), render.hintEl(t("tour_none_hint")));
    showBaseMap();
    return;
  }
  for (const tour of tours) refs.results.append(render.tourEl(tour, c));
  // Draw the best tour as a single chained path (origin → city1 → city2 → …),
  // not a star of separate lines from the origin to each city.
  const best = tours[0];
  showRoute(best ? [query.origin, ...best.order] : [query.origin, ...cities]);
}

function runBestSearch(c: RenderCtx): void {
  const { trains, registry } = deps;
  if (!query.origin) return showHint(refs.origin);
  // Ideas is a self-contained "where can I go from here" list — every destination reachable
  // across the booking window, each with how many changes it takes; tap one to see the days
  // you can go. It is ONE-WAY and independent of the Trip tab's round-trip / stay setting.
  refs.title.textContent = t("best_title_all", { station: registry.label(query.origin) });
  const window = dateRange(today, BOOKING_WINDOW_DAYS);
  const opts = { ...filterOpts(), maxConnections: query.maxConnections };
  let trips: BestTrip[] = bestTripsAcrossWindow(trains, query.origin, window, opts);
  if (query.region) {
    trips = trips.filter((tr) => registry.get(tr.destination)?.region === query.region);
  }
  if (trips.length === 0) {
    refs.results.append(render.emptyEl(t("res_none")), render.hintEl(t("res_none_hint")));
    showBaseMap();
    return;
  }

  // Month-long train count per destination (same figure as the "Where to?" list),
  // so an idea shows how well-served it is before you drill in.
  const stats = windowStats(trains, query.origin, "from", window, filterOpts());
  // Sort by trains / days reachable / distance / name; "rec" keeps fastest-first.
  const origin = query.origin;
  const sorted = applySort(trips, {
    name: (tr) => registry.label(tr.destination),
    trains: (tr) => stats.get(tr.destination)?.trains ?? 0,
    days: (tr) => tr.days ?? 0,
    distanceKm: (tr) => stationDistanceKm(origin, tr.destination),
    durationMin: (tr) => tr.journey.totalDurationMin,
  });
  refs.results.append(
    render.listToolbarEl(
      t("res_destinations", { n: trips.length }),
      query.sort ?? "rec",
      sortOptions(["rec", "trains", "days", "closest", "fastest", "name"]),
      onSort,
    ),
  );
  appendInChunks(refs.results, sorted, (tr) =>
    render.bestTripRowEl(tr, c, stats.get(tr.destination)?.trains, query.sort),
  );
  showMap(
    query.origin,
    sorted.map((tr) => tr.destination),
    reachInfo(sorted.map((tr) => ({ station: tr.destination, connections: tr.journey.legs.length - 1 }))),
  );
}

// via-aware connection options for an exact route, shared by BOTH legs of a round
// trip so a green day / kept journey honours the same hub + connection budget.
function odConnOpts(
  origin: string,
  destination: string,
): { connOpts: ConnectionOptions; passesVia: (j: Journey) => boolean } {
  return odConnOptsFor(query, origin, destination);
}

// The same, plus the Advanced "max trip span (days)": the widened day pool and the span cap
// that the journey lists AND their availability calendars both have to honour.
function odJourneyOpts(
  origin: string,
  destination: string,
): { journeyOpts: ConnectionOptions; accept: (j: Journey) => boolean } {
  return odJourneyOptsFor(query, origin, destination);
}

/** Append the "hidden train" (hidden-city ticketing) section for the exact route, if on. */
function appendHiddenTrains(c: RenderCtx): void {
  if (!query.hidden || !query.origin || !query.destination) return;
  const hidden = findHiddenTrains(deps.trains, query.origin, query.destination, query.date, {
    departAfter: query.departAfter,
    departBefore: query.departBefore,
    trainType: query.trainType,
    excludeNight: query.excludeNight,
  });
  if (hidden.length === 0) return;
  const sec = el("section", { class: "hidden-trains" }, [
    el("h3", { text: t("hidden_title") }),
    el("p", { class: "muted small", text: t("hidden_hint") }),
  ]);
  for (const h of hidden) sec.append(render.hiddenTrainRowEl(h, c));
  refs.results.append(sec);
}

/**
 * Append the radius "nearby alternatives" section (a station near either endpoint that
 * DOES have a free MAX seat), returning the nearby station ids for the map circles. On a
 * round / day trip this sits below BOTH legs, so a back-only nearby trip still shows.
 */
function appendNearbyAlternatives(
  c: RenderCtx,
  radiusAlt: ReturnType<typeof nearbyAlternatives> | null,
): string[] {
  if (!query.radiusKm || !radiusAlt || !query.origin || !query.destination) return [];
  const { registry } = deps;
  const alt = radiusAlt;
  const nearbyIds = [
    ...alt.fromOrigin.map((x) => x.id),
    ...alt.toDest.map((x) => x.id),
    ...alt.bothEnds.flatMap((x) => [x.from.id, x.to.id]),
  ];
  const sec = el("section", { class: "nearby" }, [
    el("h3", { text: t("nearby_title", { km: query.radiusKm }) }),
    el("p", { class: "muted small", text: t("nearby_hint") }),
  ]);
  if (alt.fromOrigin.length === 0 && alt.toDest.length === 0 && alt.bothEnds.length === 0) {
    sec.append(render.emptyEl(t("nearby_none")));
  } else {
    if (alt.fromOrigin.length) {
      sec.append(el("h4", { class: "nearby-sub", text: t("nearby_from_origin", { station: registry.label(query.origin) }) }));
      for (const a of alt.fromOrigin)
        sec.append(render.nearbyTripRowEl(a.id, t("nearby_km", { km: Math.round(a.km) }), a.journey, c));
    }
    if (alt.toDest.length) {
      sec.append(el("h4", { class: "nearby-sub", text: t("nearby_to_dest", { station: registry.label(query.destination) }) }));
      for (const a of alt.toDest)
        sec.append(render.nearbyTripRowEl(a.id, t("nearby_km", { km: Math.round(a.km) }), a.journey, c));
    }
    if (alt.bothEnds.length) {
      sec.append(el("h4", { class: "nearby-sub", text: t("nearby_both") }));
      for (const a of alt.bothEnds)
        sec.append(render.nearbyBothRowEl(a.from.id, Math.round(a.from.km), a.to.id, Math.round(a.to.km), a.journey, c));
    }
  }
  refs.results.append(sec);
  return nearbyIds;
}

/**
 * One-way exact trip: the route's 30-day availability calendar, the (flexible-date)
 * journey list booked on click, hidden-city trains and radius alternatives. Round /
 * day trips take the separate {@link runTripSearch} 2-leg accordion instead.
 */
function runOdSearch(c: RenderCtx): void {
  const { trains, registry } = deps;
  if (!query.origin || !query.destination) {
    return showHint(query.origin ? refs.destination : refs.origin);
  }
  refs.title.textContent = t("res_od_title", {
    origin: registry.label(query.origin),
    destination: registry.label(query.destination),
    date: formatDate(query.date),
  });
  refs.results.append(el("p", { class: "od-guide" }, [render.guideEl(c, query.destination, "link")]));

  // The list and its possible-days calendar run the SAME sweep — span cap included — so a
  // green day is always a day whose list has trains on it.
  const { journeyOpts, accept } = odJourneyOpts(query.origin, query.destination);
  const windowDates = dateRange(today, BOOKING_WINDOW_DAYS);
  const cal = availabilityCalendar(trains, query.origin, query.destination, windowDates, journeyOpts, accept);
  if (query.radiusKm) {
    const levels = nearbyCalendarLevels(query.origin, query.destination, windowDates, query.radiusKm, {
      ...filterOpts(),
      maxConnections: query.maxConnections,
    });
    for (const d of cal) {
      if (d.available) continue;
      const lvl = levels.get(d.date);
      if (lvl === 1) d.nearby = true;
      else if (lvl === 2) d.nearbyBoth = true;
    }
  }
  // The departure is already chosen (the form set it), so the possible-days calendar is
  // COLLAPSED by default here too — re-showing the whole strip read as asking the date
  // twice. A one-tap "Départ : … · Changer" summary reveals it to switch days or scan
  // availability, mirroring the round-trip outbound calendar's collapse pattern.
  // Opened from an Ideas one-way tap → show the days you can go up front (calendar open);
  // otherwise it's collapsed behind a one-tap "Départ : … · Changer" summary as usual.
  const odCal = render.collapsibleCalendar(
    render.calendarEl(cal, c, query.date),
    "cal-collapsible",
    openOdCalendar,
  );
  openOdCalendar = false;
  odCal.setLabel(t("outbound_change", { date: formatDate(query.date) }));
  refs.results.append(odCal.host);

  const lastBookable = addDays(today, BOOKING_WINDOW_DAYS - 1);
  // A widened pool (a span past the default 2 days) turns the list into "itineraries" with
  // its own count + cap notice; odJourneyOpts owns whether that widening happened.
  const spanDays = journeyOpts.spanDays;

  const flex = query.flexDays ?? 0;
  const searchDates: string[] = [];
  for (let i = -flex; i <= flex; i++) {
    const d = addDays(query.date, i);
    if (i === 0 || (d >= today && d <= lastBookable)) searchDates.push(d);
  }
  searchDates.sort();
  const raw = searchDates.flatMap((d) => findJourneys(trains, query.origin!, query.destination!, d, journeyOpts));
  const journeys: Journey[] = applySort(
    raw
      .filter(accept)
      .sort(
        (a, b) =>
          (flex > 0 ? dayIndex(a.date) - dayIndex(b.date) : 0) ||
          a.totalDurationMin - b.totalDurationMin ||
          a.departMin - b.departMin,
      ),
    {
      name: (j) => j.legs[0]?.depart ?? "",
      durationMin: (j) => j.totalDurationMin,
      arriveMin: (j) => (flex > 0 ? dayIndex(j.date) * 1440 : 0) + journeyArriveAbs(j),
      departMin: (j) => (flex > 0 ? dayIndex(j.date) * 1440 : 0) + j.departMin,
    },
  );

  const radiusAlt = query.radiusKm
    ? nearbyAlternatives(query.origin, query.destination, query.date, query.radiusKm, {
        ...filterOpts(),
        maxConnections: query.maxConnections,
      })
    : null;
  const hasNearby =
    !!radiusAlt &&
    (radiusAlt.fromOrigin.length > 0 || radiusAlt.toDest.length > 0 || radiusAlt.bothEnds.length > 0);

  if (journeys.length === 0) {
    if (!hasNearby) refs.results.append(render.emptyEl(t("res_none")), render.hintEl(t("res_none_hint")));
  } else {
    if (spanDays) {
      refs.results.append(el("p", { class: "muted count", text: t("res_itineraries", { n: journeys.length }) }));
      if (raw.length >= MAX_RESULTS) refs.results.append(render.hintEl(t("res_capped", { n: MAX_RESULTS })));
    }
    // Order the tickets: recommended (fastest, then earliest departure) by default, or by
    // arrival / departure / duration when the traveller picks a key.
    refs.results.append(
      render.listToolbarEl(
        t("badge_trains", { n: journeys.length }),
        query.sort ?? "rec",
        sortOptions(["rec", "arrival", "departure", "fastest"]),
        onSort,
      ),
    );
    for (const j of journeys)
      refs.results.append(
        render.journeyEl(j, c, { bookOnClick: true, dateLabel: flex > 0 ? formatDate(j.date) : undefined }),
      );
  }

  appendHiddenTrains(c);
  const nearbyIds = appendNearbyAlternatives(c, radiusAlt);

  const display = journeys[0] ?? null;
  showRoute(display ? [display.origin, ...display.hubs, display.destination] : [query.origin, query.destination]);
  if (query.radiusKm) {
    showRadius(
      [
        { id: query.origin, km: query.radiusKm },
        { id: query.destination, km: query.radiusKm },
      ],
      nearbyIds,
    );
  }
}

/**
 * The exact-route ROUND TRIP surface: a 2-leg accordion (Aller / Retour) reusing the
 * multi-city stepper. Leg 1 shows the outbound list (earliest-arriving default = most
 * time there) with the possible-days calendar collapsed above it (one tap to change the
 * departure); picking an outbound collapses it to a ✓ summary and opens Leg 2. Leg 2 is
 * ONE return calendar whose FIRST cell is same-day (the 0-night case) and later cells add
 * nights, plus the return list for the picked day — a 0-night return is labelled with
 * hours on site, later ones with nights, so day-vs-overnight is self-evident from the cell
 * tapped (no separate mode). Picking a return opens the whole-trip ticket. Accepting the
 * defaults = pick day + 2 trains (same click count).
 */
function runTripSearch(c: RenderCtx): void {
  const { trains, registry } = deps;
  if (!query.origin || !query.destination) {
    return showHint(query.origin ? refs.destination : refs.origin);
  }
  const origin = query.origin;
  const destination = query.destination;
  const lastBookable = addDays(today, BOOKING_WINDOW_DAYS - 1);
  const windowDates = dateRange(today, BOOKING_WINDOW_DAYS);
  const { connOpts } = odConnOpts(origin, destination);
  // Advanced "max trip span" caps how many days a single journey may span (overnight
  // trains). It is honoured on one-way trips through this same tab, so honour it here
  // too rather than silently ignoring the control on a round trip — on the return
  // calendar as much as on the lists it grades.
  const { journeyOpts, accept } = odJourneyOpts(origin, destination);

  // Amber "reachable only via a station within the radius" grading for the possible-days
  // calendars on a radius search — parity with the one-way calendar (runOdSearch).
  const gradeNearby = (cal: CalendarDay[], o: string, dst: string, dates: string[]): void => {
    if (!query.radiusKm) return;
    const levels = nearbyCalendarLevels(o, dst, dates, query.radiusKm, {
      ...filterOpts(),
      maxConnections: query.maxConnections,
    });
    for (const d of cal) {
      if (d.available) continue;
      const lvl = levels.get(d.date);
      if (lvl === 1) d.nearby = true;
      else if (lvl === 2) d.nearbyBoth = true;
    }
  };

  // The proposed return, in order of preference: a still-valid carried return day (a
  // Flexible pick, or a deep-linked rdate), else the one the stay implies (same day, or
  // departure + N nights — no second question for a fixed stay), else outbound + 2.
  const proposed =
    query.returnDate && query.returnDate >= query.date
      ? query.returnDate
      : query.stay
        ? returnForStay(query.stay, query.date)
        : proposedReturn(query.date);
  odReturnDate = proposed;

  if (returnMoved) {
    refs.results.append(el("p", { class: "notice", text: t("rt_return_moved") }));
    returnMoved = false;
  }
  refs.title.textContent = t("res_rt_title", {
    origin: registry.label(origin),
    destination: registry.label(destination),
    out: formatDate(query.date),
    ret: formatDate(proposed),
  });
  refs.results.append(el("p", { class: "od-guide" }, [render.guideEl(c, destination, "link")]));
  // A one-line conclusion of the whole round trip — nights away (or "same day") + total
  // travel time — kept in step with the chosen outbound/return by updateTripTotal() (assigned
  // once the outbound list exists; the return-list renderer calls it on every return change).
  const tripTotal = el("p", { class: "rt-total" });
  // "View ticket" — reopens the whole-trip modal (Book / Add to calendar) after it's been
  // dismissed, using the chosen (or default) outbound + return. Hidden until both legs resolve.
  const viewTicketBtn = el("button", {
    class: "btn btn-primary rt-view-ticket",
    type: "button",
    text: t("act_view_trip"),
    on: { click: () => openTripModalBest() },
  });
  refs.results.append(el("div", { class: "rt-conclusion" }, [tripTotal, viewTicketBtn]));
  let updateTripTotal: () => void = () => {};

  // --- 2-leg accordion (same behaviour + classes as the multi-city stepper) --------
  interface LegBox {
    section: HTMLElement;
    head: HTMLElement;
    name: string;
    num: HTMLElement;
    summary: HTMLElement;
    body: HTMLElement;
    collapsed: boolean;
    empty: boolean;
    chosen: Journey | null;
  }
  const boxes: LegBox[] = [];
  let chosenOutbound: Journey | null = null;

  const refreshSummary = (i: number): void => {
    const b = boxes[i];
    if (!b) return;
    clear(b.summary);
    if (b.chosen) b.summary.append(render.journeySummaryEl(b.chosen, c));
    const done = b.collapsed && Boolean(b.chosen);
    b.num.textContent = done ? "✓" : String(i + 1);
    b.num.classList.toggle("is-done", done);
    // Name each leg header distinctly (Aller vs Retour) instead of the generic
    // "expand/collapse" label, and fold in the ✓-done + chosen-train state so an AT
    // user hears which leg they are on and whether it is complete.
    const chosen = b.chosen;
    const pick = chosen ? `${chosen.legs[0]?.depart ?? ""} → ${chosen.legs[chosen.legs.length - 1]?.arrive ?? ""}` : "";
    b.head.setAttribute(
      "aria-label",
      done ? `${b.name} ✓ — ${pick}` : chosen ? `${b.name} — ${pick} — ${t("mc_toggle")}` : `${b.name} — ${t("mc_toggle")}`,
    );
  };
  const setCollapsed = (i: number, collapsed: boolean): void => {
    const b = boxes[i];
    if (!b || b.empty) return; // a seatless leg stays open — nothing to collapse to
    b.collapsed = collapsed;
    b.section.classList.toggle("mc-collapsed", collapsed);
    b.section.querySelector(".mc-result-head")?.setAttribute("aria-expanded", String(!collapsed));
    b.body.style.display = collapsed ? "none" : "";
    refreshSummary(i);
  };
  // "See all dates" in the ticket: both legs and both calendars open right here.
  const showAllDates = (): void => {
    setCollapsed(0, false);
    setCollapsed(1, false);
    outCalUI.setOpen(true);
    retCalUI.setOpen(true);
  };
  const openTripModal = (): void => {
    if (chosenOutbound && boxes[1]?.chosen) {
      showTripModal(chosenOutbound, c, { inbound: boxes[1].chosen, onShare: shareCurrentUrl, onMoreDates: showAllDates });
    }
  };
  // Reopen the ticket on demand ("View ticket"): use the chosen legs when set, else the
  // default outbound + the return for the current/proposed day — so it works even before the
  // user has explicitly tapped each leg.
  const openTripModalBest = (): void => {
    const out = chosenOutbound ?? outJourneys[0];
    const ret = boxes[1]?.chosen ?? returnJourneys(odReturnDate ?? proposed).list[0];
    if (out && ret) showTripModal(out, c, { inbound: ret, onShare: shareCurrentUrl, onMoreDates: showAllDates });
  };
  const pickReturn = (j: Journey): void => {
    if (boxes[1]) boxes[1].chosen = j;
    setCollapsed(1, true); // collapse the return leg to its ✓ summary…
    openTripModal(); // …and open the whole-trip ticket.
  };

  // Tapping the header of an OPEN, not-yet-chosen leg commits its pre-highlighted first
  // option (the default) and advances the flow — so an all-defaults trip is one tap per
  // leg. A completed (or empty) leg just toggles collapse as before.
  function onHeadClick(i: number): void {
    const b = boxes[i];
    if (!b) return;
    if (!b.collapsed && !b.chosen && !b.empty) {
      if (i === 0 && chosenOutbound) return pickOutbound(chosenOutbound);
      if (i === 1) {
        const def = returnJourneys(odReturnDate ?? proposed).list[0];
        if (def) return pickReturn(def);
      }
    }
    setCollapsed(i, !b.collapsed);
  }

  // Leg-head button: number/✓ + leg name + date chip + summary slot + chevron.
  const makeHead = (i: number, name: string, dateText: string) => {
    const num = el("span", { class: "mc-num", text: String(i + 1) });
    const summary = el("span", { class: "mc-pick-slot" });
    const head = el(
      "button",
      {
        class: "mc-result-head",
        type: "button",
        attrs: { "aria-expanded": "true", "aria-label": `${name} — ${t("mc_toggle")}` },
        on: { click: () => onHeadClick(i) },
      },
      [
        num,
        el("span", { class: "mc-route" }, [el("bdi", { text: name })]),
        el("span", { class: "mc-date muted", text: dateText }),
        summary,
        el("span", { class: "mc-chev", attrs: { "aria-hidden": "true" } }),
      ],
    );
    return { head, num, summary };
  };

  // ----- Leg 2 (Retour) content, built first so pickOutbound can (re)fill it -------
  const retList = el("div", { class: "return-list" });
  const body1 = el("div", { class: "mc-leg-body" });
  let fillReturns: () => void = () => {};

  // ONE return calendar (destination → origin) starting on the OUTBOUND day, so its FIRST
  // cell is same-day (the 0-night case) and each later cell adds a night. Day-vs-overnight
  // is then self-evident from the cell tapped — no separate mode.
  const retCalHost = el("div", { class: "ret-cal" });
  const retDates = dateRange(query.date, dayIndex(lastBookable) - dayIndex(query.date) + 1);
  const retCal = availabilityCalendar(trains, destination, origin, retDates, journeyOpts, accept);
  // availabilityCalendar only asks "does a return exist that day?", which for the same-day
  // cell would green a return leaving BEFORE the outbound arrives. Re-derive that first
  // cell from the day-trip feasibility (nights 0: home by midnight, after arrival) so no
  // impossible same-day pairing leaks, and carry its hours-on-site as the count.
  // The stay's own options (its minimum time on site included) with the route's hub budget.
  const stayOpts = { ...getawayOptsFor(query), ...connOpts };
  const sameDay = stayCalendar(trains, origin, destination, [query.date], stayOpts, "hours")[0];
  if (retCal[0]) {
    retCal[0].available = Boolean(sameDay?.available);
    retCal[0].count = sameDay?.count ?? 0; // hours on site (0 = badge hidden)
  }
  for (let i = 1; i < retCal.length; i++) retCal[i]!.count = i; // nights = days after the outbound
  gradeNearby(retCal, destination, origin, retDates);
  // Collapse-by-click for the return calendar, mirroring the outbound one: a FIXED stay
  // collapses it behind a one-tap "Retour : … · Changer" summary (the return is derived, so
  // re-showing the whole strip re-asks the date). FLEXIBLE keeps it OPEN — there the calendar
  // IS the return-length control, so the user must see it to pick the day.
  const retFlexible = query.stay === "flexible";
  const retCalUI = render.collapsibleCalendar(retCalHost, "od-return-cal");
  const updateRetToggle = (retDate: string): void => {
    retCalUI.setLabel(t("return_change", { date: formatDate(retDate) }));
  };
  // Results screen: EVERY calendar is collapsed by default — including the Flexible return
  // (only the initial form calendar opens by default). The return was already picked on the
  // form's départ→retour range; the "Retour : … · Changer" summary reveals it to adjust.
  body1.append(
    retCalUI.host,
    el("section", { class: "od-return" }, [el("h3", { text: t("rt_return_leg") }), retList]),
  );
  let selectReturn: (retDate: string) => void = () => {};
  const retCtx: RenderCtx = { ...c, onSelectDay: (d) => selectReturn(d) };
  // The return options for a chosen day: same-day (nights ≤ 0) keeps only trains leaving
  // AFTER the outbound arrives and home by midnight, latest first (most time on site);
  // a later day keeps every return, fastest first (`stayReturns`). Shared by the list render
  // and the header-advance (which picks the pre-highlighted first option).
  const returnJourneys = (retDate: string): { list: Journey[]; sameDay: boolean; arrAbs: number } => {
    const nights = dayIndex(retDate) - dayIndex(query.date);
    if (nights <= 0) {
      const arrAbs = chosenOutbound ? journeyArriveAbs(chosenOutbound) : 0;
      // A same-day return must leave AFTER you've had a real stretch in the city (not a
      // platform-to-platform bounce) and still get you home by midnight — the same
      // minimum the discovery list promises, so a listed day trip drills into one.
      const list = findJourneys(trains, destination, origin, query.date, journeyOpts)
        .filter(accept)
        .filter((j) => journeyArriveAbs(j) <= 24 * 60 && j.departMin >= arrAbs + sameDayMinOnSite)
        .sort((a, b) => b.departMin - a.departMin);
      return { list, sameDay: true, arrAbs };
    }
    return { list: stayReturns(query, origin, destination, retDate), sameDay: false, arrAbs: 0 };
  };
  const renderReturns = (retDate: string): void => {
    clear(retList);
    updateTripTotal(); // the return just changed — refresh the whole-trip conclusion line
    const nights = dayIndex(retDate) - dayIndex(query.date);
    const { list, sameDay: retSameDay, arrAbs } = returnJourneys(retDate);
    retList.append(
      el("p", { class: "muted ret-summary", text: retSameDay ? t("nights_sameday") : t("getaway_nights", { n: nights }) }),
    );
    if (list.length === 0) {
      retList.append(render.emptyEl(t("ret_none")));
      return;
    }
    list.forEach((j, idx) =>
      retList.append(
        render.journeyEl(j, c, {
          onPick: pickReturn,
          onArrow: pickReturn,
          selected: idx === 0,
          dateLabel: retSameDay ? t("daytrip_cal_hours", { dur: formatDuration(Math.max(0, j.departMin - arrAbs)) }) : undefined,
        }),
      ),
    );
  };
  // Render the return calendar + list for a day WITHOUT persisting anything. Used for the
  // initial auto-proposed paint, so a Share done before the user picks anything does NOT
  // emit the stale out+2 proposal into the URL.
  const paintReturn = (retDate: string): void => {
    // A keyboard/SR user pressed Enter on a return cell; rebuilding the strip destroys it,
    // so re-focus the equivalent (selected) cell afterwards rather than dropping focus to
    // <body>.
    const refocus = retCalHost.contains(document.activeElement);
    clear(retCalHost);
    retCalHost.append(
      render.calendarEl(retCal, retCtx, retDate, {
        title: t("rt_inbound"),
        // First cell is same-day (hours on site); every later cell is nights away.
        count: (n, day) => (day.date === query.date ? t("daytrip_cal_hours", { dur: formatDuration(n * 60) }) : t("getaway_nights", { n })),
        countLegend: t("cal_legend_return_stay"),
      }),
    );
    renderReturns(retDate);
    updateRetToggle(retDate); // keep the collapsed summary ("Retour : … · Changer") in step
    // Keep the page heading AND the return-leg date chip on the day actually shown — else,
    // after picking a different return, both keep advertising the originally-proposed date
    // while the conclusion line shows the new one, so the screen contradicts itself (rank 10).
    refs.title.textContent = t("res_rt_title", {
      origin: registry.label(origin),
      destination: registry.label(destination),
      out: formatDate(query.date),
      ret: formatDate(retDate),
    });
    const retChip = boxes[1]?.head.querySelector<HTMLElement>(".mc-date");
    if (retChip) retChip.textContent = formatDate(retDate);
    if (refocus) retCalHost.querySelector<HTMLElement>(".cal-cell.sel")?.focus();
  };
  selectReturn = (retDate: string): void => {
    // A real user pick (day-click): persist the ACTUAL chosen return so reload / Back /
    // Share carry it (replaceState) — the initial paint deliberately does not. In FLEXIBLE
    // mode the stay stays "flexible" (the return calendar is the length control), and the
    // stepper is seeded but inert; a FIXED stay settles onto the matching length (same day
    // or a fixed N-night stay, for any N) so the "How long?" control stays truthful.
    odReturnDate = retDate;
    // The chosen return train belonged to the OLD day — drop it so "View ticket" reopens the
    // trip with the new day's return (its pre-highlighted first option), not a train from a
    // day the return list no longer shows (rank 24).
    if (boxes[1]) boxes[1].chosen = null;
    const nights = Math.max(0, dayIndex(retDate) - dayIndex(query.date));
    if (retFlexible) {
      query = { ...query, returnDate: retDate, stay: "flexible" };
      formApi.setFlexible(nights);
    } else {
      query = { ...query, returnDate: retDate, stay: stayFromNights(nights) };
      // Repaint the stepper to the ACTUAL picked span (setStayNights, not setTripShape, so
      // a long pick shows the real fixed count).
      formApi.setStayNights(nights);
    }
    restamp();
    paintReturn(retDate);
    deferFormCalRepaint(); // the form's range, header and stay grading follow the new return
    // The return list updates IN PLACE right where the calendar is — no scroll jump (a
    // calendar tap must never jerk the drawer up). The paint already re-focuses the cell.
  };
  fillReturns = () => paintReturn(odReturnDate ?? proposed);

  // ----- Leg 1 (Aller): outbound list, with the possible-days calendar collapsed above --
  // Grade the outbound days by the SAME feasibility as the form + return leg: the chosen stay
  // length (getawayOptsFor — a fixed N-night stay or the Flexible window, not a blanket 3) AND
  // any via/hub budget (connOpts), so a green outbound day always has a bookable return the
  // return calendar agrees with — no green day that dead-ends on an empty return (#13/#15).
  // A SAME-DAY (day-trip) round trip must be graded by same-day feasibility (a there-and-back
  // that gets you home tonight), NOT the multi-night search — otherwise the outbound calendar
  // greens days that only have an overnight trip and labels them "N nights", so it lists days
  // with no same-day round trip at all. Use the hours metric for same-day, nights otherwise.
  const isSameDayTrip = query.stay != null && stayNights(query.stay) === 0;
  // The minimum time on site for a same-day round trip: the user's "Minimum time there"
  // choice (hours → minutes) when set, else the shared default. Gates the return list and
  // drops stranding outbounds below.
  const sameDayMinOnSite =
    query.stayMinHours && query.stayMinHours > 0 ? query.stayMinHours * 60 : SAME_DAY_MIN_ON_SITE_MIN;
  const outCal = stayCalendar(trains, origin, destination, windowDates, stayOpts, isSameDayTrip ? "hours" : "nights");
  gradeNearby(outCal, origin, destination, windowDates);
  // Linked calendars: picking a different outbound day re-anchors the trip and UPDATES the
  // return calendar to start from that day. A FIXED stay keeps its length — the return
  // moves to the new departure + N nights (no notice; that's the whole point of a fixed
  // stay). Flexible keeps a still-valid return day, else re-anchors to outbound + 2 with a
  // one-line notice rather than silently wiping it.
  const onOutboundDay = (d: string): void => {
    if (d === query.date) return;
    // Keep the current stay length when re-anchoring the outbound: a fixed stay reads it
    // from the stay choice; a Flexible N>3 pick reads it from the concrete return span so
    // the N-night gap shifts with the new departure rather than collapsing to the default.
    const fixedN = query.stay
      ? (stayNights(query.stay) ??
        (query.returnDate && query.returnDate >= query.date
          ? dayIndex(query.returnDate) - dayIndex(query.date)
          : null))
      : null;
    let ret: string;
    if (fixedN != null) {
      ret = returnAfterNights(d, fixedN); // keep the N-night stay, shifted to the new day
      returnMoved = false;
    } else {
      const keep = odReturnDate != null && odReturnDate >= d;
      returnMoved = !keep;
      ret = keep ? odReturnDate! : proposedReturn(d);
    }
    query = { ...query, date: d, returnDate: ret };
    refreshInPlace();
  };
  const outCalCtx: RenderCtx = { ...c, onSelectDay: onOutboundDay };
  const outCalEl = render.calendarEl(outCal, outCalCtx, query.date, {
    title: t("getaway_cal_title"),
    count: (n) => (isSameDayTrip ? t("daytrip_cal_hours", { dur: formatDuration(n * 60) }) : t("getaway_nights", { n })),
    countLegend: isSameDayTrip ? t("cal_legend_hours") : t("cal_legend_nights"),
  });
  // The departure is already chosen (the form set it), so the possible-days calendar is
  // COLLAPSED by default — it re-asking the date is what read as a duplicate. A one-tap
  // summary ("Départ : … · Changer") reveals it to switch days or scan availability
  // (David's refinement: the calendar stays, but hides once a date is picked).
  const outCalUI = render.collapsibleCalendar(outCalEl);
  outCalUI.setLabel(t("outbound_change", { date: formatDate(query.date) }));
  const outCalCollapse = outCalUI.host;

  // On a SAME-DAY round trip, drop outbound departures so late you'd be stranded — no
  // return can leave the required time-on-site later and still get you home by midnight.
  // Offering a train that dead-ends on an empty return leg is what read as broken. The
  // latest feasible same-day return sets the cutoff; an outbound survives only if it
  // arrives early enough to leave that gap before it.
  const latestSameDayReturnDepart = isSameDayTrip
    ? findJourneys(trains, destination, origin, query.date, journeyOpts)
        .filter(accept)
        .filter((j) => journeyArriveAbs(j) <= 24 * 60)
        .reduce((max, j) => Math.max(max, j.departMin), -Infinity)
    : Infinity;
  const outJourneys = findJourneys(trains, origin, destination, query.date, journeyOpts)
    .filter(accept)
    .filter((j) => !isSameDayTrip || journeyArriveAbs(j) + sameDayMinOnSite <= latestSameDayReturnDepart)
    .sort((a, b) => journeyArriveAbs(a) - journeyArriveAbs(b) || a.totalDurationMin - b.totalDurationMin);
  chosenOutbound = outJourneys[0] ?? null;

  // Conclusion line: "{n} nights · {total} round-trip travel" (or "same day · {onsite} on
  // site · …"), from the chosen outbound + the chosen/derived return. Empty if either leg
  // has no train that day.
  updateTripTotal = (): void => {
    const out = chosenOutbound ?? outJourneys[0];
    const retDate = odReturnDate ?? proposed;
    const ret = returnJourneys(retDate).list[0];
    // No bookable pairing (a leg has no train that day) → no conclusion, no "View ticket".
    viewTicketBtn.hidden = !out || !ret;
    if (!out || !ret) {
      tripTotal.textContent = "";
      return;
    }
    const nights = Math.max(0, dayIndex(retDate) - dayIndex(query.date));
    const total = out.totalDurationMin + ret.totalDurationMin;
    tripTotal.textContent =
      nights > 0
        ? t("trip_summary", { n: nights, dur: formatDuration(total) })
        : t("trip_summary_day", {
            onsite: formatDuration(Math.max(0, ret.departMin - (out.departMin + out.totalDurationMin))),
            dur: formatDuration(total),
          });
  };
  updateTripTotal();

  const body0 = el("div", { class: "mc-leg-body" }, [outCalCollapse]);
  const pickOutbound = (j: Journey): void => {
    chosenOutbound = j;
    if (boxes[0]) boxes[0].chosen = j;
    updateTripTotal(); // a new outbound may change the total travel time
    setCollapsed(0, true); // collapse the outbound leg to its ✓ summary…
    fillReturns(); // …rebuild the return options against this outbound…
    setCollapsed(1, false); // …open the return leg…
    // Focus the now-open return leg header: the just-picked outbound button lives inside
    // the collapsed (display:none) body, so leaving focus there drops it to <body> — a
    // keyboard/SR user would lose their place at exactly the hand-off between legs.
    boxes[1]?.head.focus({ preventScroll: true });
    // Gently reveal the return leg the FIRST time it opens — but only if it's below the
    // fold (never scroll UP; a pick must not jerk the drawer).
    revealElement(boxes[1]?.section ?? null);
  };
  // Step-wise Back inside this accordion: once the outbound is picked (leg 0 collapsed to
  // its ✓ summary, leg 1 open), Back re-opens leg 0 to change the outbound BEFORE leaving
  // the whole trip search. It consumes the Back only while there's a step to walk back to.
  activeStepBack = (): boolean => {
    if (boxes[0]?.collapsed && boxes[0].chosen && !boxes[0].empty) {
      setCollapsed(1, true); // fold the return leg back to its summary…
      setCollapsed(0, false); // …and re-open the outbound to change it
      boxes[0].head.focus({ preventScroll: true });
      return true;
    }
    return false;
  };
  // On a SAME-DAY trip the whole point is time on site, and an earlier departure buys more of
  // it — so annotate each outbound with the hours it leaves you (the latest return after it
  // arrives). On a multi-night trip the nights are the same for every outbound, so no per-row
  // label. An outbound with no same-day return home shows none (its day already gated by the
  // feasibility-graded calendar above).
  const sameDayTrip = (odReturnDate ?? proposed) === query.date;
  const sameDayReturns = sameDayTrip
    ? findJourneys(trains, destination, origin, query.date, journeyOpts)
        .filter(accept)
        .filter((j) => journeyArriveAbs(j) <= 24 * 60)
    : [];
  const outboundStayLabel = (j: Journey): string | undefined => {
    if (!sameDayTrip) return undefined;
    const arr = journeyArriveAbs(j);
    let latest = -1;
    for (const r of sameDayReturns) if (r.departMin >= arr && r.departMin > latest) latest = r.departMin;
    return latest < 0 ? undefined : t("daytrip_cal_hours", { dur: formatDuration(latest - arr) });
  };
  if (outJourneys.length === 0) {
    body0.append(render.emptyEl(t("res_none")), render.hintEl(t("res_none_hint")));
    // No same-day round trip that day: offer the shortest stay that has one.
    const n = isSameDayTrip
      ? [1, 2, 3].find((k) => bestGetawayTo(trains, origin, destination, query.date, { ...stayOpts, nights: k }))
      : undefined;
    if (n) body0.append(actionEl(t("try_nights", { n }), () => applyTripShape(stayFromNights(n))));
  } else {
    for (const j of outJourneys)
      body0.append(
        render.journeyEl(j, c, {
          selected: j === chosenOutbound,
          onPick: pickOutbound,
          onArrow: pickOutbound,
          dateLabel: outboundStayLabel(j),
        }),
      );
  }

  const outName = t("rt_outbound");
  const h0 = makeHead(0, outName, formatDate(query.date));
  const sec0 = el("section", { class: "mc-result" }, [h0.head, body0]);
  boxes[0] = { section: sec0, head: h0.head, name: outName, num: h0.num, summary: h0.summary, body: body0, collapsed: false, empty: outJourneys.length === 0, chosen: chosenOutbound };

  const retName = t("rt_return_leg");
  const h1 = makeHead(1, retName, formatDate(proposed));
  const sec1 = el("section", { class: "mc-result" }, [h1.head, body1]);
  boxes[1] = { section: sec1, head: h1.head, name: retName, num: h1.num, summary: h1.summary, body: body1, collapsed: false, empty: false, chosen: null };

  refs.results.append(sec0, sec1);

  // Hidden-city trains + radius alternatives sit BELOW both legs, so the two legs stay
  // adjacent and a back-only nearby trip doesn't read as "no return".
  appendHiddenTrains(c);
  const radiusAlt = query.radiusKm
    ? nearbyAlternatives(origin, destination, query.date, query.radiusKm, {
        ...filterOpts(),
        maxConnections: query.maxConnections,
      })
    : null;
  const nearbyIds = appendNearbyAlternatives(c, radiusAlt);

  // Populate the return leg for the proposed return, then start as a stepper: Leg 1 open
  // to pick, Leg 2 collapsed to its (pre-filled) summary. EXCEPTION — a FLEXIBLE round trip:
  // the return calendar inside Leg 2 IS the stay-length control, so Leg 2 starts OPEN,
  // otherwise the return dates sit at zero height inside the collapsed leg and can't be
  // tapped (they're only reachable after picking an outbound) — the "can't select the
  // return date in Flexible on mobile" bug.
  fillReturns();
  setCollapsed(1, !retFlexible);

  // The proposed return day has no free-MAX return: the collapsed "Retour : … · Changer"
  // summary would be a dead end (an empty list behind a closed calendar). Open the return
  // leg AND its calendar by default so the days that DO have a return are visible straight
  // away and one tap away — never a blank screen.
  if (returnJourneys(odReturnDate ?? proposed).list.length === 0) {
    setCollapsed(1, false);
    retCalUI.setOpen(true);
  }

  const stops = chosenOutbound ? [chosenOutbound.origin, ...chosenOutbound.hubs, chosenOutbound.destination] : [origin, destination];
  showRoute(stops);
  if (query.radiusKm) {
    showRadius(
      [
        { id: origin, km: query.radiusKm },
        { id: destination, km: query.radiusKm },
      ],
      nearbyIds,
    );
  }
}

/** A one-tap way forward under an empty list: a ghost button on its own centred row. */
function actionEl(text: string, onClick: () => void): HTMLElement {
  const button = el("button", { class: "btn btn-ghost", type: "button", text, on: { click: onClick } });
  return el("div", { class: "od-comeback" }, [button]);
}

/** The first day after the chosen one, else the first in the window, that `cal` marks
 *  bookable on the query's card. */
function nextAvailableDay(cal: CalendarDay[]): string | undefined {
  const open = cal.filter((d) => d.available && d.date !== query.date);
  return (open.find((d) => d.date > query.date) ?? open[0])?.date;
}

/** Move an empty list to `date`, a day its calendar marks green. */
function nextDayEl(date: string): HTMLElement {
  return actionEl(t("day_with_seats", { date: formatDate(date) }), () => {
    query = { ...query, date };
    refreshInPlace();
  });
}

/** Coarse pointer ≈ touch/phone. */
function showHint(input: HTMLInputElement): void {
  // Empty state: no nagging prompt — just a blank heading and a ready cursor.
  refs.title.textContent = "";
  // Nothing to plot yet: rest the map on the bare France basemap. (renderSearch no
  // longer does this unconditionally, to avoid a base→markers double-zoom.)
  showBaseMap();
  // On mobile the results view is a full-bleed map + drawer; with nothing to search
  // (a link like ?mode=from with no origin, or a cleared field) it would sit there
  // empty — a confusing "why am I here?" page. Send the phone back to the search form
  // instead, which is the real entry point.
  setMobileForm(true);
  offerFocus(input);
}

/** Put a ready cursor in the empty field while nothing holds focus (a navigation leaves it on
 *  the heading, where shortcuts work); never on a phone, where it pops the keyboard. */
function offerFocus(input: HTMLInputElement): void {
  if (!isTouch() && document.activeElement === document.body) input.focus({ preventScroll: true });
}

function goBack(): void {
  // Inside a multi-step flow, Back first walks the steps backwards (re-open the outbound
  // after picking it, etc.) — only once the flow is at its first step does Back leave it.
  if (activeStepBack?.()) return;
  // Otherwise the in-app Retour is exactly the browser Back: pop the history entry. The
  // popstate handler restores the underlying list + its form snapshot. One back-stack.
  if (currentDetail()) history.back();
}

/** Reset to the landing state (clicking the logo). Keeps language/theme/card. */
function goHome(): void {
  query = { mode: "from", date: today, card: settings.card, maxConnections: 1, hidden: true };
  syncFormFromQuery();
  applyAndRun();
  setMobileForm(true);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

/** Switch trip type (tab click or 1–4 shortcut), starting a fresh history. */
function switchTab(next: TripType): void {
  tripType = next;
  formApi.setActiveTab(tripType);
  formApi.updateFieldVisibility(tripType);
  query = readQueryFromForm();
  applyAndRun();
  repaintFormCalendar(); // show/hide + repaint the Trip-tab calendar for the new tab
}

/**
 * Switch the Multi-city sub-surface (plan a tour ↔ edit legs by hand). Re-lays the
 * form for the chosen surface and re-derives the query so the URL reflects it, but
 * — like a tab switch — doesn't fabricate results before the user has entered a trip.
 */
function switchMultiMode(mode: "plan" | "legs"): void {
  formApi.setMultiMode(mode);
  formApi.updateFieldVisibility("multi");
  query = readQueryFromForm();
  applyAndRun();
}

/**
 * Set the trip shape from the segmented control (a segment click via onTripShape, or
 * the "r" shortcut) and re-run in place — so the possible-days calendar auto-appears.
 */
function applyTripShape(shape: TripShape): void {
  formRangeAwait = false; // changing the shape ends any in-progress Flexible range pick
  formApi.setTripShape(shape); // repaint the control (a click already did; the shortcut hasn't)
  query = readQueryFromForm();
  // A trip-type / nights / Flexible change refines the view in place — replace the current
  // history entry rather than pushing a new one (no history pile-up on toggling).
  applyAndRun(false);
  repaintFormCalendar(); // the shape now means one-way vs round vs same-day → recolour the days
}

/** The "r" shortcut toggles the trip type — Aller simple ↔ Aller-retour — keeping the
 *  current nights count. It never lands on Flexible (that's a deliberate choice from the
 *  nights control), so it toggles to a plain fixed-nights round trip. */
function cycleTripShape(): void {
  formRangeAwait = false; // 'r' leaves Flexible → end any in-progress range pick
  formApi.toggleRound(); // flip one-way ↔ round trip in place, keeping the nights count
  query = readQueryFromForm();
  applyAndRun(false); // in-place refinement — replace, don't pile up history
  repaintFormCalendar(); // the shape now means one-way vs round → recolour the days
}

/** The departure or arrival field the active surface reads whose text names no station. */
function unknownStationField(): HTMLInputElement | undefined {
  const fields =
    tripType === "simple" || (tripType === "multi" && formApi.getMultiMode() === "plan")
      ? [refs.origin, refs.destination]
      : tripType === "ideas"
        ? [refs.origin]
        : [];
  return fields.find((f) => f.value.trim() !== "" && !resolveStation(f.value));
}

/** Run a fresh search from the current form (submit or "g" shortcut). */
function runFromForm(): void {
  // A name that matches no station, or several, stops here in red: searching without it
  // would run a different search than the one typed.
  const unknown = unknownStationField();
  if (unknown) {
    unknown.classList.add("is-invalid");
    setSurpriseMsg(t("err_station", { station: unknown.value.trim() }));
    return;
  }
  // A Multi-city station nobody could resolve would silently drop its leg or city:
  // stop on it and say so instead.
  const unknownLeg = tripType === "multi" ? formApi.invalidStation() : undefined;
  if (unknownLeg) {
    setSurpriseMsg(t("mc_unknown_station"));
    unknownLeg.focus();
    return;
  }
  const next = readQueryFromForm();
  // Nothing to search yet: name the missing step under Search, and leave the page and the
  // history as they are rather than committing an empty search.
  if (!queryIsRenderable(next)) {
    const legs = tripType === "multi" && formApi.getMultiMode() === "legs";
    setSurpriseMsg(t(legs ? "multi_hint" : "need_origin"));
    return;
  }
  setSurpriseMsg("");
  query = next;
  applyAndRun();
  setMobileForm(false);
}

/** Shift the chosen date by `delta` days, clamped to the bookable window. */
function shiftDay(delta: number): void {
  const last = addDays(today, BOOKING_WINDOW_DAYS - 1);
  const d = addDays(query.date, delta);
  if (d < today || d > last) return;
  query = { ...query, date: d };
  refreshInPlace();
}

/** Open the Settings dialog (performance / display options); each toggle applies live. */
function openSettings(): void {
  showSettingsModal({
    reduceMotion: settings.reduceMotion,
    map: settings.map,
    compact: settings.density === "compact",
    onReduceMotion: (v) => {
      settings = { ...settings, reduceMotion: v };
      store.saveSettings(settings);
      applyReduceMotion(v);
    },
    onMap: (v) => {
      settings = { ...settings, map: v };
      store.saveSettings(settings);
      applyMap(v);
      // Turning the map ON needs the current view redrawn onto it; OFF just hides it
      // (and ensureMap now short-circuits, so nothing loads Leaflet).
      if (v) runSearch();
    },
    onCompact: (v) => {
      const density = v ? "compact" : "comfortable";
      settings = { ...settings, density };
      store.saveSettings(settings);
      applyDensity(density);
    },
    // Master "Low-end mode": flip all three savers together. ON = the light experience
    // (no motion, no map, compact); OFF = the full experience (motion, map, comfortable).
    onLowEnd: (v) => {
      const density = v ? "compact" : "comfortable";
      settings = { ...settings, reduceMotion: v, map: !v, density };
      store.saveSettings(settings);
      applyReduceMotion(v);
      applyMap(!v);
      applyDensity(density);
      // Turning the map back on needs the current view redrawn onto it.
      if (!v) runSearch();
    },
  });
}

/** A modal listing the keyboard shortcuts (the "?" key or header button). */
function showShortcutsHelp(): void {
  showInfoModal(t("keys_title"), [
    t("keys_modes"),
    t("keys_roundtrip"),
    t("keys_focus"),
    t("keys_day"),
    t("keys_surprise"),
    t("keys_nearest"),
    t("keys_clear"),
    t("keys_run"),
    t("keys_back"),
    t("keys_help"),
  ]);
}


/**
 * Global keyboard shortcuts. Order matters: Escape first (also closes the help
 * dialog natively), then bail on modifiers / while typing / under an open dialog.
 */
function onGlobalKey(e: KeyboardEvent): void {
  if (e.key === "Escape") {
    // A modal <dialog> closes itself on Escape — bail before any page shortcut so
    // we neither navigate the page behind it nor preventDefault its native close.
    if (document.querySelector("dialog[open]")) return;
    // Cancel a search that's still loading (stop the spinner) before anything else.
    if (cancelLoading()) {
      e.preventDefault();
      return;
    }
    const tgt = e.target as HTMLElement | null;
    // Escape the search bar first: blur whatever field is focused.
    if (tgt && /^(INPUT|SELECT|TEXTAREA)$/.test(tgt.tagName)) {
      tgt.blur();
      e.preventDefault();
      return;
    }
    if (activeStepBack || currentDetail()) {
      e.preventDefault();
      goBack(); // steps backward inside a flow first, then exits it
    }
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return; // leave browser/OS combos alone
  const tgt = e.target as HTMLElement | null;
  if (tgt && (/^(INPUT|SELECT|TEXTAREA)$/.test(tgt.tagName) || tgt.isContentEditable)) return;
  if (document.querySelector("dialog[open]")) return; // not while a modal is up

  if (/^[1-3]$/.test(e.key)) {
    e.preventDefault();
    switchTab(TRIP_TABS[Number(e.key) - 1]!);
  } else if (e.key === "r" && tripType === "simple") {
    e.preventDefault();
    cycleTripShape(); // One-way ↔ Round trip on the Trip tab (Ideas is always one-way)
  } else if (e.key === "/") {
    e.preventDefault();
    const f = deriveMode() === "to" ? refs.destination : refs.origin;
    f.focus();
    f.select();
  } else if (e.key === "[") {
    e.preventDefault();
    shiftDay(-1);
  } else if (e.key === "]") {
    e.preventDefault();
    shiftDay(1);
  } else if (e.key === "s") {
    e.preventDefault();
    surpriseMe();
  } else if (e.key === "n" && tripType === "multi" && formApi.getMultiMode() === "plan") {
    e.preventDefault();
    addNearestCity(); // tour-plan only: grow the trip to the nearest reachable stop
  } else if (e.key === "c" && tripType === "multi" && formApi.getMultiMode() === "plan") {
    e.preventDefault();
    clearTourCities(); // tour-plan only: clear every "city to visit" at once
  } else if (e.key === "g") {
    e.preventDefault();
    runFromForm();
  } else if (e.key === "?") {
    e.preventDefault();
    showShortcutsHelp();
  }
}

/**
 * "Surprise me": stay on the current page and randomize that mode's own city —
 * a random city added to "Tour", a random arrival in "D'où venir", a random
 * reachable destination (keeping the origin) in "Trajet précis", and a random
 * departure elsewhere. Purely random, never a city that's already selected.
 */
function surpriseMe(): void {
  // Snapshot the live form first: "Surprise me" builds on top of the current query
  // and then re-syncs the form from it, so it must start from what's ACTUALLY in the
  // form (a cleared destination, a toggled filter) — not the stale last-searched
  // query, which would resurrect edits the user just made (e.g. a removed city).
  query = readQueryFromForm();
  const avail = deps.trains.filter((tr) => tr.available);
  const pickFrom = (xs: string[], not?: string): string | undefined => {
    const pool = not ? xs.filter((x) => x !== not) : xs;
    return pool.length ? pool[Math.floor(Math.random() * pool.length)] : undefined;
  };
  const origins = (): string[] => [...new Set(avail.map((t) => t.origin))];
  const destinations = (): string[] => [...new Set(avail.map((t) => t.destination))];
  // When a region is selected (best / tour modes), the surprise departure must
  // sit inside it — "I want to start my trip in Bretagne".
  const inRegion = (id: string): boolean =>
    !query.region || deps.registry.get(id)?.region === query.region;
  const regionOrigins = (): string[] => origins().filter(inRegion);

  setSurpriseMsg(""); // clear any prior "nothing to add" notice

  if (query.mode === "tour") {
    // Custom legs: fill (or extend) the itinerary with a random reachable next stop.
    if (formApi.getMultiMode() === "legs") return surpriseLeg();
    // Tour: fill the departure if empty, then add cities (the "Cities to add" count,
    // default 1) — each a random hop that keeps the WHOLE tour feasible. So "find me
    // 5 cities" is one click with the count set to 5.
    growTour("random", tourAddCount());
    return;
  } else if (query.mode === "to") {
    const dest = pickFrom(destinations(), query.destination);
    if (!dest) return;
    query = { ...query, destination: dest };
  } else if (query.mode === "od") {
    // Trajet précis: the random pick must have a direct MAX train on the SELECTED
    // date (passing the active filters), so the result is never empty for that day.
    const sameDay = filterTrains(deps.trains, {
      ...filterOpts(),
      date: query.date,
      ...(query.origin ? { origin: query.origin } : {}),
    });
    if (query.origin) {
      // Keep the origin; randomize only the destination.
      const dest = pickFrom([...new Set(sameDay.map((t) => t.destination))], query.destination);
      if (!dest) return;
      query = { ...query, destination: dest };
    } else {
      // No departure station: random for both — a real origin → destination pair
      // that runs that day.
      const pairs = [...new Map(sameDay.map((t) => [`${t.origin}->${t.destination}`, t])).values()];
      const p = pairs.length ? pairs[Math.floor(Math.random() * pairs.length)] : undefined;
      if (!p) return;
      query = { ...query, origin: p.origin, destination: p.destination };
    }
  } else {
    // from / best: a random departure city, staying in the same mode. In "best"
    // a chosen region constrains it to a departure inside that region.
    const pool = query.mode === "best" ? regionOrigins() : origins();
    const origin = pickFrom(pool, query.origin);
    if (!origin) {
      if (query.mode === "best" && query.region) setSurpriseMsg(t("surprise_none"));
      return;
    }
    query = { ...query, origin };
  }
  syncFormFromQuery();
  applyAndRun();
  setMobileForm(false);
}

/**
 * "Surprise me" inside the custom-legs editor: fill the first leg missing its
 * destination — or, if every leg is complete, append one more hop — with a random
 * place that has a direct free-MAX train from that leg's start, never a city already
 * on the itinerary. The train must leave after the previous leg's default train
 * arrives, on the first day from then that has one. Populates the form (staged);
 * the user still hits Search, like every other legs edit.
 */
function surpriseLeg(): void {
  const raw = formApi.getLegValues(); // [{ from, to, date }] as label strings
  if (raw.length === 0) return;
  const resolved = raw.map((l) => ({
    from: resolveStation(l.from),
    to: resolveStation(l.to),
    date: l.date || query.date,
  }));
  // Never repeat a stop already on the itinerary.
  const visited = new Set<string>();
  for (const l of resolved) {
    if (l.from) visited.add(l.from);
    if (l.to) visited.add(l.to);
  }
  const legs = raw.map((l) => ({ ...l }));
  let target = resolved.findIndex((l) => !l.to);
  if (target < 0) {
    target = legs.length;
    legs.push({ from: "", to: "", date: "" });
  }
  // Where the traveller stands before this hop: each earlier leg's default train,
  // chained the way the results list them (runMultiCity).
  let prev: Journey | null = null;
  for (const l of resolved.slice(0, target)) {
    if (l.from && l.to) prev = catchableAfter(legJourneys({ from: l.from, to: l.to, date: l.date }), prev)[0] ?? null;
  }
  // The hop starts where it was typed, else where the previous leg ends; an empty
  // editor starts from a random station, so Surprise can build a whole trip.
  let originId = resolved[target]?.from ?? resolved[target - 1]?.to;
  if (!originId) {
    const origins = [...new Set(deps.trains.filter((tr) => tr.available).map((tr) => tr.origin))];
    originId = origins[Math.floor(Math.random() * origins.length)];
  }
  if (!originId) {
    setSurpriseMsg(t("surprise_none"));
    return;
  }
  const after = prev ? arrivalDate(prev) : (resolved[target - 1]?.date ?? query.date);
  const typed = raw[target]?.date ?? "";
  const fromHere = filterTrains(deps.trains, { ...filterOpts(), origin: originId });
  const lastDay = addDays(today, BOOKING_WINDOW_DAYS - 1);
  for (let d = typed > after ? typed : after; d <= lastDay; d = addDays(d, 1)) {
    const catchable = catchableAfter(fromHere.filter((tr) => tr.date === d), prev);
    const pool = [...new Set(catchable.map((tr) => tr.destination))].filter((id) => !visited.has(id) && id !== originId);
    if (pool.length === 0) continue;
    const pick = pool[Math.floor(Math.random() * pool.length)]!;
    setSurpriseMsg("");
    legs[target] = { from: deps.registry.label(originId), to: deps.registry.label(pick), date: d };
    formApi.setLegs(legs);
    return;
  }
  setSurpriseMsg(t("surprise_none"));
}

function ensureMap(): Promise<RouteMap> {
  // Map turned off (Settings → low-end mode): never import Leaflet or fetch tiles.
  // Every show* helper catches this, so the whole map layer is skipped — the single
  // biggest saving on weak devices and slow connections.
  if (!settings.map) return Promise.reject(new Error("map disabled"));
  if (!mapPromise) {
    const host = refs.mapEl;
    mapPromise = import("./ui/map").then(
      ({ RouteMap: MapCtor }) => {
        const m = new MapCtor(host, deps.registry);
        m.onSelect = selectStation;
        m.onHover = onMarkerHover;
        mapInstance = m;
        return m;
      },
      (err: unknown) => {
        mapPromise = null;
        throw err;
      },
    );
  }
  return mapPromise;
}

/**
 * Run an action against the (lazily-imported) map, then repaint it once — the shared
 * body of every show* helper. If the map is disabled (low-end mode) ensureMap rejects
 * and the action is silently skipped, so callers never branch on it.
 */
function withMap(fn: (m: RouteMap) => void): void {
  ensureMap()
    .then((m) => {
      fn(m);
      requestAnimationFrame(() => m.invalidate());
    })
    .catch(() => {});
}

/**
 * Build the per-pin MarkerInfo for a discovery map so the reachability heat-map lights up:
 * each destination pin (and its spoke) is tinted by how many changes it takes — direct
 * (green), one change (amber), two (red) — instead of every pin reading the same flat green.
 */
function reachInfo(items: { station: string; connections: number }[]): Map<string, MarkerInfo> {
  const m = new Map<string, MarkerInfo>();
  for (const it of items) m.set(it.station, { title: deps.registry.label(it.station), connections: it.connections });
  return m;
}

function showMap(hub: string, others: string[], info?: Map<string, MarkerInfo>): void {
  withMap((m) => {
    m.setInfo(info ?? new Map());
    m.show(hub, [...new Set(others)]);
  });
}

function showRoute(stations: string[]): void {
  withMap((m) => m.route(stations));
}

/** Reset the map to the bare France basemap (no markers) — the pre-search state. */
function showBaseMap(): void {
  withMap((m) => m.base());
}

/** Overlay radius circles + nearby-station markers on the current route map. */
function showRadius(centers: { id: string; km: number }[], nearby: string[]): void {
  withMap((m) => m.radius(centers, nearby));
}

/** Open the destination matching a clicked map marker — navigates to its calendar. */
function selectStation(id: string): void {
  const sel = `[data-station="${id.replace(/["\\]/g, "\\$&")}"]`;
  const card = refs.results.querySelector<HTMLElement>(sel);
  if (!card) return;
  const open = card.querySelector<HTMLElement>(".dest-main");
  if (open) {
    open.click();
    return;
  }
  const panel = card.querySelector<HTMLElement>(".dest-panel");
  if (panel?.hasAttribute("hidden")) panel.removeAttribute("hidden");
  markSelected(id);
  card.scrollIntoView({ behavior: "smooth", block: "center" });
  card.classList.add("flash");
  window.setTimeout(() => card.classList.remove("flash"), 1100);
}

/**
 * Persistently highlight a destination — its results card and its map pin — and
 * clear the previous selection, so it stays clear which place is being looked at.
 */
function markSelected(id: string): void {
  for (const prev of refs.results.querySelectorAll(".is-selected")) prev.classList.remove("is-selected");
  const sel = `[data-station="${id.replace(/["\\]/g, "\\$&")}"]`;
  refs.results.querySelector<HTMLElement>(sel)?.classList.add("is-selected");
  mapInstance?.highlight(id);
}

function onMarkerHover(id: string | null): void {
  for (const c of refs.results.querySelectorAll(".is-hover")) c.classList.remove("is-hover");
  if (!id) return;
  const sel = `[data-station="${id.replace(/["\\]/g, "\\$&")}"]`;
  const card = refs.results.querySelector<HTMLElement>(sel);
  if (!card) return;
  card.classList.add("is-hover");
  card.scrollIntoView({ block: "nearest" });
}

// --- watched routes ---------------------------------------------------------

function checkWatchedRoutes(): void {
  const watched = store.loadWatched();
  if (watched.length === 0) return;
  for (const r of watched) {
    const has = deps.trains.some(
      (tr) => tr.available && tr.origin === r.origin && tr.destination === r.destination,
    );
    if (has) {
      notify(
        t("appName"),
        `${deps.registry.label(r.origin)} → ${deps.registry.label(r.destination)} : MAX dispo`,
      );
    }
  }
}

// --- layout -----------------------------------------------------------------

/** The footer's "data updated …" line, localized (or the sample-data notice). */
function footerUpdatedText(): string {
  const meta = deps.meta;
  const when = meta.updatedAt
    ? new Date(meta.updatedAt).toLocaleString(getLang(), {
        dateStyle: "medium",
        timeStyle: "short",
        hourCycle: "h23",
      })
    : "";
  return when
    ? t("foot_updated", { date: when }) + (meta.isSample ? ` (${t("foot_sample")})` : "")
    : t("foot_sample");
}

function buildLayout(root: HTMLElement): void {
  // A rebuild (e.g. language change) discards the old form, whose date-picker
  // popovers live in <body> outside `root` — tear them down so they don't pile up.
  formApi?.destroy();
  clear(root);

  formApi = createForm({
    stationLabels: deps.registry.list().map((s) => s.label),
    regions: [...new Set(deps.registry.all().map((s) => s.region).filter((r): r is string => Boolean(r)))].sort(),
    today,
    bookingWindowDays: BOOKING_WINDOW_DAYS,
    maxTourFill: MAX_TOUR_FILL,
    overnightMaxConnectionMin: OVERNIGHT_MAX_CONNECTION_MIN,
    jeuneUrl: MAX_JEUNE_URL,
    seniorUrl: MAX_SENIOR_URL,
    interrailUrl: INTERRAIL_FRANCE_URL,
    interrailPassUrl: INTERRAIL_PASS_URL,
    ecoUrl: ADEME_CO2_URL,
    resolveStation,
    stationLabel: (id) => deps.registry.label(id),
    mode: () => query.mode,
    formatDate,
    formatWeekday,
    availabilityFor: (o, d, dates, opts) => {
      const map = new Map<string, number>();
      let cal: { date: string; available: boolean; count: number }[] | null = null;
      if (o && d) {
        cal = availabilityCalendar(deps.trains, o, d, dates, opts);
      } else if (o) {
        // Origin-only: count destinations reachable INCLUDING connections, so the
        // date-pill hint agrees with the live calendar and the results list (both
        // connection-aware) instead of the old direct-only undercount.
        cal = reachableCountCalendar(deps.trains, o, dates, opts, "from");
      }
      if (cal) for (const c of cal) map.set(c.date, c.available ? c.count : 0);
      return map;
    },
    onSwitchTab: switchTab,
    onMultiMode: switchMultiMode,
    onTripShape: applyTripShape,
    onSubmit: runFromForm,
    onSurprise: surpriseMe,
    onNearest: addNearestCity,
  });
  const built = formApi;
  const shell = buildShell({
    theme: settings.theme,
    card: settings.card,
    updatedText: footerUpdatedText(),
    form: built.form,
    githubUrl: GITHUB_URL,
    issuesUrl: GITHUB_ISSUES_URL,
    goHome,
    onLang: (code) => {
      settings = { ...settings, lang: isLang(code) ? code : "fr" };
      setLang(settings.lang);
      store.saveSettings(settings);
      rebuild();
    },
    onThemeChange: (theme) => {
      settings = { ...settings, theme };
      store.saveSettings(settings);
    },
    onCard: (card) => {
      settings = { ...settings, card };
      store.saveSettings(settings);
      query = { ...query, card };
      store.updateUrl(query);
      if (!switchPass(card, () => runSearch())) runSearch();
    },
    onShare: (onCopied) => void shareCurrentUrl(onCopied),
    onInstall: () => void promptInstall(),
    onShortcuts: showShortcutsHelp,
    onSettings: openSettings,
    onSaved: () => {
      closeHeaderMenu();
      openSavedPage();
      setMobileForm(false);
    },
    onOpenMobileForm: () => setMobileForm(true),
    onSelect: (id) => markSelected(id),
    onPeek: (id) => mapInstance?.peek(id),
  });

  root.append(shell.header, shell.layout);
  root.dataset.mform = "form";

  refs = {
    ...built.refs,
    title: shell.title,
    results: shell.results,
    mapEl: shell.mapEl,
    favList: shell.favList,
    tripList: shell.tripList,
    card: shell.cardSelect,
  };
  // Keep the reactive home-form calendar in step as the route is typed (staged — this
  // never runs a search, only repaints the "which days are possible" grid). Debounced on
  // input, immediate on a committed value (a datalist pick / blur).
  // A committed pick (datalist tap / blur / Enter) fires `change`. DEFER the repaint one
  // frame so the field + chip update paint first: the origin-only "possible days" grid runs
  // a full getaway sweep that can take ~1s cold for a hub like Paris, and running it inline
  // froze the tap so the picked station only appeared a second later. Deferring lets the
  // selection apply instantly; the calendar (which stays visible until then — the repaint
  // clears and rebuilds in one go) fills a beat afterwards.
  for (const inp of [refs.origin, refs.destination]) {
    inp.addEventListener("input", scheduleFormCalRepaint);
    inp.addEventListener("change", deferFormCalRepaint);
  }
  // Everything the search is derived from BEYOND the route: "Max correspondances", the via
  // hub, the departure/arrival window, the duration cap, the trip span, the train type, the
  // night-train rules, overnight stopovers, the search radius and the same-day minimum time
  // on site. Each is one deliberate choice, so each applies live (applyFilterChange) —
  // repainting the form calendar and refreshing the results showing that route. Before this
  // they did neither: raising "Max correspondances" left the previous, now-wrong month
  // sitting right above the control, greyed on days it had just opened up.
  for (const ctl of [
    refs.maxConnections,
    refs.trainType,
    refs.stayMin,
    refs.departAfter,
    refs.departBefore,
    refs.arriveBefore,
    refs.night,
    refs.onlyNight,
    refs.overnight,
    refs.hidden,
    refs.region,
  ]) {
    ctl.addEventListener("change", applyFilterChange);
  }
  // Typed filters settle keystroke by keystroke — debounce the calendar like the route
  // fields, and apply in full on the committed value (a via pick from the datalist, a blur).
  for (const inp of [refs.via, refs.maxDuration, refs.maxSpanDays, refs.radius]) {
    inp.addEventListener("input", scheduleFormCalRepaint);
    inp.addEventListener("change", applyFilterChange);
  }
  mapPromise = null;
  mapInstance = null;
  renderFavorites();
  renderSavedTrips();
}

// Distance from the document top to the results/map row (navbar + form + margins).
// Published as a CSS var so the map-first canvas can fill the viewport below the
// bars instead of a flat 100vh that overflows under them.
let lastAboveH = -1;
function updateRailMetrics(): void {
  const layoutEl = rootRef.querySelector<HTMLElement>(".layout");
  if (!layoutEl) return;
  const top = Math.round(layoutEl.getBoundingClientRect().top + window.scrollY);
  if (top === lastAboveH) return;
  lastAboveH = top;
  rootRef.style.setProperty("--above-h", `${top}px`);
  requestAnimationFrame(() => mapInstance?.invalidate());
}

/**
 * Whether a query has enough to render REAL results (vs a hint / armed prompt). Used to
 * decide the mobile screen: an incomplete query must stay on the FORM, never drop the
 * phone onto a blank results view. (store.urlHasQuery() can't be used for this — it is
 * always true because the URL always carries `mode`.)
 */
function queryIsRenderable(q: SearchQuery): boolean {
  switch (q.mode) {
    case "od":
      return Boolean(q.origin && q.destination);
    case "to":
      return Boolean(q.destination);
    case "tour":
      return Boolean((q.legs && q.legs.length > 0) || q.origin || (q.cities && q.cities.length));
    default: // "from" / "best" — and round/day-trip discovery — need an origin
      return Boolean(q.origin);
  }
}

function setMobileForm(open: boolean): void {
  if (!rootRef) return;
  const apply = (): void => {
    rootRef.dataset.mform = open ? "form" : "results";
    if (open) {
      repaintFormCalendar(); // the sheet is (re)opening — make sure its calendar is current
    } else {
      updateSearchBar();
      updateRailMetrics();
      requestAnimationFrame(() => mapInstance?.invalidate());
    }
  };
  const mq = (q: string): boolean => typeof matchMedia === "function" && matchMedia(q).matches;
  const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
  // Morph the collapsed search bar into the full form (and back) on phones, via a
  // shared view-transition-name; instant when the screen stays the same or it isn't supported.
  if (
    rootRef.dataset.mform !== (open ? "form" : "results") &&
    mq("(max-width: 860px)") &&
    !mq("(prefers-reduced-motion: reduce)") &&
    !settings.reduceMotion &&
    typeof doc.startViewTransition === "function"
  ) {
    doc.startViewTransition(apply);
  } else {
    apply();
  }
}

function updateSearchBar(): void {
  const bar = rootRef?.querySelector<HTMLElement>(".msearch-text");
  if (bar) bar.textContent = refs.title?.textContent || t("appName");
}


/**
 * Prefill the search form with a saved route (origin + destination, exact-trip
 * mode) without running it — so clicking a favorite sets up the start rather than
 * jumping straight to a result. The user reviews and presses Search.
 */
function fillRoute(origin: string, destination: string): void {
  // Clear any stale "via" so a saved route isn't filtered through an unrelated hub.
  query = { ...query, mode: "od", origin, destination, via: undefined };
  syncFormFromQuery();
  // Re-read the Trip tab's form, which drops what only another tab carries (tour cities, legs).
  query = readQueryFromForm();
  restamp(); // keep the URL and the entry's form in step with the prefilled route
  // Favorites live in the results drawer, but the form they prefill is a different
  // screen on mobile (display:none in results view). Bring the form sheet forward so
  // the prefilled route is actually visible — otherwise tapping a favorite did
  // nothing on a phone (the "come back" bug).
  setMobileForm(true);
  if (!isTouch()) refs.origin.focus({ preventScroll: true }); // no dropdown pop on phones
  refs.modeTabs.scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderFavorites(): void {
  clear(refs.favList);
  const favs = store.loadFavorites();
  // Hide the whole card while empty so it doesn't take prime space in the rail
  // (and so the map sits directly under the results on mobile).
  refs.favList.parentElement?.toggleAttribute("hidden", favs.length === 0);
  if (favs.length === 0) return;
  for (const f of favs) {
    const row = el("div", { class: "fav-row" }, [
      el("button", {
        class: "fav-open",
        type: "button",
        text: `${deps.registry.label(f.origin)} → ${deps.registry.label(f.destination)}`,
        on: { click: () => fillRoute(f.origin, f.destination) },
      }),
      el("button", {
        class: "iconbtn",
        type: "button",
        text: "✕",
        title: t("act_fav_remove"),
        on: {
          click: () => {
            store.toggleFavorite(f);
            renderFavorites();
          },
        },
      }),
    ]);
    refs.favList.append(row);
  }
}

// The rail (sidebar) only shows the few most recent saved trips; the rest live
// on the dedicated "Saved trips" page reached via the "See all" link.
const SAVED_RAIL_LIMIT = 3;

/**
 * Route label, date label, and an "open" action for a saved trip, shared by the
 * rail and the dedicated saved-trips page. A tour chains every stop; a round
 * trip uses ⇄ and a date range; a one-way is a single arrow + date.
 */
function savedTripInfo(trip: store.SavedTrip): { label: string; when: string; open: () => void } {
  const out = trip.outbound;
  const inb = trip.inbound;
  const tour = trip.tour;
  if (tour) {
    const stops = [tour.legs[0]?.origin ?? out.origin, ...tour.legs.map((l) => l.destination)];
    const last = tour.legs[tour.legs.length - 1];
    return {
      label: stops.map((s) => deps.registry.label(s)).join(" → "),
      when: last ? `${formatDate(out.date)} – ${formatDate(last.date)}` : formatDate(out.date),
      open: () => showTourModal(tour, ctx()),
    };
  }
  return {
    label: `${deps.registry.label(out.origin)} ${inb ? "⇄" : "→"} ${deps.registry.label(out.destination)}`,
    when: inb ? `${formatDate(out.date)} – ${formatDate(inb.date)}` : formatDate(out.date),
    open: () =>
      showTripModal(out, ctx(), {
        inbound: inb,
        onShare: shareCurrentUrl,
        onMoreDates: () => ctx().onOpenRoute(out.origin, out.destination),
      }),
  };
}

/**
 * Render the "Saved trips" rail card from localStorage (newest first), capped at
 * the last few. When more exist (or any do), a "See all (N)" link opens the
 * dedicated saved-trips page.
 */
function renderSavedTrips(): void {
  clear(refs.tripList);
  const trips = store.loadTrips();
  // Hide the whole card while empty so it doesn't take prime space in the rail.
  refs.tripList.parentElement?.toggleAttribute("hidden", trips.length === 0);
  if (trips.length === 0) return;
  for (const trip of trips.slice(0, SAVED_RAIL_LIMIT)) {
    const info = savedTripInfo(trip);
    const row = el("div", { class: "fav-row trip-row" }, [
      el(
        "button",
        {
          class: "fav-open trip-open",
          type: "button",
          on: { click: info.open },
        },
        [
          el("span", { class: "trip-open-route", text: info.label }),
          el("span", { class: "muted small", text: info.when }),
        ],
      ),
      el("button", {
        class: "iconbtn",
        type: "button",
        text: "✕",
        title: t("act_unsave"),
        on: {
          click: () => {
            store.removeTrip(trip.id);
            renderSavedTrips();
          },
        },
      }),
    ]);
    refs.tripList.append(row);
  }
  // Always offer the dedicated page (it holds the full history + remove controls).
  refs.tripList.append(
    el("button", {
      class: "saved-see-all",
      type: "button",
      text: t("saved_see_all", { n: trips.length }),
      on: { click: openSavedPage },
    }),
  );
}

/** Open the dedicated saved-trips page (full list), remembering where we were. */
function openSavedPage(): void {
  // Push a detail entry flagged `saved`, carrying the form snapshot: Back returns to the
  // search under it with the form intact, and renderSearch shows this page on Forward.
  leaveEntry();
  store.pushUrl(query, { form: readQueryFromForm(), detail: true, saved: true });
  cancelLoading(); // a search still in flight must not paint over the page
  // renderSearch enters the full-page detail layout (like drilling into a route) so this
  // isn't crammed into the 30vh bottom sheet with the map behind it on mobile.
  renderSearch();
  refs.title.focus({ preventScroll: true });
  refs.title.scrollIntoView({ behavior: "smooth", block: "start" });
}

/** Full saved-trips list: back button, count, then a card per trip with remove. */
function renderSavedPage(): void {
  clear(refs.results);
  refs.title.textContent = t("saved_title");
  refs.results.append(
    el("button", { class: "back-btn", type: "button", text: `← ${t("act_back")}`, on: { click: goBack } }),
  );
  const trips = store.loadTrips();
  if (trips.length === 0) {
    refs.results.append(render.emptyEl(t("saved_none")));
    return;
  }
  refs.results.append(el("p", { class: "muted count", text: t("saved_count", { n: trips.length }) }));
  for (const trip of trips) {
    const info = savedTripInfo(trip);
    const card = el("div", { class: "saved-page-card" }, [
      el(
        "button",
        { class: "fav-open trip-open", type: "button", on: { click: info.open } },
        [
          el("span", { class: "trip-open-route", text: info.label }),
          el("span", { class: "muted small", text: info.when }),
        ],
      ),
      el("button", {
        class: "iconbtn",
        type: "button",
        text: "✕",
        title: t("act_unsave"),
        on: {
          click: () => {
            store.removeTrip(trip.id);
            renderSavedTrips();
            renderSavedPage(); // refresh the page in place (may now be empty)
          },
        },
      }),
    ]);
    refs.results.append(card);
  }
}

