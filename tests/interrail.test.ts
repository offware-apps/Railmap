import { describe, it, expect, afterEach, vi } from "vitest";
import type { RawRecord } from "../src/types";
import { encodeCompact, decodeCompact, isCompact, type TimetableRow } from "../src/data/compact";
import { loadDataset, normalizeRecords } from "../src/data/dataset";
import { INTERRAIL_PROFILE, SNCF_PROFILE, parseCard, profileForCard } from "../src/data/profile";
import { queryFromParams, queryToParams } from "../src/state/store";
import { t, setSeatUnknown } from "../src/i18n";

const row = (date: string, over: Partial<TimetableRow> = {}): TimetableRow => ({
  date,
  origine: "PARIS (intramuros)",
  destination: "LYON (intramuros)",
  heure_depart: "08:00",
  heure_arrivee: "10:00",
  train_no: "6601",
  axe: "SUD EST",
  ...over,
});

describe("compact snapshot", () => {
  it("stores a service once and expands it back to one row per date", () => {
    const dates = Array.from({ length: 31 }, (_, i) => `2026-10-${String(i + 1).padStart(2, "0")}`);
    const rows = [
      ...dates.filter((_, i) => i % 3 !== 0).map((d) => row(d)),
      row("2026-10-05", { train_no: "6603", heure_depart: "09:00", heure_arrivee: "11:00", axe: undefined }),
    ];
    const c = encodeCompact(rows);
    expect(c.trains).toHaveLength(2);
    expect(c.stations).toEqual(["PARIS (intramuros)", "LYON (intramuros)"]);
    const back = decodeCompact(JSON.parse(JSON.stringify(c)));
    const key = (r: TimetableRow): string => JSON.stringify([r.date, r.train_no, r.heure_depart, r.axe ?? null]);
    expect(back.map(key).sort()).toEqual(rows.map(key).sort());
  });

  it("recognizes only the compact shape and skips malformed rows", () => {
    expect(isCompact([])).toBe(false);
    expect(isCompact(null)).toBe(false);
    const c = encodeCompact([row("2026-10-01")]);
    expect(isCompact(c)).toBe(true);
    c.trains.push([9, 9, "08:00", "09:00", "1", -1, "1"]);
    expect(decodeCompact(c)).toHaveLength(1);
  });
});

describe("Interrail profile", () => {
  const raw = (od: string, dest = "LYON (intramuros)"): RawRecord =>
    ({ ...row("2026-10-01", { destination: dest }), od_happy_card: od }) as RawRecord;

  it("counts every running train, with or without a MAX seat, international stops included", () => {
    const rows = [raw("NON"), raw("OUI"), raw("NON", "GENEVE")];
    expect(normalizeRecords(rows, INTERRAIL_PROFILE).map((x) => x.available)).toEqual([true, true, true]);
    expect(normalizeRecords(rows, SNCF_PROFILE).map((x) => x.available)).toEqual([false, true, false]);
    expect(INTERRAIL_PROFILE.seatKnown).toBe(false);
  });

  it("reads the compact snapshot file", () => {
    const decoded = INTERRAIL_PROFILE.decode?.(encodeCompact([row("2026-10-01"), row("2026-10-02")]));
    expect(decoded).toHaveLength(2);
    expect(INTERRAIL_PROFILE.decode?.([{ any: 1 }])).toBeNull();
  });

  it("picks the dataset from the pass", () => {
    expect(profileForCard("interrail")).toBe(INTERRAIL_PROFILE);
    expect(profileForCard("jeune")).toBe(SNCF_PROFILE);
    expect(profileForCard("senior")).toBe(SNCF_PROFILE);
    expect(parseCard("interrail")).toBe("interrail");
    expect(parseCard("bogus")).toBe("jeune");
  });

  it("keeps card=interrail through a link", () => {
    const q = queryFromParams(new URLSearchParams("mode=from&from=X&date=2026-10-05&card=interrail"), "2026-10-05");
    expect(q.card).toBe("interrail");
    expect(queryToParams(q).get("card")).toBe("interrail");
  });
});

