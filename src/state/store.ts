import type { SearchQuery, SearchMode, CardType, Journey, SortKey, TripLeg, StayChoice } from "../types";
import type { Tour } from "../core/tour";
import { stayFromNights } from "../core/roundtrip";
import { dayIndex, parseTimeToMinutes } from "../util/time";
import { isLang, detectLang, type Lang } from "../i18n";
import { parseCard } from "../data/profile";

/** URL token for a stay choice (compact + stable): stay=day|<N>|flex, where <N> is the
 *  fixed nights count for a `` `n${N}` `` stay (any N). */
function stayToParam(stay: StayChoice): string {
  if (stay === "sameday") return "day";
  if (stay === "flexible") return "flex";
  return stay.slice(1); // "n2" → "2", "n10" → "10"
}
/** Parse a stay URL token back to a StayChoice, or undefined if unrecognized. */
function paramToStay(v: string): StayChoice | undefined {
  if (v === "day") return "sameday";
  if (v === "flex") return "flexible";
  const n = Number(v);
  return Number.isFinite(n) && n >= 1 ? `n${Math.floor(n)}` : undefined;
}

export type Theme = "light" | "dark" | "auto";
export type ViewMode = "list" | "map";

export interface RoutePair {
  origin: string;
  destination: string;
}

export interface Settings {
  lang: Lang;
  theme: Theme;
  card: CardType;
  view: ViewMode;
  /** Results density: "comfortable" (default) or "compact" (more trains per screen). */
  density: Density;
  /** Cut animations/transitions — cheaper on weak GPUs (and a motion-sensitivity option). */
  reduceMotion: boolean;
  /** Show the interactive map. Off = no Leaflet/tiles at all: the biggest saving on
   *  low-end devices and slow connections; results go full-width. */
  map: boolean;
}

export type Density = "comfortable" | "compact";

const KEY = {
  settings: "mj.settings",
  favorites: "mj.favorites",
  watched: "mj.watched",
  trips: "mj.trips",
  lowEndPrompted: "mj.lowEndPrompted",
} as const;

function readLS<T>(key: string, fallback: T, valid?: (v: unknown) => boolean): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as unknown;
    // The try/catch only guards against invalid JSON. A valid-but-wrong-TYPE value
    // (e.g. an object where an array is expected) would parse fine and then crash the
    // caller's .some()/.findIndex() — so callers can pass a shape check to fall back.
    if (valid && !valid(parsed)) return fallback;
    return parsed as T;
  } catch {
    return fallback;
  }
}

function writeLS(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage may be full or denied (private mode) — ignore */
  }
}

// --- settings ---------------------------------------------------------------

export function loadSettings(): Settings {
  const s = readLS<Partial<Settings>>(KEY.settings, {}, (v) => typeof v === "object" && v !== null && !Array.isArray(v));
  return {
    lang: isLang(s.lang) ? s.lang : detectLang(),
    theme: s.theme === "light" || s.theme === "dark" ? s.theme : "auto",
    card: parseCard(s.card),
    view: s.view === "map" ? "map" : "list",
    density: s.density === "compact" ? "compact" : "comfortable",
    reduceMotion: s.reduceMotion === true,
    map: s.map !== false, // default on
  };
}

export function saveSettings(s: Settings): void {
  writeLS(KEY.settings, s);
}

/** Whether the user has ever saved settings — used to detect a genuine first visit
 *  (so auto-tuning for a low-end device never overrides an explicit later choice). */
export function hasStoredSettings(): boolean {
  try {
    return localStorage.getItem(KEY.settings) != null;
  } catch {
    return false;
  }
}

/** Whether the low-end-device suggestion has already been shown — it appears at most
 *  once, ever, so a returning visitor is never nagged again (accepted or dismissed). */
export function wasLowEndPrompted(): boolean {
  try {
    return localStorage.getItem(KEY.lowEndPrompted) != null;
  } catch {
    return false;
  }
}

/** Record that the one-time low-end suggestion has been shown. */
export function markLowEndPrompted(): void {
  writeLS(KEY.lowEndPrompted, 1);
}

// --- favorites & watched routes ---------------------------------------------

function sameRoute(a: RoutePair, b: RoutePair): boolean {
  return a.origin === b.origin && a.destination === b.destination;
}

