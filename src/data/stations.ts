import type { Station } from "../types";
import { CITY_REFERENCE } from "./cities";
import { NON_BOOKABLE_PATTERNS } from "../config";

/** Lowercase, strip accents/diacritics for tolerant matching. */
export function normalizeText(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

/**
 * A station present in the open data but not bookable with a MAX pass (an
 * international stop — see NON_BOOKABLE_PATTERNS). These are hidden from
 * autocomplete/lists and their trains are marked unavailable, so they never
 * surface anywhere in the UI. Accent-insensitive substring match.
 */
export function isNonBookable(station: string): boolean {
  const n = normalizeText(station);
  return NON_BOOKABLE_PATTERNS.some((p) => n.includes(p));
}

// Station ids that are airports (flagged with an ✈ in the UI). The open data has no
// airport field, so detect by the markers SNCF uses in the station name: CDG and
// Lyon St-Exupéry are the two TGV airport stations, plus generic "aéroport".
const AIRPORT_MARKERS = ["AEROPORT", "ROISSY", "CHARLES DE GAULLE", "ST EXUPERY"];

/** True if the station id looks like an airport (Roissy-CDG, Lyon St-Exupéry, …). */
export function isAirportStation(id: string): boolean {
  const u = id.toUpperCase();
  return AIRPORT_MARKERS.some((m) => u.includes(m));
}

/**
 * Tolerant match key for city resolution: accent/case-folded, hyphens → spaces,
 * "St"/"Ste" → "Saint"/"Sainte". Lets "ST MALO", "Saint-Malo" and "SAINT MALO"
 * all resolve to the same city.
 */
export function matchNorm(s: string): string {
  return normalizeText(s)
    .replace(/[(),]/g, " ") // e.g. "ESSLINGEN(NECKAR)" -> "esslingen neckar"
    .replace(/-/g, " ")
    .replace(/\bst\b/g, "saint")
    .replace(/\bste\b/g, "sainte")
    .replace(/\s+/g, " ")
    .trim();
}

const ACRONYMS = new Set(["tgv", "cdg", "sncf"]);
// French articles and prepositions kept lower-case inside a name ("Brive-la-Gaillarde").
const PARTICLES = new Set(["de", "des", "du", "la", "le", "les", "et", "sur", "en", "d", "l"]);
// Names neither the casing rules nor a city's spelling can derive, by station id.
const STATION_LABELS: Record<string, string> = {
  "AEROPORT ROISSY CDG 2 TGV": "Aéroport Roissy CDG 2 TGV",
  "LYON ST EXUPERY TGV.": "Lyon Saint-Exupéry TGV",
  "ST PIERRE DES CORPS": "Saint-Pierre-des-Corps",
  "BESANCON FRANCHE COMTE TGV": "Besançon Franche-Comté TGV",
  "VALENCE TGV AUVERGNE RHONE ALPES": "Valence TGV Auvergne-Rhône-Alpes",
  "SAINT ETIENNE CHATEAUCREUX": "Saint-Étienne Châteaucreux",
  "LIMOGES BENEDICTINS": "Limoges-Bénédictins",
  "ETAPLES   LE TOUQUET": "Étaples-Le Touquet",
  "AIX LES BAINS LE REVARD": "Aix-les-Bains-Le Revard",
};

/**
 * Fallback display name for a station id not present in the registry: each word
 * capitalised, TGV/CDG upper-case, French particles lower-case after the first word.
 */
export function prettyLabel(id: string): string {
  return id
    .replace(/\s*\(intramuros\)/i, "")
    .replace(/\s*\(/g, " (") // "CAUSSADE(TARN" -> "CAUSSADE (TARN"
    .replace(/\.$/, "")
    .trim()
    .toLowerCase()
    .replace(/[a-zà-ÿ]+/g, (w: string, at: number) => {
      if (ACRONYMS.has(w)) return w.toUpperCase();
      if (at > 0 && PARTICLES.has(w)) return w;
      return w[0]!.toUpperCase() + w.slice(1);
    })
    .replace(/\s+/g, " ");
}

interface CityInfo {
  lat: number;
  lng: number;
  city: string;
  region?: string;
}

/** A city reference's match key, and its written name when the key is that name (not an alias). */
interface CityKey {
  key: string;
  info: CityInfo;
  spelling?: string;
}

/** `label` with the words that spell `key` (a {@link matchNorm} key) replaced by `spelling`. */
function respell(label: string, key: string, spelling: string): string {
  const words = label.split(" ");
  for (let i = 0; i < words.length; i++) {
    for (let j = i + 1; j <= words.length; j++) {
      if (matchNorm(words.slice(i, j).join(" ")) === key) {
        return [...words.slice(0, i), spelling, ...words.slice(j)].join(" ");
      }
    }
  }
  return label;
}

// Station-name qualifiers stripped when guessing a city name for guide links.
const QUALIFIERS = new Set([
  "tgv", "ville", "intramuros", "gare", "sncf", "hb", "centrale", "midi", "nord",
  "sud", "est", "ouest", "centre", "europe", "flandres", "sants", "atocha",
  "delicias", "main", "porta", "susa",
]);

export class StationRegistry {
  private byId = new Map<string, Station>();
  private index: { station: Station; hay: string; words: string[] }[] = [];
  // City coordinate references, longest key first, so specific names ("lille
  // flandres") win over short prefixes ("lille") when matching a station id.
  private cityKeys: CityKey[] = [];
  // Ids actually present in the loaded dataset (i.e. bookable).
  private present = new Set<string>();

  constructor(stations: Station[]) {
    for (const s of stations) this.add(s);

    const refMap = new Map<string, CityKey>();
    const addRef = (name: string | undefined, info: CityInfo, isName = false): void => {
      if (!name) return;
      const key = matchNorm(name);
      if (key && !refMap.has(key)) refMap.set(key, { key, info, spelling: isName ? name : undefined });
    };
    // Seed from curated stations (authoritative coords), then the supplementary
    // city table for the smaller / international stations.
    for (const s of this.byId.values()) {
      if (!Number.isFinite(s.lat) || !Number.isFinite(s.lng)) continue;
      const info: CityInfo = { lat: s.lat, lng: s.lng, city: s.city ?? s.label, region: s.region };
      addRef(s.label, info, true);
      addRef(s.city, info, true);
      for (const a of s.aliases ?? []) addRef(a, info);
    }
    for (const c of CITY_REFERENCE) {
      const info: CityInfo = { lat: c.lat, lng: c.lng, city: c.name, region: c.region };
      addRef(c.name, info, true);
      for (const a of c.aliases ?? []) addRef(a, info);
    }
    this.cityKeys = [...refMap.values()].sort((a, b) => b.key.length - a.key.length);
  }

  private add(s: Station): void {
    this.byId.set(s.id, s);
    const hay = [s.id, s.label, s.city ?? "", ...(s.aliases ?? [])]
      .map(normalizeText)
      .join(" ");
    this.index.push({ station: s, hay, words: hay.split(/\s+/).filter(Boolean) });
  }

  /** Best city reference matching a station id (whole-word, longest match); `named`: by a name, not an alias. */
  private matchCity(id: string, named = false): CityKey | undefined {
    const n = matchNorm(id);
    if (!n) return undefined;
    return this.cityKeys.find(
      ({ key, spelling }) =>
        (!named || spelling) &&
        (n === key || n.startsWith(`${key} `) || n.endsWith(` ${key}`) || n.includes(` ${key} `)),
    );
  }

  /**
   * Add minimal entries for any ids not already known, so every station in the
   * dataset is searchable. Coordinates, city and region are inherited from the
   * nearest city reference when one matches (else the station stays unplotted).
   * Every id passed here is also recorded as "present" (bookable).
   */
  addMissing(ids: Iterable<string>): void {
    for (const id of ids) {
      if (!id) continue;
      this.present.add(id);
      if (this.byId.has(id)) continue;
      const m = this.matchCity(id);
      const named = this.matchCity(id, true);
      this.add({
        id,
        // The table, else a city's own spelling, restores the accents and hyphens the id lost ("SETE" -> "Sète").
        label: STATION_LABELS[id] ?? (named?.spelling ? respell(prettyLabel(id), named.key, named.spelling) : prettyLabel(id)),
        lat: m ? m.info.lat : NaN,
        lng: m ? m.info.lng : NaN,
        city: m?.info.city,
        region: m?.info.region,
      });
    }
  }

  get(id: string): Station | undefined {
    return this.byId.get(id);
  }

  /** Every registered station (may contain label duplicates). */
  all(): Station[] {
    return [...this.byId.values()];
  }

  /** Display-ready stations, one per label, preferring bookable / located ids. */
  list(): Station[] {
    return this.dedupe(this.all().filter((s) => !isNonBookable(s.id)));
  }

  label(id: string): string {
    return this.byId.get(id)?.label ?? prettyLabel(id);
  }

  /** Best-guess city name for a station, used for external info links. */
  city(id: string): string {
    const s = this.byId.get(id);
    if (s?.city) return s.city;
    const m = this.matchCity(id);
    if (m) return m.info.city;
    return this.stripQualifiers(this.label(id));
  }

  private stripQualifiers(label: string): string {
    const kept = label.split(/[\s-]+/).filter((w) => !QUALIFIERS.has(normalizeText(w)));
    return kept.join(" ").trim() || label;
  }

  coords(id: string): [number, number] | undefined {
    const s = this.byId.get(id);
    return s && Number.isFinite(s.lat) && Number.isFinite(s.lng) ? [s.lat, s.lng] : undefined;
  }

  /** Accent-insensitive, word-prefix-aware autocomplete (deduped by label). */
  search(query: string, limit = 8): Station[] {
    const q = normalizeText(query);
    if (!q) {
      return this.list()
        .sort((a, b) => a.label.localeCompare(b.label))
        .slice(0, limit);
    }
    const prefix: Station[] = [];
    const contains: Station[] = [];
    for (const { station, hay, words } of this.index) {
      if (isNonBookable(station.id)) continue; // hidden: can't be booked with MAX
      if (words.some((w) => w.startsWith(q))) prefix.push(station);
      else if (hay.includes(q)) contains.push(station);
    }
    return this.dedupe([...prefix, ...contains]).slice(0, limit);
  }

  /** Prefer a bookable id, then one with coordinates, else keep the first seen. */
  private better(a: Station, b: Station): boolean {
    const pa = this.present.has(a.id);
    const pb = this.present.has(b.id);
    if (pa !== pb) return pa;
    const ca = Number.isFinite(a.lat) && Number.isFinite(a.lng);
    const cb = Number.isFinite(b.lat) && Number.isFinite(b.lng);
    if (ca !== cb) return ca;
    return false;
  }

  private dedupe(stations: Station[]): Station[] {
    const byLabel = new Map<string, Station>();
    const order: string[] = [];
    for (const s of stations) {
      const k = normalizeText(s.label);
      const cur = byLabel.get(k);
      if (!cur) {
        byLabel.set(k, s);
        order.push(k);
      } else if (this.better(s, cur)) {
        byLabel.set(k, s);
      }
    }
    return order.map((k) => byLabel.get(k)!);
  }
}
