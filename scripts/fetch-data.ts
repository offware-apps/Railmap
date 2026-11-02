/**
 * scripts/fetch-data.ts
 *
 * Downloads the full SNCF tgvmax dataset via the Opendatasoft Explore API v2.1
 * export endpoint and writes, under public/data/:
 *   tgvmax.json          – the MAX pass: trains with a free MAX seat (record array)
 *   meta.json            – its freshness metadata
 *   interrail.json       – the Interrail pass: every train in the feed, in the
 *                          compact format of src/data/compact.ts
 *   interrail-meta.json  – its freshness metadata
 *
 * Run via: npm run fetch-data  (tsx scripts/fetch-data.ts)
 */

// node-shims.d.ts in the same directory provides ambient declarations for
// fs, path, and process so we can import them without @types/node.
import * as fs from "fs";
import * as path from "path";
import { encodeCompact } from "../src/data/compact";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MappedRecord {
  date: string;
  origine: string;
  destination: string;
  heure_depart: string;
  heure_arrivee: string;
  train_no: string;
  od_happy_card: string;
  axe?: string;
}

interface Meta {
  updatedAt: string;
  source: string;
  recordCount: number;
  isSample: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const API_URL =
  "https://ressources.data.sncf.com/api/explore/v2.1/catalog/datasets/tgvmax/exports/json";
const TIMEOUT_MS = 60_000;
const MAX_RETRIES = 3;
const REPO_ROOT = process.cwd();
const OUT_DATA = path.resolve(REPO_ROOT, "public", "data", "tgvmax.json");
const OUT_META = path.resolve(REPO_ROOT, "public", "data", "meta.json");
const OUT_IR_DATA = path.resolve(REPO_ROOT, "public", "data", "interrail.json");
const OUT_IR_META = path.resolve(REPO_ROOT, "public", "data", "interrail-meta.json");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return response;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithRetry(url: string): Promise<unknown[]> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.log(`[fetch-data] Attempt ${attempt}/${MAX_RETRIES}: GET ${url}`);
      const response = await fetchWithTimeout(url, TIMEOUT_MS);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }

      const data: unknown = await response.json();

      if (!Array.isArray(data)) {
        throw new Error(`Expected JSON array, got ${typeof data}`);
      }

      return data as unknown[];
    } catch (err) {
      lastError = err;
      const isAbort = err instanceof Error && err.name === "AbortError";
      const label = isAbort ? "timeout" : String(err);
      console.error(`[fetch-data] Attempt ${attempt} failed: ${label}`);

      if (attempt < MAX_RETRIES) {
        const backoffMs = 2_000 * attempt; // 2s, 4s
        console.log(`[fetch-data] Retrying in ${backoffMs / 1000}s…`);
        await sleep(backoffMs);
      }
    }
  }

  throw lastError;
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

function mapRecord(raw: Record<string, unknown>): MappedRecord {
  const rec: MappedRecord = {
    date: String(raw["date"] ?? ""),
    origine: String(raw["origine"] ?? ""),
    destination: String(raw["destination"] ?? ""),
    heure_depart: String(raw["heure_depart"] ?? ""),
    heure_arrivee: String(raw["heure_arrivee"] ?? ""),
    train_no: String(raw["train_no"] ?? ""),
    od_happy_card: String(raw["od_happy_card"] ?? ""),
  };
  if (raw["axe"] != null) {
    rec.axe = String(raw["axe"]);
  }
  return rec;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("[fetch-data] Starting SNCF tgvmax dataset download…");

  let rawArray: unknown[];
  try {
    rawArray = await fetchWithRetry(API_URL);
  } catch (err) {
    console.error("[fetch-data] All attempts failed. Not overwriting existing data.");
    console.error(err);
    process.exit(1);
  }

  if (rawArray.length === 0) {
    console.error("[fetch-data] Received empty array from API. Not overwriting existing data.");
    process.exit(1);
  }

  console.log(`[fetch-data] Downloaded ${rawArray.length} raw records. Mapping…`);

  const mapped: MappedRecord[] = rawArray.map((item) =>
    mapRecord(item as Record<string, unknown>)
  );

  // The app only ever shows reservable MAX seats, so drop the (huge) majority of
  // rows where od_happy_card !== "OUI". The full export is ~77 MB and ~90% of it
  // is unavailable trains the UI never displays — keeping it would make the
  // client download/parse a payload large enough to hang or crash mobile
  // browsers. Filtering here keeps the served snapshot ~6 MB.
  const records = mapped.filter((r) => r.od_happy_card.toUpperCase() === "OUI");
  console.log(
    `[fetch-data] Kept ${records.length} reservable (OUI) of ${mapped.length} mapped records.`,
  );

  // Never overwrite a good snapshot with nothing. If the OUI filter yields zero (an
  // upstream schema change, or a genuinely dry response that still passed the array
  // check), the whole 30-day window being empty is far more likely a fault than real
  // — keep yesterday's data instead of wiping the site down to the tiny sample.
  if (records.length === 0) {
    console.error("[fetch-data] Zero reservable (OUI) records after mapping. Not overwriting existing data.");
    process.exit(1);
  }

  const meta: Meta = {
    updatedAt: new Date().toISOString(),
    source: "SNCF Open Data — tgvmax (Licence Ouverte)",
    recordCount: records.length,
    isSample: false,
  };

  // Ensure data/ directory exists
  const dataDir = path.dirname(OUT_DATA);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  fs.writeFileSync(OUT_DATA, JSON.stringify(records), "utf-8");
  console.log(`[fetch-data] Wrote ${records.length} records → ${OUT_DATA}`);

  fs.writeFileSync(OUT_META, JSON.stringify(meta, null, 2), "utf-8");
  console.log(`[fetch-data] Wrote metadata → ${OUT_META}`);

  // Interrail: every train that runs takes a pass-holder reservation, seat or not, so
  // keep them all. Each distinct service is stored once with the dates it runs on, which
  // keeps the whole feed a static file instead of ~65 MB of repeated rows.
  const compact = encodeCompact(mapped.filter((r) => r.origine && r.destination && r.date));
  const irMeta: Meta = {
    updatedAt: meta.updatedAt,
    source: "SNCF Open Data — tgvmax, all trains (Licence Ouverte)",
    recordCount: mapped.length,
    isSample: false,
  };
  fs.writeFileSync(OUT_IR_DATA, JSON.stringify(compact), "utf-8");
  console.log(
    `[fetch-data] Wrote ${compact.trains.length} services (${mapped.length} trains) → ${OUT_IR_DATA}`,
  );
  fs.writeFileSync(OUT_IR_META, JSON.stringify(irMeta, null, 2), "utf-8");
  console.log(`[fetch-data] Wrote metadata → ${OUT_IR_META}`);
  console.log(`[fetch-data] Done. updatedAt=${meta.updatedAt}`);
}

main().catch((err: unknown) => {
  console.error("[fetch-data] Unexpected error:", err);
  process.exit(1);
});