// Stored lists are checked per element: one malformed entry is dropped instead of
// crashing every render that reads the list.
type Stored = Record<string, unknown>;

function isStored(v: unknown): v is Stored {
  return typeof v === "object" && v !== null;
}

function isRoutePair(v: unknown): v is RoutePair & Stored {
  return isStored(v) && typeof v.origin === "string" && typeof v.destination === "string";
}

export function loadFavorites(): RoutePair[] {
  return readLS<unknown[]>(KEY.favorites, [], Array.isArray).filter(isRoutePair);
}

export function isFavorite(r: RoutePair): boolean {
  return loadFavorites().some((f) => sameRoute(f, r));
}

export function toggleFavorite(r: RoutePair): RoutePair[] {
  const list = loadFavorites();
  const i = list.findIndex((f) => sameRoute(f, r));
  if (i >= 0) list.splice(i, 1);
  else list.push(r);
  writeLS(KEY.favorites, list);
  return list;
}

export function loadWatched(): RoutePair[] {
  return readLS<unknown[]>(KEY.watched, [], Array.isArray).filter(isRoutePair);
}

export function isWatched(r: RoutePair): boolean {
  return loadWatched().some((f) => sameRoute(f, r));
}

export function toggleWatched(r: RoutePair): RoutePair[] {
  const list = loadWatched();
  const i = list.findIndex((f) => sameRoute(f, r));
  if (i >= 0) list.splice(i, 1);
  else list.push(r);
  writeLS(KEY.watched, list);
  return list;
}

// --- saved trips ------------------------------------------------------------

/**
 * A saved travel: a single journey ("one-way"), a round trip (outbound +
 * inbound), or a multi-city "tour". Stored as a snapshot of the chosen trains so
 * it survives a data refresh — a record of intent the traveller can re-check on
 * SNCF Connect.
 */
export interface SavedTrip {
  id: string;
  kind: "one-way" | "round" | "tour";
  outbound: Journey; // for a tour, its first leg (used for the rail label)
  inbound?: Journey;
  tour?: Tour; // full itinerary when kind === "tour"
  savedAt: number; // epoch ms, for newest-first ordering
}

/** Key for one journey's legs (dates + train numbers). */
function journeyKey(j: Journey): string {
  return j.legs.map((l) => `${l.date}/${l.trainNo}`).join(">");
}

/** Stable identity for a trip: its legs' dates + train numbers (both directions). */
export function tripId(outbound: Journey, inbound?: Journey): string {
  return inbound ? `${journeyKey(outbound)}|${journeyKey(inbound)}` : journeyKey(outbound);
}

/** Stable identity for a tour: every hop's legs, in order (prefixed to avoid clashes). */
export function tourId(tour: Tour): string {
  return `tour:${tour.legs.map(journeyKey).join("|")}`;
}

/** What a saved-trip row and its dialog read: dated endpoints, dated legs, the hub lists. */
function isJourney(v: unknown): v is Journey {
  const dated = (x: unknown): x is Stored => isRoutePair(x) && isValidIsoDate(x.date);
  return (
    dated(v) &&
    Array.isArray(v.legs) &&
    v.legs.length > 0 &&
    v.legs.every(dated) &&
    Array.isArray(v.hubs) &&
    Array.isArray(v.layovers)
  );
}

function isSavedTrip(v: unknown): v is SavedTrip {
  return (
    isStored(v) &&
    isJourney(v.outbound) &&
    (v.inbound == null || isJourney(v.inbound)) &&
    (v.tour == null || (isStored(v.tour) && Array.isArray(v.tour.legs) && v.tour.legs.every(isJourney)))
  );
}

export function loadTrips(): SavedTrip[] {
  return readLS<unknown[]>(KEY.trips, [], Array.isArray).filter(isSavedTrip);
}

export function isTripSaved(id: string): boolean {
  return loadTrips().some((t) => t.id === id);
}

/** Save a trip (no-op if already saved). Returns the updated, newest-first list. */
export function saveTrip(trip: SavedTrip): SavedTrip[] {
  const list = loadTrips();
  if (!list.some((t) => t.id === trip.id)) list.unshift(trip);
  writeLS(KEY.trips, list);
  return list;
}

