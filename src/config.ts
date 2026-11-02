/** SNCF Open Data — Explore API v2.1 records endpoint for the `tgvmax` dataset. */
export const SNCF_API_URL =
  "https://ressources.data.sncf.com/api/explore/v2.1/catalog/datasets/tgvmax/records";

/** Major interchange stations used to build single-connection journeys. */
export const HUB_STATIONS: string[] = [
  "PARIS (intramuros)",
  "LYON (intramuros)",
  "LILLE",
  "MARSEILLE ST CHARLES",
  "BORDEAUX ST JEAN",
  "RENNES",
  "STRASBOURG",
  "NANTES",
  "MONTPELLIER SAINT ROCH",
  "TOULOUSE MATABIAU",
];

/** Allowed layover window (minutes) for a connection. */
export const MIN_CONNECTION_MIN = 15;
export const MAX_CONNECTION_MIN = 240;
/** Layover ceiling when overnight stopovers are allowed (sleep at the hub). */
export const OVERNIGHT_MAX_CONNECTION_MIN = 15 * 60;

/**
 * Minimum time on site (minutes) for a SAME-DAY round trip to count as a real day
 * out. Below this, a "trip" is just stepping off the platform and boarding the
 * return — so both the discovery list and the exact round-trip page require at
 * least this gap between arriving and the return leaving. It also drops outbound
 * departures so late that no return can leave this many minutes later and still get
 * you home by midnight (you'd be stranded).
 */
export const SAME_DAY_MIN_ON_SITE_MIN = 4 * 60;

/**
 * Destinations that appear in the open data but are NOT bookable with a MAX pass
 * (MAX JEUNE / SENIOR cover domestic France; these international stops show
 * od_happy_card="OUI" in the feed but can't actually be reserved with the pass).
 * Matched as accent-insensitive substrings of the station label — extend freely.
 */
export const NON_BOOKABLE_PATTERNS: string[] = [
  "geneve", // Genève / Geneva (CH)
  "lausanne", // (CH)
  "zurich", // (CH)
  "bruxelles", // Brussels (BE)
  "brussel",
];

const BASE = (import.meta.env?.BASE_URL ?? "/") as string;

/** Base-relative data URLs (work under the GitHub Pages sub-path). */
export const DATA_URL = `${BASE}data/tgvmax.json`;
export const META_URL = `${BASE}data/meta.json`;
/** The Interrail snapshot: every running train in the feed, in the compact format
 *  (`src/data/compact.ts`), with its own freshness metadata. */
export const INTERRAIL_DATA_URL = `${BASE}data/interrail.json`;
export const INTERRAIL_META_URL = `${BASE}data/interrail-meta.json`;

/**
 * train-api (github.com/offware-apps/train-api): every pass's timetable as static JSON,
 * refreshed daily. The app reads it first and falls back to its own snapshot above.
 * Its base URL lives in index.html's `<meta name="train-api">` so theme.js can preload
 * from it and a test server can switch it off; missing or empty = off.
 */
export function trainApiBase(): string {
  if (typeof document === "undefined") return "";
  return document.querySelector<HTMLMetaElement>('meta[name="train-api"]')?.content.trim().replace(/\/+$/, "") ?? "";
}

export const SNCF_CONNECT_URL = "https://www.sncf-connect.com/";

export const SITE_URL = "https://offware-apps.github.io/Railmap/";

/** Project repository (used for the header star link and the feedback button). */
export const GITHUB_URL = "https://github.com/offware-apps/Railmap";
export const GITHUB_ISSUES_URL = `${GITHUB_URL}/issues/new`;

/** Official SNCF pages describing the MAX JEUNE / MAX SENIOR subscriptions. */
export const MAX_JEUNE_URL = "https://www.sncf-connect.com/catalogue/description/max-jeune";
export const MAX_SENIOR_URL = "https://www.sncf-connect.com/catalogue/description/max-senior";
/** Interrail's page on pass-holder reservations for French trains. */
export const INTERRAIL_FRANCE_URL = "https://www.interrail.com/en/plan-your-trip/reservations/reservations-france";
/** Interrail Global Pass conditions: who can buy it, and the country-of-residence rule. */
export const INTERRAIL_PASS_URL = "https://www.interrail.com/en/interrail-passes/global-pass";
/** ADEME's CO₂ comparator, the source of the per-km factors in src/util/eco.ts. */
export const ADEME_CO2_URL = "https://impactco2.fr/outils/transport";

/** App version + build date, injected from package.json at build time (see vite.config).
 *  Falls back to "dev" when the defines aren't present (e.g. a raw ts-node run). */
declare const __APP_VERSION__: string;
declare const __APP_BUILD__: string;
export const APP_VERSION = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev";
export const APP_BUILD = typeof __APP_BUILD__ === "string" ? __APP_BUILD__ : "";
