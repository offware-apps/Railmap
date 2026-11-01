import type { Journey } from "../types";

/**
 * What an Interrail pass holder pays to reserve a seat on SNCF trains, in euros, 2nd
 * class. The same table train-api publishes as v1/sncf/interrail/fees.json (see its
 * src/operators/interrail-fees.ts), hand-entered from Interrail's fee pages and checked
 * on 2026-10-12. Indicative: the app says so and links the source.
 *
 * A stop abroad sets the international fee for that country; otherwise the train's axe
 * sets the domestic one.
 */

/** A pass-holder reservation in euros; `min === max` for a fixed fee. */
export interface Fee {
  min: number;
  max: number;
}

type Country = "BE" | "CH" | "DE" | "ES" | "IT" | "LU";

/** Whole words of SNCF stop names abroad, by country (accents and case ignored). */
const FOREIGN_STOPS: Record<Country, string[]> = {
  BE: ["bruxelles", "brussel", "liege", "anvers", "antwerpen"],
  CH: ["geneve", "lausanne", "zurich", "basel", "bale", "bern", "vallorbe", "neuchatel"],
  DE: [
    "mannheim", "saarbrucken", "saarbruecken", "kaiserslautern", "frankfurt", "karlsruhe",
    "stuttgart", "augsburg", "munchen", "baden baden", "ulm", "freiburg", "koln", "dortmund",
  ],
  ES: ["barcelona", "girona", "figueres", "madrid"],
  IT: ["torino", "milano", "oulx", "oux"],
  LU: ["luxembourg"],
};

const BY_COUNTRY: Record<Exclude<Country, "ES">, Fee> = {
  BE: { min: 20, max: 35 }, // TGV to Brussels
  CH: { min: 25, max: 25 }, // TGV Lyria
  DE: { min: 19, max: 19 }, // ICE & TGV France–Germany
  IT: { min: 31, max: 31 }, // TGV France–Italy
  LU: { min: 10, max: 20 }, // TGV to Luxembourg
};
const SPAIN_FROM_PARIS: Fee = { min: 35, max: 35 };
const SPAIN_OTHER: Fee = { min: 25, max: 25 };

const BY_AXE: Record<string, Fee> = {
  "SUD EST": { min: 10, max: 20 }, // TGV INOUI
  EST: { min: 10, max: 20 },
  ATLANTIQUE: { min: 10, max: 20 },
  NORD: { min: 10, max: 20 },
  INTERNATIONAL: { min: 10, max: 20 }, // a stretch inside France
  "IC SRO": { min: 10, max: 20 }, // Intercités, reservation compulsory
  "IC ARO": { min: 10, max: 20 },
  "IC NUIT": { min: 10, max: 25 }, // seat €10, couchette €19–25
};

function fold(s: string): string {
  return ` ${s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
}

function foreignCountry(stop: string): Country | undefined {
  const f = fold(stop);
  for (const [country, names] of Object.entries(FOREIGN_STOPS) as [Country, string[]][]) {
    if (names.some((n) => f.includes(` ${n} `))) return country;
  }
  return undefined;
}

/** The fee for one SNCF train between two stops, or undefined when no fee page covers it. */
export function interrailFee(axe: string | undefined, origin: string, destination: string): Fee | undefined {
  const abroad = foreignCountry(origin) ?? foreignCountry(destination);
  if (abroad === "ES") return [origin, destination].some((s) => fold(s).includes(" paris ")) ? SPAIN_FROM_PARIS : SPAIN_OTHER;
  if (abroad) return BY_COUNTRY[abroad];
  return axe ? BY_AXE[axe] : undefined;
}

/**
 * The fees of every train in a journey added up, or undefined when one train has none.
 * The table covers SNCF's trains only, so another operator's train leaves the journey without one.
 */
export function journeyFee(j: Journey): Fee | undefined {
  let min = 0;
  let max = 0;
  for (const leg of j.legs) {
    if (leg.operator) return undefined;
    const fee = interrailFee(leg.axe, leg.origin, leg.destination);
    if (!fee) return undefined;
    min += fee.min;
    max += fee.max;
  }
  return { min, max };
}

/** "€19" or "€10–20", in the reader's locale. */
export function formatFee(fee: Fee, lang: string): string {
  const eur = (v: number): string =>
    new Intl.NumberFormat(lang, { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(v);
  return fee.min === fee.max ? eur(fee.min) : `${eur(fee.min)}–${eur(fee.max)}`;
}