export function removeTrip(id: string): SavedTrip[] {
  const list = loadTrips().filter((t) => t.id !== id);
  writeLS(KEY.trips, list);
  return list;
}

/** Save the trip if absent, else remove it. Returns whether it is now saved. */
export function toggleTrip(trip: SavedTrip): boolean {
  if (isTripSaved(trip.id)) {
    removeTrip(trip.id);
    return false;
  }
  saveTrip(trip);
  return true;
}

// --- URL deep-links ---------------------------------------------------------

export function queryToParams(q: SearchQuery): URLSearchParams {
  const p = new URLSearchParams();
  p.set("mode", q.mode);
  if (q.origin) p.set("from", q.origin);
  if (q.destination) p.set("to", q.destination);
  if (q.via) p.set("via", q.via);
  // "Hidden train" is ON by default, so the URL only needs to carry the OFF state
  // (hidden=0). Absence therefore means "default = on", which is what a bare deep-link
  // (or an older shared link) should get — the reason hidden trains silently never
  // appeared on shared/exact-trip links before.
  if (!q.hidden) p.set("hidden", "0");
  if (q.flexDays != null && q.flexDays > 0) p.set("flex", String(q.flexDays));
  if (q.returnDate) p.set("rdate", q.returnDate);
  if (q.legs && q.legs.length > 0) p.set("legs", q.legs.map((l) => `${l.from}>${l.to}@${l.date}`).join("~"));
  p.set("date", q.date);
  p.set("card", q.card);
  if (q.departAfter) p.set("after", q.departAfter);
  if (q.departBefore) p.set("before", q.departBefore);
  if (q.arriveBefore) p.set("arrbefore", q.arriveBefore);
  if (q.maxDurationMin != null) p.set("maxdur", String(q.maxDurationMin));
  if (q.trainType) p.set("type", q.trainType);
  if (q.maxConnections !== 1) p.set("conn", String(q.maxConnections));
  if (q.overnight) p.set("night", "1");
  if (q.excludeNight) p.set("nonight", "1");
  if (q.onlyNight) p.set("onlynight", "1");
  if (q.region) p.set("rg", q.region);
  if (q.cities && q.cities.length > 0) p.set("cities", q.cities.join("~"));
  if (q.minDays != null && q.minDays !== 1) p.set("dmin", String(q.minDays));
  if (q.maxDays != null && q.maxDays !== 3) p.set("dmax", String(q.maxDays));
  if (q.maxKm != null && q.maxKm > 0) p.set("maxkm", String(q.maxKm));
  if (q.maxLegKm != null && q.maxLegKm > 0) p.set("legkm", String(q.maxLegKm));
  if (q.maxLegDurationMin != null && q.maxLegDurationMin > 0) p.set("legdur", String(q.maxLegDurationMin));
  if (q.minLegDurationMin != null && q.minLegDurationMin > 0) p.set("legdurmin", String(q.minLegDurationMin));
  if (q.maxSpanDays != null && q.maxSpanDays > 0) p.set("span", String(q.maxSpanDays));
  if (q.radiusKm != null && q.radiusKm > 0) p.set("rad", String(q.radiusKm));
  // The "How long?" stay choice is the canonical round-trip input: stay=day|1|2|3|flex.
  // (For an exact route the concrete return day also travels as rdate above, so a shared
  // link opens on the right return.) Legacy rt=round / rt=1 / rt=day still read below.
  if (q.stay) p.set("stay", stayToParam(q.stay));
  if (q.nights != null && q.nights > 0) p.set("nights", String(q.nights));
  if (q.flexNights) p.set("fn", "1");
  if (q.stayMinHours != null && q.stayMinHours > 0) p.set("stayh", String(q.stayMinHours));
  if (q.lateReturn) p.set("late", "1");
  if (q.tourEndDate) p.set("by", q.tourEndDate);
  if (q.sort && q.sort !== "rec") p.set("sort", q.sort);
  return p;
}

const SORT_KEYS = ["rec", "trains", "days", "closest", "fastest", "name"] as const;

