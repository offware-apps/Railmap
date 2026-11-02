import {
  DATA_URL,
  META_URL,
  INTERRAIL_DATA_URL,
  INTERRAIL_META_URL,
  SNCF_API_URL,
  HUB_STATIONS,
  NON_BOOKABLE_PATTERNS,
} from "../config";
import type { CardType } from "../types";
import { decodeCompact, isCompact } from "./compact";

/**
 * A data-source PROFILE: everything about reading and judging ONE train dataset.
 *
 * The core (search / connections / calendar / tour) only ever sees the normalized
 * `MaxTrain` shape, so the SNCF-specifics live here at the edge. Adding another
 * operator later (Deutsche Bahn, Renfe, …) means supplying another profile — a
 * different field mapping and a different "is this seat bookable?" rule — without
 * touching the core. SNCF "tgvmax" (the MAX pass) is the default profile; the
 * Interrail profile reads the same SNCF feed but keeps every running train.
 */
export interface DatasetProfile {
  /** Stable identifier, e.g. "sncf-tgvmax". */
  id: string;
  /** Base-relative snapshot + metadata URLs (served with the static site). */
  dataUrl: string;
  metaUrl: string;
  /** Upstream open-data API (optional; used by the data-refresh script). */
  apiUrl?: string;
  /** Pull the core fields out of one raw record (whatever shape the source uses). */
  read: (r: RawSourceRecord) => ReadFields;
  /**
   * Does this record have a bookable / highlighted seat for this source's pass?
   * SNCF: a free MAX seat (`od_happy_card === "OUI"`). A source with no pass concept
   * can simply return `true`.
   */
  isReservable: (r: RawSourceRecord) => boolean;
  /** Interchange hubs used to build connecting journeys in this network. */
  hubs: string[];
  /**
   * Station-name substrings that appear in the feed but are NOT bookable with the
   * pass (SNCF: international stops). Accent-insensitive substring match; empty for
   * sources with no such exclusions.
   */
  nonBookablePatterns: string[];
  /**
   * Does the data say whether a seat is left for this pass? SNCF publishes it for MAX;
   * no open data does for Interrail, so its trains show as running with the seat unknown.
   */
  seatKnown: boolean;
  /**
   * Turn the parsed snapshot file into raw records. Omitted = the file is already a
   * plain array of records.
   */
  decode?: (json: unknown) => RawSourceRecord[] | null;
  /** This pass's id in train-api (`<base>/sncf/<pass>/all.json`); omitted = snapshot only. */
  trainApiPass?: string;
}

/** One raw record before normalization — shape varies per source, so it's untyped. */
export type RawSourceRecord = Record<string, unknown>;

/** The fields the core needs, lifted out of a source's own record shape. */
export interface ReadFields {
  origin?: string;
  destination?: string;
  date?: string;
  depart?: string;
  arrive?: string;
  trainNo?: string;
  /** Line / route family / train-type marker (SNCF: the "axe"). */
  category?: string;
}

/** Trim any raw value to a non-empty string, or undefined. */
function str(v: unknown): string | undefined {
  const s = typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim();
  return s || undefined;
}

/**
 * SNCF "tgvmax" — the default profile (the MAX pass). Encodes today's exact
 * behaviour: French field names, and a free MAX seat means `od_happy_card === "OUI"`.
 */
export const SNCF_PROFILE: DatasetProfile = {
  id: "sncf-tgvmax",
  dataUrl: DATA_URL,
  metaUrl: META_URL,
  apiUrl: SNCF_API_URL,
  read: (r) => ({
    origin: str(r.origine),
    destination: str(r.destination),
    date: str(r.date),
    depart: str(r.heure_depart),
    arrive: str(r.heure_arrivee),
    trainNo: str(r.train_no),
    category: str(r.axe),
  }),
  isReservable: (r) => str(r.od_happy_card)?.toUpperCase() === "OUI",
  hubs: HUB_STATIONS,
  nonBookablePatterns: NON_BOOKABLE_PATTERNS,
  seatKnown: true,
  // Both MAX cards read the MAX JEUNE timetable; MAX SENIOR's weekday rule stays a notice.
  trainApiPass: "max-jeune",
};

/**
 * SNCF trains for an Interrail pass holder. Every TGV INOUI, Intercités, night and
 * international train in the feed takes a pass-holder reservation, so every train that
 * runs counts. Nothing says whether a pass-holder seat is left (`seatKnown: false`),
 * and international stops are fine (no exclusions). The snapshot is the compact file.
 */
export const INTERRAIL_PROFILE: DatasetProfile = {
  ...SNCF_PROFILE,
  id: "sncf-interrail",
  dataUrl: INTERRAIL_DATA_URL,
  metaUrl: INTERRAIL_META_URL,
  isReservable: () => true,
  nonBookablePatterns: [],
  seatKnown: false,
  decode: (json) => (isCompact(json) ? (decodeCompact(json) as unknown as RawSourceRecord[]) : null),
  trainApiPass: "interrail",
};

/** Read any value as a pass, defaulting to MAX JEUNE. */
export function parseCard(x: unknown): CardType {
  return x === "senior" || x === "interrail" ? x : "jeune";
}

/** The dataset a pass searches: both MAX subscriptions share the MAX snapshot. */
export function profileForCard(card: CardType): DatasetProfile {
  return card === "interrail" ? INTERRAIL_PROFILE : SNCF_PROFILE;
}