describe("seat-unknown copy", () => {
  afterEach(() => setSeatUnknown(false));

  it("never claims a MAX seat when the pass's seat is unknown", () => {
    expect(t("res_none")).toContain("MAX");
    setSeatUnknown(true);
    expect(t("res_none")).not.toContain("MAX");
    expect(t("cal_legend")).not.toContain("MAX");
    // Keys without a variant are untouched.
    expect(t("card_senior")).toBe("MAX SENIOR");
  });
});

describe("train-api source", () => {
  const BASE = "https://api.test/v1";
  const compact = encodeCompact([row("2026-10-01"), row("2026-10-02")]);
  const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200 });
  const NOW = new Date("2026-10-01T15:00:00Z");

  afterEach(() => vi.unstubAllGlobals());

  it("reads a pass's trains from train-api, every one bookable", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", (url: string) => {
      urls.push(url);
      if (url === `${BASE}/sncf/max-jeune/all.json`) return Promise.resolve(json(compact));
      if (url === `${BASE}/index.json`) return Promise.resolve(json({ updatedAt: "2026-10-01T13:30:00Z" }));
      return Promise.resolve(new Response("", { status: 404 }));
    });
    const d = await loadDataset(SNCF_PROFILE, BASE, NOW);
    expect(d.apiBase).toBe(BASE);
    expect(d.trains).toHaveLength(2);
    expect(d.trains.every((t) => t.available)).toBe(true);
    expect(d.meta).toMatchObject({ updatedAt: "2026-10-01T13:30:00Z", source: "train-api", isSample: false });
    expect(urls.some((u) => u.includes("tgvmax.json"))).toBe(false);
  });

  it("falls back to the bundled snapshot when train-api is down", async () => {
    const snapshot = [{ ...row("2026-10-03"), od_happy_card: "OUI" }];
    vi.stubGlobal("fetch", (url: string) => {
      if (url.startsWith(BASE)) return Promise.reject(new Error("offline"));
      if (url.endsWith("tgvmax.json")) return Promise.resolve(json(snapshot));
      return Promise.resolve(new Response("", { status: 404 }));
    });
    const d = await loadDataset(SNCF_PROFILE, BASE, NOW);
    expect(d.apiBase).toBe("");
    expect(d.trains.map((t) => t.date)).toEqual(["2026-10-03"]);
  });

  it("asks Interrail's own file", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", (url: string) => {
      urls.push(url);
      return Promise.resolve(url.endsWith("all.json") ? json(compact) : json({}));
    });
    await loadDataset(INTERRAIL_PROFILE, BASE, NOW);
    expect(urls).toContain(`${BASE}/sncf/interrail/all.json`);
  });

  const stub = (updatedAt: string, snapshotUp: boolean): unknown =>
    vi.stubGlobal("fetch", (url: string) => {
      if (url === `${BASE}/sncf/max-jeune/all.json`) return Promise.resolve(json(compact));
      if (url === `${BASE}/index.json`) return Promise.resolve(json({ updatedAt }));
      if (snapshotUp && url.endsWith("tgvmax.json")) return Promise.resolve(json([{ ...row("2026-10-03"), od_happy_card: "OUI" }]));
      return Promise.reject(new Error("offline"));
    });

  it("prefers the snapshot when train-api has stopped refreshing", async () => {
    stub("2026-09-29T13:30:00Z", true);
    const d = await loadDataset(SNCF_PROFILE, BASE, NOW);
    expect(d.apiBase).toBe("");
    expect(d.trains.map((t) => t.date)).toEqual(["2026-10-03"]);
  });

  it("prefers the snapshot when every train-api date has passed", async () => {
    stub("2026-10-03T13:30:00Z", true);
    const d = await loadDataset(SNCF_PROFILE, BASE, new Date("2026-10-03T15:00:00Z"));
    expect(d.apiBase).toBe("");
  });

  it("keeps a stale train-api timetable over the sample when the snapshot is out of reach", async () => {
    stub("2026-09-29T13:30:00Z", false);
    const d = await loadDataset(SNCF_PROFILE, BASE, NOW);
    expect(d.apiBase).toBe(BASE);
    expect(d.meta.isSample).toBe(false);
    expect(d.trains).toHaveLength(2);
  });
});