export function queryFromParams(p: URLSearchParams, fallbackDate: string): SearchQuery {
  const rawMode = p.get("mode") ?? "from";
  const mode = (["from", "to", "od", "best", "tour"].includes(rawMode) ? rawMode : "from") as SearchMode;
  const maxdur = Number(p.get("maxdur"));
  const connRaw = p.get("conn");
  const conn = connRaw == null ? 1 : Number(connRaw);
  const cities = p.get("cities");
  const dmin = Number(p.get("dmin"));
  const dmax = Number(p.get("dmax"));
  const maxkm = Number(p.get("maxkm"));
  const legkm = Number(p.get("legkm"));
  const legdur = Number(p.get("legdur"));
  const legdurmin = Number(p.get("legdurmin"));
  const span = Number(p.get("span"));
  const rad = Number(p.get("rad"));
  const nights = Number(p.get("nights"));
  const stayh = Number(p.get("stayh"));
  const clampDay = (n: number, fallback: number): number =>
    Number.isFinite(n) && n >= 1 ? Math.min(14, Math.floor(n)) : fallback;
  // A malformed date or time is dropped: kept, a date crashes the render and a time
  // filters out every train while the form shows no filter.
  const isoDate = (key: string): string | undefined => {
    const v = p.get(key);
    return v && isValidIsoDate(v) ? v : undefined;
  };
  const time = (key: string): string | undefined => {
    const v = p.get(key);
    return v && /^\d{2}:\d{2}$/.test(v) && Number.isFinite(parseTimeToMinutes(v)) ? v : undefined;
  };
  return {
    mode,
    origin: p.get("from") ?? undefined,
    destination: p.get("to") ?? undefined,
    via: p.get("via") ?? undefined,
    // ON by default (od-only; readQueryFromForm re-gates it to od so it never leaks to
    // other modes). Only an explicit hidden=0 turns it off — a missing param means the
    // default (on), so a bare deep-link surfaces hidden trains like the form does.
    // Legacy hidden=1 links stay on too.
    hidden: p.get("hidden") !== "0" || undefined,
    // Clamp to the stepper's 0..7 range (like setStepper) — an out-of-range link
    // should mean "the widest window", not silently fall back to no flexibility.
    flexDays: Number.isFinite(Number(p.get("flex"))) && Math.floor(Number(p.get("flex"))) >= 1 ? Math.min(7, Math.floor(Number(p.get("flex")))) : undefined,
    returnDate: isoDate("rdate"),
    legs: parseLegs(p.get("legs")),
    date: isoDate("date") ?? fallbackDate,
    card: parseCard(p.get("card")),
    departAfter: time("after"),
    departBefore: time("before"),
    arriveBefore: time("arrbefore"),
    maxDurationMin: Number.isFinite(maxdur) && maxdur > 0 ? maxdur : undefined,
    trainType: p.get("type") ?? undefined,
    maxConnections: Number.isFinite(conn) && conn >= 0 && conn <= 6 ? conn : 1,
    overnight: p.get("night") === "1" || undefined,
    excludeNight: p.get("nonight") === "1" || undefined,
    onlyNight: p.get("onlynight") === "1" || undefined,
    region: p.get("rg") ?? undefined,
    cities: cities ? cities.split("~").filter(Boolean) : undefined,
    minDays: p.has("dmin") ? clampDay(dmin, 1) : undefined,
    maxDays: p.has("dmax") ? clampDay(dmax, 3) : undefined,
    maxKm: Number.isFinite(maxkm) && maxkm > 0 ? Math.floor(maxkm) : undefined,
    maxLegKm: Number.isFinite(legkm) && legkm > 0 ? Math.floor(legkm) : undefined,
    // Per-train time cap (tour). readQueryFromForm re-gates it to tour mode.
    maxLegDurationMin: Number.isFinite(legdur) && legdur > 0 ? Math.max(30, Math.floor(legdur)) : undefined,
    minLegDurationMin: Number.isFinite(legdurmin) && legdurmin > 0 ? Math.floor(legdurmin) : undefined,
    // od-only; readQueryFromForm re-gates it to od so it never leaks to other modes.
    maxSpanDays: Number.isFinite(span) && span > 0 ? Math.min(14, Math.floor(span)) : undefined,
    // od-only search radius (km) for nearby paid-connection alternatives.
    radiusKm: Number.isFinite(rad) && rad > 0 ? Math.min(300, Math.floor(rad)) : undefined,
    // Stay choice: the explicit stay=… param wins. Legacy links carry it as rt=… and/or
    // rdate: rt=day → same day, a concrete rdate on/after the outbound → the matching
    // fixed N-night stay, and a bare rt=round / rt=1 → Flexible.
    stay: parseStay(p),
    nights: Number.isFinite(nights) && nights >= 1 ? Math.min(3, Math.floor(nights)) : undefined,
    flexNights: p.get("fn") === "1" || undefined,
    stayMinHours: Number.isFinite(stayh) && stayh >= 1 ? Math.min(12, Math.floor(stayh)) : undefined,
    lateReturn: p.get("late") === "1" || undefined,
    tourEndDate: isoDate("by"),
    sort: parseSort(p.get("sort")),
  };
}

