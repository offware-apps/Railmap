/**
 * The operators whose trains an Interrail pass takes across Europe, by train-api's
 * operator id: their names and where pass holders book. train-api's v2 index carries the
 * booking sites too (they win when present); these are the fallback.
 */
export interface Operator {
  /** train-api's operator id. */
  id: string;
  /** Its name, as on its booking site. */
  name: string;
  /** Where pass holders book its trains. */
  bookingUrl: string;
}

const OPERATORS: Operator[] = [
  { id: "renfe", name: "Renfe", bookingUrl: "https://www.renfe.com/es/en" },
  { id: "nl", name: "NS", bookingUrl: "https://www.ns.nl/en" },
  { id: "de", name: "DB", bookingUrl: "https://int.bahn.de/en" },
  { id: "it", name: "Trenitalia", bookingUrl: "https://www.trenitalia.com/en.html" },
  { id: "ch", name: "SBB", bookingUrl: "https://www.sbb.ch/en" },
  { id: "no", name: "Vy", bookingUrl: "https://www.vy.no/en" },
  { id: "fi", name: "VR", bookingUrl: "https://www.vr.fi/en" },
  { id: "ie", name: "Irish Rail", bookingUrl: "https://www.irishrail.ie/en-ie/" },
  { id: "se", name: "SJ", bookingUrl: "https://www.sj.se/en" },
  { id: "gb", name: "National Rail", bookingUrl: "https://www.nationalrail.co.uk/" },
];

/** Booking sites train-api published, by operator id; they replace the ones above. */
let published: Record<string, string> = {};

export function setOperatorBooking(booking: Record<string, string>): void {
  published = booking;
}

/** An operator by its train-api id; undefined for SNCF (booked on SNCF Connect) and unknown ids. */
export function operatorById(id: string | undefined): Operator | undefined {
  if (!id || id === "sncf") return undefined;
  const op = OPERATORS.find((o) => o.id === id) ?? { id, name: id.toUpperCase(), bookingUrl: "" };
  const url = published[id] ?? op.bookingUrl;
  return url ? { ...op, bookingUrl: url } : undefined;
}