/** Validate a URL sort value against the known keys (undefined = the default rank). */
function parseSort(raw: string | null): SortKey | undefined {
  return raw && (SORT_KEYS as readonly string[]).includes(raw) ? (raw as SortKey) : undefined;
}

/**
 * Resolve the "How long?" stay choice from a URL. The explicit `stay` token wins; a
 * legacy link is read from `rt` + `rdate`: `rt=day` is a same-day trip, a concrete
 * `rdate` on/after the outbound maps to the matching fixed N-night stay,
 * and a bare `rt=round` / `rt=1` (no rdate) is Flexible. Returns undefined for a plain
 * one-way. (An out-of-window date is re-clamped in app.ts, which re-derives the stay
 * from the carried rdate then, so this only needs the raw params.)
 */
function parseStay(p: URLSearchParams): StayChoice | undefined {
  const explicit = p.get("stay");
  if (explicit) {
    const parsed = paramToStay(explicit);
    if (parsed) return parsed;
  }
  const rt = p.get("rt");
  const rdate = p.get("rdate");
  const date = p.get("date");
  if (rdate && date && isValidIsoDate(rdate) && isValidIsoDate(date) && rdate >= date) {
    return stayFromNights(dayIndex(rdate) - dayIndex(date));
  }
  if (rt === "day") return "sameday";
  if (rt === "round" || rt === "1") return "flexible";
  return undefined;
}

// A crafted `legs` param must never crash the render: an unbounded leg list runs
// findJourneys per leg in one frame, and a malformed date reaches formatDate() as
// `new Date("garbageT00:00:00")` → Invalid Date → RangeError. Cap the count and
// require a real ISO date so both are impossible from a URL.
const MAX_LEGS = 12;

/** Whether a value is a real calendar date written YYYY-MM-DD (not 2026-10-1 or 2026-02-30). */
function isValidIsoDate(d: unknown): d is string {
  if (typeof d !== "string") return false;
  const t = Date.parse(`${d}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === d;
}

/** Parse the "legs" param (from>to@date, ~-joined) into multi-city legs. */
function parseLegs(raw: string | null): TripLeg[] | undefined {
  if (!raw) return undefined;
  const legs = raw
    .split("~")
    .map((s) => {
      const [od, date] = s.split("@");
      const [from, to] = (od ?? "").split(">");
      return { from: from ?? "", to: to ?? "", date: date ?? "" };
    })
    // A leg needs both endpoints and a genuine date — a bad date segment is
    // dropped rather than kept and later crashing the render.
    .filter((l) => l.from && l.to && isValidIsoDate(l.date))
    .slice(0, MAX_LEGS);
  return legs.length > 0 ? legs : undefined;
}

export function updateUrl(q: SearchQuery, state?: unknown): void {
  // Preserve whatever state the current entry already holds (e.g. a form snapshot) when
  // the caller doesn't pass one — an incidental in-place update (a calendar tap) must not
  // wipe the snapshot a later gesture-Back would restore from.
  history.replaceState(state === undefined ? history.state : state, "", `${location.pathname}?${queryToParams(q).toString()}`);
}

/**
 * Push a new history entry, so the browser Back button returns to the prior page.
 * `state` is stored on the entry (we stash a form snapshot there) so a gesture-Back /
 * popstate can restore the exact form that produced the page instead of wiping it.
 */
export function pushUrl(q: SearchQuery, state: unknown = null): void {
  history.pushState(state, "", `${location.pathname}?${queryToParams(q).toString()}`);
}

export function urlHasQuery(): boolean {
  const p = new URLSearchParams(location.search);
  return p.has("from") || p.has("to") || p.has("mode");
}
