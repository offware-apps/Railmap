import { describe, it, expect } from "vitest";
import type { RawRecord, SearchQuery, Journey } from "../src/types";
import { odJourneyOptsFor } from "../src/core/queryOpts";
import { normalizeRecords, normalizeRecord } from "../src/data/dataset";
import type { DatasetProfile } from "../src/data/profile";
import { filterTrains } from "../src/core/search";
import { reachableDestinations, reachableOrigins } from "../src/core/destinations";
import { findJourneys, bestJourney, reachableJourneys, latestReturns } from "../src/core/connections";
import { availabilityCalendar, reachableCountCalendar } from "../src/core/calendar";
import { bestTripsAcrossWindow, stationsOnDate, reachableBest } from "../src/core/best";
import { getaways, getawayIdeas, getawaysAcrossWindow, reverseGetawayIdeas, stayCalendar } from "../src/core/getaways";
import { planTours, planTourInOrder, planTourGreedy } from "../src/core/tour";
import { haversineKm } from "../src/util/geo";
import sample from "../data/tgvmax.sample.json";

const trains = normalizeRecords(sample as RawRecord[]);

describe("normalizeRecord", () => {
  it("computes duration and handles trains crossing midnight", () => {
    const overnight = normalizeRecord({
      date: "2026-06-25",
      origine: "PARIS (intramuros)",
      destination: "TOULON",
      heure_depart: "23:00",
      heure_arrivee: "00:50",
      train_no: "6190",
      od_happy_card: "OUI",
    });
    expect(overnight).not.toBeNull();
    expect(overnight!.departMin).toBe(23 * 60);
    expect(overnight!.arriveMin).toBe(24 * 60 + 50); // +1 day
    expect(overnight!.durationMin).toBe(110);
    expect(overnight!.arrive).toBe("00:50");
  });

  it("maps od_happy_card to availability and drops invalid rows", () => {
    expect(normalizeRecord({ ...base(), od_happy_card: "OUI" })!.available).toBe(true);
    expect(normalizeRecord({ ...base(), od_happy_card: "NON" })!.available).toBe(false);
    expect(normalizeRecord({ ...base(), heure_depart: "" })).toBeNull();
  });

  it("marks non-bookable (international) endpoints as unavailable even when OUI", () => {
    // Paris -> Geneva shows OUI in the feed but isn't reservable with a MAX pass.
    expect(
      normalizeRecord({ ...base(), destination: "GENEVE", od_happy_card: "OUI" })!.available,
    ).toBe(false);
    expect(
      normalizeRecord({ ...base(), origine: "BRUXELLES MIDI", destination: "LILLE", od_happy_card: "OUI" })!
        .available,
    ).toBe(false);
    // A purely domestic OUI route stays bookable.
    expect(normalizeRecord({ ...base(), destination: "LYON (intramuros)", od_happy_card: "OUI" })!.available).toBe(true);
  });

  it("normalizes through a custom DatasetProfile — the data seam is source-agnostic", () => {
    // A made-up source with its OWN field names and its OWN 'bookable' rule. Proves
    // the core only depends on the normalized shape, so another operator (DB, Renfe…)
    // can be plugged in via a profile without touching the search code.
    const demo: DatasetProfile = {
      id: "demo",
      dataUrl: "/x",
      metaUrl: "/y",
      read: (r) => ({
        origin: r.from as string,
        destination: r.to as string,
        date: r.day as string,
        depart: r.dep as string,
        arrive: r.arr as string,
        trainNo: r.no as string,
        category: r.kind as string,
      }),
      isReservable: (r) => r.free === true,
      hubs: [],
      nonBookablePatterns: [],
      seatKnown: true,
    };
    const raw = { from: "ALPHA", to: "BETA", day: "2026-07-01", dep: "08:00", arr: "10:30", no: "Z9", kind: "ICE", free: true } as unknown as RawRecord;
    const t = normalizeRecord(raw, demo)!;
    expect(t.origin).toBe("ALPHA");
    expect(t.destination).toBe("BETA");
    expect(t.departMin).toBe(480);
    expect(t.arriveMin).toBe(630);
    expect(t.durationMin).toBe(150);
    expect(t.axe).toBe("ICE");
    expect(t.available).toBe(true); // the source's own rule said so
    // Its own rule can reject a record, and nonBookablePatterns still applies.
    expect(normalizeRecord({ ...raw, free: false } as unknown as RawRecord, demo)!.available).toBe(false);
  });
});

describe("reachableDestinations", () => {
  it("lists free-MAX destinations from Paris on 2026-06-25 and excludes NON-only routes", () => {
    const dests = reachableDestinations(trains, "PARIS (intramuros)", "2026-06-25").map(
      (g) => g.station,
    );
    expect(dests).toContain("LYON (intramuros)");
    expect(dests).toContain("MARSEILLE ST CHARLES");
    expect(dests).toContain("BORDEAUX ST JEAN");
    expect(dests).toContain("STRASBOURG");
    // Direct Paris->Toulouse is NON only that day, so it must NOT appear.
    expect(dests).not.toContain("TOULOUSE MATABIAU");
  });

  it("groups multiple trains per destination", () => {
    const lyon = reachableDestinations(trains, "PARIS (intramuros)", "2026-06-25").find(
      (g) => g.station === "LYON (intramuros)",
    );
    expect(lyon?.count).toBe(3); // 08:00, 14:00, 19:00
  });
});

describe("reachableOrigins (reverse search)", () => {
  it("finds origins that reach Paris on 2026-06-27", () => {
    const origins = reachableOrigins(trains, "PARIS (intramuros)", "2026-06-27").map(
      (g) => g.station,
    );
    expect(origins).toEqual(
      expect.arrayContaining(["LYON (intramuros)", "MARSEILLE ST CHARLES"]),
    );
  });
});

describe("filterTrains", () => {
  it("respects a departure-time window", () => {
    const after10 = filterTrains(trains, {
      origin: "PARIS (intramuros)",
      destination: "LYON (intramuros)",
      date: "2026-06-25",
      departAfter: "10:00",
    });
    expect(after10.map((t) => t.trainNo)).toEqual(["6605", "6609"]); // not the 08:00
  });

  it("respects a max-duration filter", () => {
    const short = filterTrains(trains, {
      origin: "PARIS (intramuros)",
      date: "2026-06-25",
      maxDurationMin: 180,
    });
    // Nice is 6h, must be excluded; Lyon (2h) included.
    expect(short.some((t) => t.destination === "NICE VILLE")).toBe(false);
    expect(short.some((t) => t.destination === "LYON (intramuros)")).toBe(true);
  });

  it("respects a max-arrival-time (arriveBefore) filter", () => {
    // Paris→Lyon on 2026-06-25 arrives 10:00 / 16:00 / 21:00. A 12:00 ceiling keeps
    // only the 08:00→10:00 train.
    const byNoon = filterTrains(trains, {
      origin: "PARIS (intramuros)",
      destination: "LYON (intramuros)",
      date: "2026-06-25",
      arriveBefore: "12:00",
    });
    expect(byNoon.map((t) => t.trainNo)).toEqual(["6601"]);
  });
});

describe("findJourneys (connections)", () => {
  it("finds a single-connection journey when no direct train exists", () => {
    const journeys = findJourneys(
      trains,
      "PARIS (intramuros)",
      "TOULOUSE MATABIAU",
      "2026-06-25",
    );
    expect(journeys.length).toBeGreaterThan(0);
    const j = journeys[0]!;
    expect(j.legs.length).toBe(2);
    expect(j.hub).toBe("BORDEAUX ST JEAN");
    expect(j.legs[0]!.trainNo).toBe("8401");
    expect(j.legs[1]!.trainNo).toBe("8551");
    expect(j.connectionMin).toBe(40);
  });

  it("returns direct AND connecting journeys when both exist", () => {
    const journeys = findJourneys(
      trains,
      "PARIS (intramuros)",
      "MARSEILLE ST CHARLES",
      "2026-06-25",
    );
    const direct = journeys.filter((j) => j.legs.length === 1);
    const connecting = journeys.filter((j) => j.legs.length === 2);
    expect(direct.length).toBeGreaterThan(0); // train 6101
    expect(connecting.some((j) => j.hub === "LYON (intramuros)")).toBe(true);
  });

  it("never builds a connection from an unavailable leg", () => {
    const journeys = findJourneys(
      trains,
      "PARIS (intramuros)",
      "MARSEILLE ST CHARLES",
      "2026-06-25",
    );
    for (const j of journeys) {
      for (const leg of j.legs) expect(leg.available).toBe(true);
    }
  });

  it("drops journeys that arrive after the arriveBefore ceiling", () => {
    // Direct Paris→Lyon trains arrive 10:00 / 16:00 / 21:00 on 2026-06-25.
    const byNoon = findJourneys(trains, "PARIS (intramuros)", "LYON (intramuros)", "2026-06-25", {
      arriveBefore: "12:00",
    });
    expect(byNoon.length).toBe(1);
    expect(byNoon[0]!.legs[0]!.trainNo).toBe("6601"); // the 08:00→10:00
  });
});

describe("availabilityCalendar", () => {
  it("marks each day available iff a free-MAX train exists", () => {
    const cal = availabilityCalendar(trains, "PARIS (intramuros)", "LYON (intramuros)", [
      "2026-06-25",
      "2026-06-26",
      "2026-06-27",
    ]);
    expect(cal.map((d) => d.available)).toEqual([true, true, false]);
    expect(cal.map((d) => d.count)).toEqual([3, 1, 0]);
  });

  it("applies the accept predicate so counts match a via-filtered list", () => {
    const dates = ["2026-06-25", "2026-06-26", "2026-06-27"];
    // Rejecting every journey zeroes the calendar — proves the filter is applied.
    const none = availabilityCalendar(
      trains,
      "PARIS (intramuros)",
      "LYON (intramuros)",
      dates,
      {},
      () => false,
    );
    expect(none.map((d) => d.count)).toEqual([0, 0, 0]);
    expect(none.every((d) => !d.available)).toBe(true);

    // Accept-all matches the unfiltered counts.
    const all = availabilityCalendar(trains, "PARIS (intramuros)", "LYON (intramuros)", dates, {}, () => true);
    expect(all.map((d) => d.count)).toEqual([3, 1, 0]);
  });
});

describe("odJourneyOptsFor (span-aware exact-route options)", () => {
  const q = (extra: Partial<SearchQuery> = {}): SearchQuery => ({
    mode: "od",
    date: "2026-06-25",
    card: "jeune",
    maxConnections: 1,
    ...extra,
  });
  // A journey that starts on the 25th and finishes on the 27th — a 3-day span.
  const wide = {
    date: "2026-06-25",
    hubs: ["BORDEAUX ST JEAN"],
    legs: [{ date: "2026-06-25", arriveMin: 600 }, { date: "2026-06-27", arriveMin: 600 }],
  } as unknown as Journey;

  it("only widens the day pool for a span BEYOND the default 2 days", () => {
    expect(odJourneyOptsFor(q(), "A", "B").journeyOpts.spanDays).toBeUndefined();
    expect(odJourneyOptsFor(q({ maxSpanDays: 2 }), "A", "B").journeyOpts.spanDays).toBeUndefined();
    expect(odJourneyOptsFor(q({ maxSpanDays: 5 }), "A", "B").journeyOpts.spanDays).toBe(5);
  });

  it("caps a journey's total span, so a calendar day can't be greener than its list", () => {
    // No cap → kept; a 2-day cap → dropped, the same verdict the results list reaches.
    expect(odJourneyOptsFor(q(), "A", "B").accept(wide)).toBe(true);
    expect(odJourneyOptsFor(q({ maxSpanDays: 2 }), "A", "B").accept(wide)).toBe(false);
    expect(odJourneyOptsFor(q({ maxSpanDays: 3 }), "A", "B").accept(wide)).toBe(true);
  });

  it("still enforces the via hub alongside the span cap", () => {
    const viaMissing = odJourneyOptsFor(q({ via: "LYON (intramuros)", maxSpanDays: 5 }), "A", "B");
    expect(viaMissing.accept(wide)).toBe(false); // hubs don't include Lyon
    const viaHit = odJourneyOptsFor(q({ via: "BORDEAUX ST JEAN", maxSpanDays: 5 }), "A", "B");
    expect(viaHit.accept(wide)).toBe(true);
  });
});

describe("reachableCountCalendar dir:'to' (destination-only browse-by-arrival)", () => {
  it("counts the origins that can reach a destination each day — never an empty grid when arrivals exist", () => {
    const dates = ["2026-06-25", "2026-06-26", "2026-06-27"];
    const cal = reachableCountCalendar(trains, "LYON (intramuros)", dates, {}, "to");
    // On a day PARIS -> LYON runs, at least one origin reaches LYON, so the day is available.
    const d25 = cal.find((d) => d.date === "2026-06-25")!;
    expect(d25.available).toBe(true);
    expect(d25.count).toBeGreaterThanOrEqual(1);
    // Every available day carries a positive origin count (the fix: a populated calendar).
    for (const d of cal) expect(d.available).toBe(d.count > 0);
  });

  it("mirrors reachableCountCalendar: reachable-into a hub is symmetric to reachable-from it", () => {
    const dates = ["2026-06-25", "2026-06-26"];
    const into = reachableCountCalendar(trains, "PARIS (intramuros)", dates, {}, "to");
    const from = reachableCountCalendar(trains, "PARIS (intramuros)", dates, {}, "from");
    // Both are non-empty for a hub — the destination-only calendar is as alive as origin-only.
    expect(into.some((d) => d.available)).toBe(true);
    expect(from.some((d) => d.available)).toBe(true);
  });
});

describe("reachableBest dir:'from' (single-day ideas)", () => {
  it("ranks reachable destinations by shortest total time, including connection-only ones", () => {
    const trips = reachableBest(
      trains,
      "PARIS (intramuros)",
      "2026-06-25",
      stationsOnDate(trains, "2026-06-25"),
      { maxConnections: 1 },
      "from",
    );
    expect(trips.length).toBeGreaterThan(0);
    expect(trips[0]!.station).toBe("LILLE"); // 1h02 — the shortest hop
    for (let i = 1; i < trips.length; i++) {
      expect(trips[i]!.journey.totalDurationMin).toBeGreaterThanOrEqual(
        trips[i - 1]!.journey.totalDurationMin,
      );
    }
    const toulouse = trips.find((tr) => tr.station === "TOULOUSE MATABIAU");
    expect(toulouse).toBeDefined();
    expect(toulouse!.journey.legs.length).toBe(2); // only reachable via a change
  });
});

describe("bestTripsAcrossWindow (ideas, all days)", () => {
  it("unions destinations across the window, once each, fastest-first", () => {
    const dates = ["2026-06-25", "2026-06-26", "2026-06-27"];
    const all = bestTripsAcrossWindow(trains, "PARIS (intramuros)", dates, { maxConnections: 1 });
    // Direct destinations from Paris across the window, once each, fastest-first.
    expect(all.length).toBeGreaterThan(0);
    const labels = all.map((t) => t.destination);
    expect(new Set(labels).size).toBe(labels.length); // no destination twice
    for (let i = 1; i < all.length; i++) {
      expect(all[i]!.journey.totalDurationMin).toBeGreaterThanOrEqual(all[i - 1]!.journey.totalDurationMin);
    }
    // A destination that only runs on a later sample day is still listed, dated to
    // a day it actually runs.
    const lyon = all.find((t) => t.destination === "LYON (intramuros)");
    expect(lyon).toBeDefined();
    expect(dates).toContain(lyon!.journey.date);
  });

  it("keeps the fastest journey across the window, not the earliest day's slow detour", () => {
    // CHALON's only day-1 path is a slow overnight detour via the LYON hub; day 2
    // has a quick direct PARIS -> CHALON. The ideas row must headline the fast
    // trip (like opening the route would), not the earliest day's 24h detour.
    const fixture = normalizeRecords([
      // Day 1: PARIS -> LYON, then an overnight wait before LYON -> CHALON on day 2.
      { date: "2026-09-01", origine: "PARIS (intramuros)", destination: "LYON (intramuros)", heure_depart: "08:00", heure_arrivee: "09:30", train_no: "A1", od_happy_card: "OUI" },
      { date: "2026-09-02", origine: "LYON (intramuros)", destination: "CHALON", heure_depart: "07:00", heure_arrivee: "07:40", train_no: "A2", od_happy_card: "OUI" },
      // Day 2: a quick direct PARIS -> CHALON.
      { date: "2026-09-02", origine: "PARIS (intramuros)", destination: "CHALON", heure_depart: "10:00", heure_arrivee: "11:00", train_no: "B1", od_happy_card: "OUI" },
    ] as RawRecord[]);
    const dates = ["2026-09-01", "2026-09-02"];
    // Overnight layovers allowed (as in the night-train scenario), so the slow
    // day-1 detour is a valid candidate the old "earliest day" code would keep.
    const all = bestTripsAcrossWindow(fixture, "PARIS (intramuros)", dates, {
      maxConnections: 1,
      maxConnectionMin: 2000,
    });
    const chalon = all.find((t) => t.destination === "CHALON");
    expect(chalon).toBeDefined();
    expect(chalon!.journey.legs).toHaveLength(1); // the direct hop, not the via-Lyon detour
    expect(chalon!.journey.totalDurationMin).toBe(60);
    expect(chalon!.days).toBe(2); // still counted as reachable on both days
  });
});

describe("reachableBest (one-pass browse reachability)", () => {
  // The browse "via" list used to run a per-candidate graph search (O(stations) DFS
  // calls — seconds on a busy hub). It now does ONE multi-target sweep per direction.
  // These lock in that the sweep returns exactly what the per-candidate search did.
  const date = "2026-06-25";
  const opts = { maxConnections: 1 };
  const cands = stationsOnDate(trains, date);

  it("matches per-candidate bestJourney for dir=from", () => {
    const got = new Map(
      reachableBest(trains, "PARIS (intramuros)", date, cands, opts, "from").map((r) => [r.station, r.journey.totalDurationMin]),
    );
    for (const s of cands) {
      if (s === "PARIS (intramuros)") continue;
      const bj = bestJourney(trains, "PARIS (intramuros)", s, date, opts);
      if (bj) expect(got.get(s)).toBe(bj.totalDurationMin);
      else expect(got.has(s)).toBe(false);
    }
  });

  it("matches per-candidate bestJourney for dir=to (reverse sweep)", () => {
    const got = new Map(
      reachableBest(trains, "PARIS (intramuros)", date, cands, opts, "to").map((r) => [r.station, r.journey.totalDurationMin]),
    );
    for (const s of cands) {
      if (s === "PARIS (intramuros)") continue;
      const bj = bestJourney(trains, s, "PARIS (intramuros)", date, opts);
      if (bj) expect(got.get(s)).toBe(bj.totalDurationMin);
      else expect(got.has(s)).toBe(false);
    }
  });
});

describe("findJourneys multi-hop (2 changes)", () => {
  const twoHop = normalizeRecords([
    { date: "2026-07-01", origine: "NANTES", destination: "PARIS (intramuros)", heure_depart: "08:00", heure_arrivee: "10:00", train_no: "1", od_happy_card: "OUI" },
    { date: "2026-07-01", origine: "PARIS (intramuros)", destination: "LYON (intramuros)", heure_depart: "10:30", heure_arrivee: "12:30", train_no: "2", od_happy_card: "OUI" },
    { date: "2026-07-01", origine: "LYON (intramuros)", destination: "MARSEILLE ST CHARLES", heure_depart: "13:00", heure_arrivee: "14:40", train_no: "3", od_happy_card: "OUI" },
  ] as RawRecord[]);

  it("needs two changes: nothing at maxConnections<=1, a 3-leg journey at 2", () => {
    expect(
      findJourneys(twoHop, "NANTES", "MARSEILLE ST CHARLES", "2026-07-01", { maxConnections: 1 }),
    ).toHaveLength(0);
    const two = findJourneys(twoHop, "NANTES", "MARSEILLE ST CHARLES", "2026-07-01", {
      maxConnections: 2,
    });
    expect(two).toHaveLength(1);
    const j = two[0]!;
    expect(j.legs.map((l) => l.trainNo)).toEqual(["1", "2", "3"]);
    expect(j.hubs).toEqual(["PARIS (intramuros)", "LYON (intramuros)"]);
    expect(j.layovers).toEqual([30, 30]);
  });
});

describe("findJourneys across midnight", () => {
  const overnight = normalizeRecords([
    { date: "2026-08-01", origine: "NANTES", destination: "LYON (intramuros)", heure_depart: "23:00", heure_arrivee: "00:30", train_no: "T1", od_happy_card: "OUI" },
    { date: "2026-08-02", origine: "LYON (intramuros)", destination: "MARSEILLE ST CHARLES", heure_depart: "01:00", heure_arrivee: "02:00", train_no: "T2", od_happy_card: "OUI" },
  ] as RawRecord[]);

  it("pairs a leg arriving after midnight with an early next-day leg", () => {
    const js = findJourneys(overnight, "NANTES", "MARSEILLE ST CHARLES", "2026-08-01", {
      maxConnections: 1,
    });
    expect(js).toHaveLength(1);
    expect(js[0]!.legs.map((l) => l.trainNo)).toEqual(["T1", "T2"]);
    expect(js[0]!.layovers).toEqual([30]); // 00:30 -> 01:00 next day
    expect(js[0]!.totalDurationMin).toBe(180); // 23:00 -> 02:00 (+1 day)
  });
});

describe("onlyNight (sleep aboard)", () => {
  const mixed = normalizeRecords([
    // A day train and a real sleeper (IC NUIT, departs 22:30, arrives 06:00+1) to LYON.
    // A late non-sleeper (22:30 but a regular axe) must NOT count as a night train.
    { date: "2026-08-01", origine: "PARIS (intramuros)", destination: "LYON (intramuros)", heure_depart: "10:00", heure_arrivee: "12:00", train_no: "DAY", od_happy_card: "OUI", axe: "SUD EST" },
    { date: "2026-08-01", origine: "PARIS (intramuros)", destination: "LYON (intramuros)", heure_depart: "22:30", heure_arrivee: "06:00", train_no: "NIGHT", od_happy_card: "OUI", axe: "IC NUIT" },
    // A next-morning day hop onward, reachable after stepping off the sleeper.
    { date: "2026-08-02", origine: "LYON (intramuros)", destination: "MARSEILLE ST CHARLES", heure_depart: "08:00", heure_arrivee: "09:00", train_no: "DAY2", od_happy_card: "OUI", axe: "SUD EST" },
  ] as RawRecord[]);

  it("keeps only journeys that include a night leg", () => {
    const all = findJourneys(mixed, "PARIS (intramuros)", "LYON (intramuros)", "2026-08-01", { maxConnections: 0 });
    expect(all.map((j) => j.legs[0]!.trainNo).sort()).toEqual(["DAY", "NIGHT"]);
    const night = findJourneys(mixed, "PARIS (intramuros)", "LYON (intramuros)", "2026-08-01", {
      maxConnections: 0,
      onlyNight: true,
    });
    expect(night.map((j) => j.legs[0]!.trainNo)).toEqual(["NIGHT"]);
  });

  it("requires the LAST leg to be a sleeper (arrive asleep)", () => {
    const reach = reachableJourneys(mixed, "PARIS (intramuros)", "2026-08-01", {
      maxConnections: 1,
      onlyNight: true,
    });
    // LYON is reachable directly by the sleeper.
    expect(reach.get("LYON (intramuros)")!.legs[0]!.trainNo).toBe("NIGHT");
    // MARSEILLE arrives on a DAY hop after the sleeper, so it doesn't qualify.
    expect(reach.get("MARSEILLE ST CHARLES")).toBeUndefined();
  });

  it("accepts a day hop to a hub then the sleeper in (last leg is the sleeper)", () => {
    const lastLeg = normalizeRecords([
      // Day to the LYON hub, then a sleeper onward to NICE → arrives on a sleeper.
      { date: "2026-08-01", origine: "PARIS (intramuros)", destination: "LYON (intramuros)", heure_depart: "18:00", heure_arrivee: "20:00", train_no: "PD", od_happy_card: "OUI", axe: "SUD EST" },
      { date: "2026-08-01", origine: "LYON (intramuros)", destination: "NICE VILLE", heure_depart: "21:00", heure_arrivee: "06:00", train_no: "LN", od_happy_card: "OUI", axe: "IC NUIT" },
      // Sleeper to the hub, then a day hop onward → arrives on a day train.
      { date: "2026-08-01", origine: "PARIS (intramuros)", destination: "LYON (intramuros)", heure_depart: "22:00", heure_arrivee: "06:00", train_no: "PN", od_happy_card: "OUI", axe: "IC NUIT" },
      { date: "2026-08-02", origine: "LYON (intramuros)", destination: "MARSEILLE ST CHARLES", heure_depart: "07:00", heure_arrivee: "08:00", train_no: "LM", od_happy_card: "OUI", axe: "SUD EST" },
    ] as RawRecord[]);
    const toNice = findJourneys(lastLeg, "PARIS (intramuros)", "NICE VILLE", "2026-08-01", { maxConnections: 1, onlyNight: true });
    expect(toNice.map((j) => j.legs.map((l) => l.trainNo))).toEqual([["PD", "LN"]]); // day then sleeper in
    const toMars = findJourneys(lastLeg, "PARIS (intramuros)", "MARSEILLE ST CHARLES", "2026-08-01", { maxConnections: 1, onlyNight: true });
    expect(toMars).toHaveLength(0); // sleeper then a day hop → not arriving on a sleeper
  });

  it("drops a destination reachable only by day trains", () => {
    const dayOnly = normalizeRecords([
      { date: "2026-08-01", origine: "PARIS (intramuros)", destination: "TOURS", heure_depart: "09:00", heure_arrivee: "10:00", train_no: "D", od_happy_card: "OUI" },
    ] as RawRecord[]);
    expect(
      findJourneys(dayOnly, "PARIS (intramuros)", "TOURS", "2026-08-01", { maxConnections: 0, onlyNight: true }),
    ).toHaveLength(0);
  });
});

describe("reachableJourneys (multi-target)", () => {
  it("finds every destination — direct and connection-only — in one pass", () => {
    const r = reachableJourneys(trains, "PARIS (intramuros)", "2026-06-25", { maxConnections: 1 });
    expect(r.size).toBeGreaterThan(0);
    expect(r.has("LILLE")).toBe(true); // direct
    const tlse = r.get("TOULOUSE MATABIAU");
    expect(tlse).toBeDefined();
    expect(tlse!.legs.length).toBe(2); // only reachable via a change
    // The best journey it records matches a per-destination lookup.
    const direct = bestJourney(trains, "PARIS (intramuros)", "LILLE", "2026-06-25", { maxConnections: 1 });
    expect(r.get("LILLE")!.totalDurationMin).toBe(direct!.totalDurationMin);
  });

  it("earliestArrival keeps the soonest-arriving journey, not the fastest", () => {
    const data = normalizeRecords([
      { date: "2026-07-01", origine: "PARIS (intramuros)", destination: "LYON (intramuros)", heure_depart: "06:00", heure_arrivee: "09:00", train_no: "EARLY", od_happy_card: "OUI" },
      { date: "2026-07-01", origine: "PARIS (intramuros)", destination: "LYON (intramuros)", heure_depart: "08:00", heure_arrivee: "10:00", train_no: "FAST", od_happy_card: "OUI" },
    ] as RawRecord[]);
    const fastest = reachableJourneys(data, "PARIS (intramuros)", "2026-07-01", { maxConnections: 0 });
    expect(fastest.get("LYON (intramuros)")!.legs[0]!.trainNo).toBe("FAST"); // 2 h beats 3 h
    const soonest = reachableJourneys(data, "PARIS (intramuros)", "2026-07-01", { maxConnections: 0, earliestArrival: true });
    expect(soonest.get("LYON (intramuros)")!.legs[0]!.trainNo).toBe("EARLY"); // arrives 09:00
  });

  it("is pinned to the first-leg date — a flex-day-only route needs that day searched", () => {
    // NICE only runs on 02-Jul. A tour starting 01-Jul with flexibility must search
    // 02-Jul too (grow's candidate generation unions reachableJourneys over the flex
    // window); querying only 01-Jul would never propose NICE.
    const data = normalizeRecords([
      { date: "2026-07-01", origine: "PARIS (intramuros)", destination: "LYON (intramuros)", heure_depart: "08:00", heure_arrivee: "10:00", train_no: "A", od_happy_card: "OUI" },
      { date: "2026-07-02", origine: "PARIS (intramuros)", destination: "NICE VILLE", heure_depart: "09:00", heure_arrivee: "14:00", train_no: "B", od_happy_card: "OUI" },
    ] as RawRecord[]);
    const day1 = reachableJourneys(data, "PARIS (intramuros)", "2026-07-01", { maxConnections: 1 });
    expect(day1.has("NICE VILLE")).toBe(false); // nothing leaves PARIS for NICE on 01-Jul
    const day2 = reachableJourneys(data, "PARIS (intramuros)", "2026-07-02", { maxConnections: 1 });
    expect(day2.has("NICE VILLE")).toBe(true); // searching the flex day surfaces it
  });

  it("onlyNight + a change finds a destination reachable only via a connecting sleeper", () => {
    // A day train to the LYON hub, then an IC NUIT sleeper on to BRIANCON. Direct-only
    // can never reach BRIANCON (no sleeper leaves PARIS for it) — the tour grow used to
    // propose only direct hops and so would say "nothing to add".
    const data = normalizeRecords([
      { date: "2026-07-01", origine: "PARIS (intramuros)", destination: "LYON (intramuros)", heure_depart: "14:00", heure_arrivee: "16:00", train_no: "DAY", od_happy_card: "OUI", axe: "SUD EST" },
      { date: "2026-07-01", origine: "LYON (intramuros)", destination: "BRIANCON", heure_depart: "19:30", heure_arrivee: "07:00", train_no: "SLEEPER", od_happy_card: "OUI", axe: "IC NUIT" },
    ] as RawRecord[]);
    const direct = reachableJourneys(data, "PARIS (intramuros)", "2026-07-01", { maxConnections: 0, onlyNight: true });
    expect(direct.has("BRIANCON")).toBe(false); // no direct sleeper from PARIS
    const viaHub = reachableJourneys(data, "PARIS (intramuros)", "2026-07-01", { maxConnections: 1, onlyNight: true });
    const briancon = viaHub.get("BRIANCON");
    expect(briancon).toBeDefined();
    expect(briancon!.legs.map((l) => l.trainNo)).toEqual(["DAY", "SLEEPER"]); // arrives on the sleeper
  });
});

describe("excludeNight", () => {
  const data = normalizeRecords([
    { date: "2026-07-01", origine: "PARIS (intramuros)", destination: "LYON (intramuros)", heure_depart: "08:00", heure_arrivee: "10:00", train_no: "day", od_happy_card: "OUI", axe: "SUD EST" },
    // A real sleeper (IC NUIT) — and a late non-sleeper that must NOT be dropped.
    { date: "2026-07-01", origine: "PARIS (intramuros)", destination: "LYON (intramuros)", heure_depart: "23:00", heure_arrivee: "07:00", train_no: "sleeper", od_happy_card: "OUI", axe: "IC NUIT" },
    { date: "2026-07-01", origine: "PARIS (intramuros)", destination: "LYON (intramuros)", heure_depart: "22:30", heure_arrivee: "23:55", train_no: "late", od_happy_card: "OUI", axe: "SUD EST" },
  ] as RawRecord[]);

  it("drops only real sleeper (IC NUIT) trains, not ordinary late ones", () => {
    const all = findJourneys(data, "PARIS (intramuros)", "LYON (intramuros)", "2026-07-01", { maxConnections: 0 });
    expect(all).toHaveLength(3);
    const noNight = findJourneys(data, "PARIS (intramuros)", "LYON (intramuros)", "2026-07-01", {
      maxConnections: 0,
      excludeNight: true,
    });
    // The sleeper is dropped; the day train and the late (non-sleeper) train remain.
    expect(noNight.map((j) => j.legs[0]!.trainNo).sort()).toEqual(["day", "late"]);
  });
});

describe("minDurationMin (exclude short hops)", () => {
  const data = normalizeRecords([
    { date: "2026-07-01", origine: "PARIS (intramuros)", destination: "LILLE", heure_depart: "08:00", heure_arrivee: "09:00", train_no: "short", od_happy_card: "OUI" },
    { date: "2026-07-01", origine: "PARIS (intramuros)", destination: "TOULON", heure_depart: "08:00", heure_arrivee: "13:00", train_no: "long", od_happy_card: "OUI" },
  ] as RawRecord[]);

  it("drops journeys shorter than the floor", () => {
    const lille = findJourneys(data, "PARIS (intramuros)", "LILLE", "2026-07-01", { maxConnections: 0, minDurationMin: 180 });
    expect(lille).toHaveLength(0); // the 1 h hop is below 3 h
    const toulon = findJourneys(data, "PARIS (intramuros)", "TOULON", "2026-07-01", { maxConnections: 0, minDurationMin: 180 });
    expect(toulon).toHaveLength(1); // the 5 h trip clears the floor
  });

  it("reachableJourneys honours the floor too (so tour grow doesn't propose rejected hops)", () => {
    const r = reachableJourneys(data, "PARIS (intramuros)", "2026-07-01", { maxConnections: 0, minDurationMin: 180 });
    expect(r.has("LILLE")).toBe(false); // the 1 h hop is below the floor
    expect(r.has("TOULON")).toBe(true); // the 5 h trip clears it
  });
});

describe("findJourneys multi-day span", () => {
  // Paris→Lyon runs day 1; Lyon→Marseille only runs three days later. Reaching
  // Marseille means a multi-day stopover at the Lyon hub.
  const spaced = normalizeRecords([
    { date: "2026-07-01", origine: "PARIS (intramuros)", destination: "LYON (intramuros)", heure_depart: "08:00", heure_arrivee: "10:00", train_no: "A", od_happy_card: "OUI" },
    { date: "2026-07-04", origine: "LYON (intramuros)", destination: "MARSEILLE ST CHARLES", heure_depart: "09:00", heure_arrivee: "11:00", train_no: "B", od_happy_card: "OUI" },
  ] as RawRecord[]);
  const opts = { maxConnections: 1, hubs: ["LYON (intramuros)"] };

  it("finds nothing across the default 2-day pool", () => {
    expect(findJourneys(spaced, "PARIS (intramuros)", "MARSEILLE ST CHARLES", "2026-07-01", opts)).toHaveLength(0);
  });

  it("chains a multi-day stopover when the span is wide enough", () => {
    const js = findJourneys(spaced, "PARIS (intramuros)", "MARSEILLE ST CHARLES", "2026-07-01", {
      ...opts,
      spanDays: 5,
    });
    expect(js).toHaveLength(1);
    expect(js[0]!.legs.map((l) => l.trainNo)).toEqual(["A", "B"]);
    expect(js[0]!.legs[1]!.date).toBe("2026-07-04"); // continues after the stopover
  });
});

describe("planTours", () => {
  const data = normalizeRecords([
    { date: "2026-07-01", origine: "PARIS (intramuros)", destination: "LYON (intramuros)", heure_depart: "08:00", heure_arrivee: "10:00", train_no: "10", od_happy_card: "OUI" },
    { date: "2026-07-02", origine: "LYON (intramuros)", destination: "MARSEILLE ST CHARLES", heure_depart: "09:00", heure_arrivee: "10:40", train_no: "11", od_happy_card: "OUI" },
  ] as RawRecord[]);

  it("orders the cities so each day's hop has a free-MAX train", () => {
    const tours = planTours(
      data,
      "PARIS (intramuros)",
      ["MARSEILLE ST CHARLES", "LYON (intramuros)"],
      "2026-07-01",
      { maxConnections: 0 },
    );
    expect(tours).toHaveLength(1);
    expect(tours[0]!.order).toEqual(["LYON (intramuros)", "MARSEILLE ST CHARLES"]);
    expect(tours[0]!.legs).toHaveLength(2);
  });

  it("allows a flexible departure: the first hop may leave a few days later", () => {
    // The Paris→Lyon train only runs on 07-03, but the user asked to start 07-01.
    const late = normalizeRecords([
      { date: "2026-07-03", origine: "PARIS (intramuros)", destination: "LYON (intramuros)", heure_depart: "08:00", heure_arrivee: "10:00", train_no: "10", od_happy_card: "OUI" },
      { date: "2026-07-04", origine: "LYON (intramuros)", destination: "MARSEILLE ST CHARLES", heure_depart: "09:00", heure_arrivee: "10:40", train_no: "11", od_happy_card: "OUI" },
    ] as RawRecord[]);
    const cities = ["LYON (intramuros)", "MARSEILLE ST CHARLES"];
    const opts = { maxConnections: 0 };
    // No flex: nothing leaves 07-01, so the tour is infeasible.
    expect(planTours(late, "PARIS (intramuros)", cities, "2026-07-01", opts, 10, 1, 1)).toHaveLength(0);
    // startFlex=3: the departure may slip to 07-03 -> the tour plans.
    const flexed = planTours(late, "PARIS (intramuros)", cities, "2026-07-01", opts, 10, 1, 1, undefined, undefined, undefined, undefined, undefined, 3);
    expect(flexed).toHaveLength(1);
    expect(flexed[0]!.legs[0]!.date).toBe("2026-07-03");
  });

  it("flexibility is symmetric: the first hop may also leave BEFORE the chosen date", () => {
    // Paris→Lyon only runs 06-29, but the user picked 07-01.
    const early = normalizeRecords([
      { date: "2026-06-29", origine: "PARIS (intramuros)", destination: "LYON (intramuros)", heure_depart: "08:00", heure_arrivee: "10:00", train_no: "10", od_happy_card: "OUI" },
      { date: "2026-06-30", origine: "LYON (intramuros)", destination: "MARSEILLE ST CHARLES", heure_depart: "09:00", heure_arrivee: "10:40", train_no: "11", od_happy_card: "OUI" },
    ] as RawRecord[]);
    const cities = ["LYON (intramuros)", "MARSEILLE ST CHARLES"];
    const opts = { maxConnections: 0 };
    // No flex: nothing leaves 07-01, so the tour is infeasible.
    expect(planTours(early, "PARIS (intramuros)", cities, "2026-07-01", opts, 10, 1, 1)).toHaveLength(0);
    // startFlex=3 (symmetric): the departure may slip back to 06-29 -> the tour plans.
    const flexed = planTours(early, "PARIS (intramuros)", cities, "2026-07-01", opts, 10, 1, 1, undefined, undefined, undefined, undefined, undefined, 3);
    expect(flexed).toHaveLength(1);
    expect(flexed[0]!.legs[0]!.date).toBe("2026-06-29");
    // The booking floor (earliestStart) blocks starting before it: with a 06-30 floor,
    // the only first leg (06-29) is out of range, so the tour is infeasible again.
    expect(
      planTours(early, "PARIS (intramuros)", cities, "2026-07-01", opts, 10, 1, 1, undefined, undefined, undefined, undefined, undefined, 3, "2026-06-30"),
    ).toHaveLength(0);
  });

  it("searches the min/max day window for each hop (multi-day plan)", () => {
    // Second hop only runs 2 days after arriving in Lyon.
    const spaced = normalizeRecords([
      { date: "2026-07-01", origine: "PARIS (intramuros)", destination: "LYON (intramuros)", heure_depart: "08:00", heure_arrivee: "10:00", train_no: "10", od_happy_card: "OUI" },
      { date: "2026-07-03", origine: "LYON (intramuros)", destination: "MARSEILLE ST CHARLES", heure_depart: "09:00", heure_arrivee: "10:40", train_no: "11", od_happy_card: "OUI" },
    ] as RawRecord[]);
    const cities = ["LYON (intramuros)", "MARSEILLE ST CHARLES"];
    const opts = { maxConnections: 0 };
    // min=max=1: the second hop would need 2026-07-02 — no train, infeasible.
    expect(planTours(spaced, "PARIS (intramuros)", cities, "2026-07-01", opts, 10, 1, 1)).toHaveLength(0);
    // min=2,max=2: exactly 2026-07-03 — feasible.
    expect(planTours(spaced, "PARIS (intramuros)", cities, "2026-07-01", opts, 10, 2, 2)).toHaveLength(1);
    // min=1,max=3: the window [07-02..07-04] includes 07-03 — feasible.
    const tours = planTours(spaced, "PARIS (intramuros)", cities, "2026-07-01", opts, 10, 1, 3);
    expect(tours).toHaveLength(1);
    expect(tours[0]!.legs[1]!.date).toBe("2026-07-03");
  });
});

describe("planTourInOrder", () => {
  const chain = normalizeRecords([
    { date: "2026-07-01", origine: "PARIS (intramuros)", destination: "LYON (intramuros)", heure_depart: "08:00", heure_arrivee: "10:00", train_no: "10", od_happy_card: "OUI" },
    { date: "2026-07-02", origine: "LYON (intramuros)", destination: "MARSEILLE ST CHARLES", heure_depart: "09:00", heure_arrivee: "10:40", train_no: "11", od_happy_card: "OUI" },
    { date: "2026-07-03", origine: "MARSEILLE ST CHARLES", destination: "NICE VILLE", heure_depart: "09:00", heure_arrivee: "11:30", train_no: "12", od_happy_card: "OUI" },
  ] as RawRecord[]);
  const opts = { maxConnections: 0 };

  it("keeps the given visit order (no reshuffling) and chains every hop", () => {
    const tour = planTourInOrder(
      chain,
      "PARIS (intramuros)",
      ["LYON (intramuros)", "MARSEILLE ST CHARLES", "NICE VILLE"],
      "2026-07-01",
      opts,
      1,
      1,
    );
    expect(tour).not.toBeNull();
    expect(tour!.order).toEqual(["LYON (intramuros)", "MARSEILLE ST CHARLES", "NICE VILLE"]);
    expect(tour!.legs).toHaveLength(3);
    // A bad order (reversed) has no feasible first hop -> null, proving no reordering.
    expect(
      planTourInOrder(chain, "PARIS (intramuros)", ["NICE VILLE", "LYON (intramuros)"], "2026-07-01", opts, 1, 1),
    ).toBeNull();
  });

  it("drops the start and duplicate cities (never loops back)", () => {
    const tour = planTourInOrder(
      chain,
      "PARIS (intramuros)",
      ["LYON (intramuros)", "LYON (intramuros)", "PARIS (intramuros)", "MARSEILLE ST CHARLES"],
      "2026-07-01",
      opts,
      1,
      1,
    );
    expect(tour!.order).toEqual(["LYON (intramuros)", "MARSEILLE ST CHARLES"]);
  });

  it("plans tours larger than the 5-city permutation cap", () => {
    const seq = ["A", "B", "C", "D", "E", "F", "G"];
    const rows = seq.map((to, i) => ({
      date: `2026-07-0${i + 1}`,
      origine: i === 0 ? "START" : seq[i - 1]!,
      destination: to,
      heure_depart: "08:00",
      heure_arrivee: "10:00",
      train_no: String(i),
      od_happy_card: "OUI",
    }));
    const data = normalizeRecords(rows as RawRecord[]);
    expect(planTours(data, "START", seq, "2026-07-01", { maxConnections: 0 }, 10, 1, 1)).toHaveLength(0); // >5: permuter bails
    const tour = planTourInOrder(data, "START", seq, "2026-07-01", { maxConnections: 0 }, 1, 1);
    expect(tour).not.toBeNull();
    expect(tour!.legs).toHaveLength(7);
  });
});

describe("tour with a fixed end (from → nomad → destination)", () => {
  // PARIS -> LYON -> MARSEILLE, and MARSEILLE -> PARIS (so a loop is feasible).
  const data = normalizeRecords([
    { date: "2026-07-01", origine: "PARIS (intramuros)", destination: "LYON (intramuros)", heure_depart: "08:00", heure_arrivee: "10:00", train_no: "10", od_happy_card: "OUI" },
    { date: "2026-07-02", origine: "LYON (intramuros)", destination: "MARSEILLE ST CHARLES", heure_depart: "09:00", heure_arrivee: "10:40", train_no: "11", od_happy_card: "OUI" },
    { date: "2026-07-03", origine: "MARSEILLE ST CHARLES", destination: "PARIS (intramuros)", heure_depart: "09:00", heure_arrivee: "12:10", train_no: "12", od_happy_card: "OUI" },
  ] as RawRecord[]);
  const opts = { maxConnections: 0 };

  it("ends at the chosen destination after the nomad stops", () => {
    const tours = planTours(data, "PARIS (intramuros)", ["LYON (intramuros)"], "2026-07-01", opts, 10, 1, 1, undefined, undefined, undefined, "MARSEILLE ST CHARLES");
    expect(tours).toHaveLength(1);
    expect(tours[0]!.order).toEqual(["LYON (intramuros)", "MARSEILLE ST CHARLES"]);
    expect(tours[0]!.legs).toHaveLength(2);
  });

  it("loops back to the start when end === start", () => {
    const tour = planTourInOrder(data, "PARIS (intramuros)", ["LYON (intramuros)", "MARSEILLE ST CHARLES"], "2026-07-01", opts, 1, 1, undefined, undefined, undefined, "PARIS (intramuros)");
    expect(tour).not.toBeNull();
    expect(tour!.order).toEqual(["LYON (intramuros)", "MARSEILLE ST CHARLES", "PARIS (intramuros)"]);
    expect(tour!.legs[tour!.legs.length - 1]!.destination).toBe("PARIS (intramuros)");
  });

  it("greedy honours a fixed end too", () => {
    const tour = planTourGreedy(data, "PARIS (intramuros)", ["LYON (intramuros)"], "2026-07-01", opts, 1, 1, undefined, undefined, undefined, "MARSEILLE ST CHARLES");
    expect(tour!.order[tour!.order.length - 1]).toBe("MARSEILLE ST CHARLES");
  });

  it("rejects a tour that can't finish by the end date", () => {
    const cities = ["LYON (intramuros)"];
    const end = "MARSEILLE ST CHARLES"; // arrives 2026-07-02
    // Generous end date: feasible.
    expect(planTours(data, "PARIS (intramuros)", cities, "2026-07-01", opts, 10, 1, 1, undefined, undefined, undefined, end, "2026-07-05")).toHaveLength(1);
    // End date before the earliest possible arrival: infeasible.
    expect(planTours(data, "PARIS (intramuros)", cities, "2026-07-01", opts, 10, 1, 1, undefined, undefined, undefined, end, "2026-07-01")).toHaveLength(0);
    expect(planTourInOrder(data, "PARIS (intramuros)", cities, "2026-07-01", opts, 1, 1, undefined, undefined, undefined, end, "2026-07-01")).toBeNull();
  });
});

describe("planTourGreedy", () => {
  const chain = normalizeRecords([
    { date: "2026-07-01", origine: "PARIS (intramuros)", destination: "LYON (intramuros)", heure_depart: "08:00", heure_arrivee: "10:00", train_no: "10", od_happy_card: "OUI" },
    { date: "2026-07-02", origine: "LYON (intramuros)", destination: "MARSEILLE ST CHARLES", heure_depart: "09:00", heure_arrivee: "10:40", train_no: "11", od_happy_card: "OUI" },
    { date: "2026-07-03", origine: "MARSEILLE ST CHARLES", destination: "NICE VILLE", heure_depart: "09:00", heure_arrivee: "11:30", train_no: "12", od_happy_card: "OUI" },
  ] as RawRecord[]);
  const opts = { maxConnections: 0 };

  it("reorders an infeasible typed order into a feasible visiting order", () => {
    // Typed back-to-front: in-order planning fails, greedy finds the real chain.
    const cities = ["NICE VILLE", "MARSEILLE ST CHARLES", "LYON (intramuros)"];
    expect(planTourInOrder(chain, "PARIS (intramuros)", cities, "2026-07-01", opts, 1, 1)).toBeNull();
    const tour = planTourGreedy(chain, "PARIS (intramuros)", cities, "2026-07-01", opts, 1, 1);
    expect(tour).not.toBeNull();
    expect(tour!.order).toEqual(["LYON (intramuros)", "MARSEILLE ST CHARLES", "NICE VILLE"]);
    expect(tour!.legs).toHaveLength(3);
  });

  it("handles more than 5 cities", () => {
    const seq = ["A", "B", "C", "D", "E", "F", "G"];
    const rows = seq.map((to, i) => ({
      date: `2026-07-0${i + 1}`,
      origine: i === 0 ? "START" : seq[i - 1]!,
      destination: to,
      heure_depart: "08:00",
      heure_arrivee: "10:00",
      train_no: String(i),
      od_happy_card: "OUI",
    }));
    const data = normalizeRecords(rows as RawRecord[]);
    const tour = planTourGreedy(data, "START", [...seq].reverse(), "2026-07-01", opts, 1, 1);
    expect(tour).not.toBeNull();
    expect(tour!.order).toEqual(seq);
    expect(tour!.legs).toHaveLength(7);
  });

  it("returns null when a city can never be reached in sequence", () => {
    const tour = planTourGreedy(chain, "PARIS (intramuros)", ["LYON (intramuros)", "BORDEAUX ST JEAN"], "2026-07-01", opts, 1, 1);
    expect(tour).toBeNull();
  });

  it("respects a total-distance (km) budget", () => {
    const cities = ["LYON (intramuros)", "MARSEILLE ST CHARLES", "NICE VILLE"];
    // Distance stub: each successive hop is 200 km (600 km total for 3 hops).
    const dist = (a: string, b: string): number => (a === b ? 0 : 200);
    // Generous budget: full 3-city tour fits.
    expect(planTourGreedy(chain, "PARIS (intramuros)", cities, "2026-07-01", opts, 1, 1, dist, 1000)!.legs).toHaveLength(3);
    // Tight budget (250 km): only the first hop fits, the rest bust the budget.
    expect(planTourGreedy(chain, "PARIS (intramuros)", cities, "2026-07-01", opts, 1, 1, dist, 250)).toBeNull();
    // planTours (<=5, permuting) also drops over-budget tours.
    expect(planTours(chain, "PARIS (intramuros)", cities, "2026-07-01", opts, 10, 1, 1, dist, 250)).toHaveLength(0);
    expect(planTours(chain, "PARIS (intramuros)", cities, "2026-07-01", opts, 10, 1, 1, dist, 1000)).toHaveLength(1);
  });

  it("respects a per-train (per-hop) distance cap", () => {
    const cities = ["LYON (intramuros)", "MARSEILLE ST CHARLES", "NICE VILLE"];
    const dist = (a: string, b: string): number => (a === b ? 0 : 200); // each hop 200 km
    // legCap below 200: every hop is too long -> no tour.
    expect(planTourGreedy(chain, "PARIS (intramuros)", cities, "2026-07-01", opts, 1, 1, dist, undefined, 150)).toBeNull();
    expect(planTours(chain, "PARIS (intramuros)", cities, "2026-07-01", opts, 10, 1, 1, dist, undefined, 150)).toHaveLength(0);
    // legCap of 250: each hop fits (total unconstrained) -> full tour.
    expect(planTourGreedy(chain, "PARIS (intramuros)", cities, "2026-07-01", opts, 1, 1, dist, undefined, 250)!.legs).toHaveLength(3);
    expect(planTours(chain, "PARIS (intramuros)", cities, "2026-07-01", opts, 10, 1, 1, dist, undefined, 250)).toHaveLength(1);
  });

  it("respects a per-train time cap (maxDurationMin on each hop)", () => {
    // Hop durations: Paris→Lyon 120 min, Lyon→Marseille 100 min, Marseille→Nice 150 min.
    const cities = ["LYON (intramuros)", "MARSEILLE ST CHARLES", "NICE VILLE"];
    // Cap at 130 min rules out the 150-min Nice hop, so the tour can't be completed.
    const tight = { maxConnections: 0, maxDurationMin: 130 };
    expect(planTourGreedy(chain, "PARIS (intramuros)", cities, "2026-07-01", tight, 1, 1)).toBeNull();
    expect(planTours(chain, "PARIS (intramuros)", cities, "2026-07-01", tight, 10, 1, 1)).toHaveLength(0);
    // A 200-min cap clears every hop -> the full chain plans.
    const loose = { maxConnections: 0, maxDurationMin: 200 };
    expect(planTourGreedy(chain, "PARIS (intramuros)", cities, "2026-07-01", loose, 1, 1)!.legs).toHaveLength(3);
    expect(planTours(chain, "PARIS (intramuros)", cities, "2026-07-01", loose, 10, 1, 1)).toHaveLength(1);
  });
});

describe("haversineKm", () => {
  it("matches known great-circle distances within ~1%", () => {
    // Paris (Gare de Lyon) -> Lyon (Part-Dieu): ~392 km straight line.
    const d = haversineKm([48.8443, 2.3743], [45.7605, 4.8595]);
    expect(d).toBeGreaterThan(388);
    expect(d).toBeLessThan(396);
    expect(haversineKm([48.8443, 2.3743], [48.8443, 2.3743])).toBe(0);
  });
});

describe("getaways (round trips: day trips + N-night stays)", () => {
  // ARRAS: leave 09:00 (arrive 10:00), come back 22:00 (home 23:00) — a full day.
  // REIMS: only a short window (arrive 11:00, last return departs 13:00) — 2h on site.
  // DOUAI: a morning train out but NO return the same day — must be excluded.
  const data = normalizeRecords([
    { date: "2026-07-01", origine: "PARIS (intramuros)", destination: "ARRAS", heure_depart: "09:00", heure_arrivee: "10:00", train_no: "A1", od_happy_card: "OUI" },
    { date: "2026-07-01", origine: "ARRAS", destination: "PARIS (intramuros)", heure_depart: "22:00", heure_arrivee: "23:00", train_no: "A2", od_happy_card: "OUI" },
    { date: "2026-07-01", origine: "PARIS (intramuros)", destination: "REIMS", heure_depart: "10:00", heure_arrivee: "11:00", train_no: "R1", od_happy_card: "OUI" },
    { date: "2026-07-01", origine: "REIMS", destination: "PARIS (intramuros)", heure_depart: "13:00", heure_arrivee: "14:00", train_no: "R2", od_happy_card: "OUI" },
    { date: "2026-07-01", origine: "PARIS (intramuros)", destination: "DOUAI", heure_depart: "09:30", heure_arrivee: "10:30", train_no: "D1", od_happy_card: "OUI" },
  ] as RawRecord[]);

  it("pairs a morning outbound with the latest feasible return, ranked by time on site", () => {
    const trips = getaways(data, "PARIS (intramuros)", "2026-07-01", {
      maxConnections: 0,
      minOnSiteMin: 60, // 1 h, so the short Reims window still qualifies
    });
    expect(trips.map((t) => t.destination)).toEqual(["ARRAS", "REIMS"]); // Douai dropped, sorted by on-site
    const arras = trips[0]!;
    expect(arras.nights).toBe(0);
    expect(arras.outbound.legs[0]!.trainNo).toBe("A1");
    expect(arras.back.legs[0]!.trainNo).toBe("A2");
    expect(arras.onSiteMin).toBe(12 * 60); // 10:00 arrival -> 22:00 return departure
    expect(arras.travelMin).toBe(120); // 60 out + 60 back
  });

  it("respects the minimum time on site", () => {
    const trips = getaways(data, "PARIS (intramuros)", "2026-07-01", { maxConnections: 0, minOnSiteMin: 240 });
    expect(trips.map((t) => t.destination)).toEqual(["ARRAS"]); // Reims' 2 h window is now too short
  });

  it("reverseGetawayIdeas: a round trip with only a destination lists the origins you can round-trip FROM", () => {
    // Reverse discovery for the destination ARRAS: PARIS can round-trip PARIS→ARRAS→PARIS
    // (out 09:00, back 22:00), so PARIS is a valid reverse origin. Each trip is relabelled
    // so `.destination` names the discovered ORIGIN, its outbound still origin→ARRAS.
    const sweep = reverseGetawayIdeas(data, "ARRAS", ["2026-07-01"], { maxConnections: 0, minOnSiteMin: 60 });
    expect(sweep.trips.map((t) => t.destination)).toContain("PARIS (intramuros)");
    const paris = sweep.trips.find((t) => t.destination === "PARIS (intramuros)")!;
    expect(paris.outbound.origin).toBe("PARIS (intramuros)");
    expect(paris.outbound.destination).toBe("ARRAS"); // the real trip is PARIS → ARRAS
    expect(paris.back.destination).toBe("PARIS (intramuros)"); // and ARRAS → PARIS back
    expect(sweep.perDay[0]!.available).toBe(true);
    expect(sweep.perDay[0]!.count).toBeGreaterThanOrEqual(1);
  });

  it("stayCalendar 'hours': green only when a real same-day there-and-back exists, count = hours on site", () => {
    // ARRAS has a same-day round trip (12 h on site); DOUAI has a one-way but no
    // feasible same-day return, so its day must NOT be green.
    const arras = stayCalendar(data, "PARIS (intramuros)", "ARRAS", ["2026-07-01"], { maxConnections: 0, minOnSiteMin: 60 }, "hours");
    expect(arras[0]!.available).toBe(true);
    expect(arras[0]!.count).toBe(12); // 10:00 → 22:00 = 12 h on site
    const douai = stayCalendar(data, "PARIS (intramuros)", "DOUAI", ["2026-07-01"], { maxConnections: 0 }, "hours");
    expect(douai[0]!.available).toBe(false); // one-way seat, but no same-day return
    expect(douai[0]!.count).toBe(0);
  });

  it("stayCalendar 'nights': green with the best nights count when a multi-day round trip exists", () => {
    const cal = stayCalendar(stay, "PARIS (intramuros)", "ROUEN", ["2026-07-01"], { maxConnections: 0 }, "nights");
    expect(cal[0]!.available).toBe(true);
    expect(cal[0]!.count).toBe(2); // flexibleNights keeps the LONGEST feasible stay (return on 07-03 = 2 nights)
  });

  it("excludes a past-midnight return unless lateReturn is set", () => {
    const late = normalizeRecords([
      { date: "2026-07-01", origine: "PARIS (intramuros)", destination: "ARRAS", heure_depart: "09:00", heure_arrivee: "10:00", train_no: "A1", od_happy_card: "OUI" },
      { date: "2026-07-01", origine: "ARRAS", destination: "PARIS (intramuros)", heure_depart: "23:30", heure_arrivee: "00:45", train_no: "A2", od_happy_card: "OUI" },
    ] as RawRecord[]);
    expect(getaways(late, "PARIS (intramuros)", "2026-07-01", { maxConnections: 0 })).toHaveLength(0);
    const ok = getaways(late, "PARIS (intramuros)", "2026-07-01", { maxConnections: 0, lateReturn: true });
    expect(ok).toHaveLength(1);
    expect(ok[0]!.back.legs[0]!.trainNo).toBe("A2");
  });

  // ROUEN: out 01-Jul, return only on 03-Jul (2 nights). No same-day return exists.
  const stay = normalizeRecords([
    { date: "2026-07-01", origine: "PARIS (intramuros)", destination: "ROUEN", heure_depart: "09:00", heure_arrivee: "10:00", train_no: "X1", od_happy_card: "OUI" },
    { date: "2026-07-02", origine: "ROUEN", destination: "PARIS (intramuros)", heure_depart: "18:00", heure_arrivee: "19:00", train_no: "X2", od_happy_card: "OUI" },
    { date: "2026-07-03", origine: "ROUEN", destination: "PARIS (intramuros)", heure_depart: "20:00", heure_arrivee: "21:00", train_no: "X3", od_happy_card: "OUI" },
  ] as RawRecord[]);

  it("finds an N-night stay: outbound on the start day, return N days later", () => {
    const none = getaways(stay, "PARIS (intramuros)", "2026-07-01", { maxConnections: 0 }); // same day
    expect(none).toHaveLength(0);
    const twoNights = getaways(stay, "PARIS (intramuros)", "2026-07-01", { maxConnections: 0, nights: 2 });
    expect(twoNights).toHaveLength(1);
    expect(twoNights[0]!.nights).toBe(2);
    expect(twoNights[0]!.outbound.legs[0]!.trainNo).toBe("X1");
    expect(twoNights[0]!.back.legs[0]!.trainNo).toBe("X3"); // the 03-Jul return
    expect(twoNights[0]!.onSiteMin).toBeUndefined(); // multi-night counts nights, not minutes
  });

  it("models a sleeper round trip: overnight out, N nights, overnight back", () => {
    const sleeperRT = normalizeRecords([
      { date: "2026-07-01", origine: "PARIS (intramuros)", destination: "BRIANCON", heure_depart: "21:00", heure_arrivee: "07:00", train_no: "OUT", od_happy_card: "OUI", axe: "IC NUIT" },
      { date: "2026-07-03", origine: "BRIANCON", destination: "PARIS (intramuros)", heure_depart: "20:00", heure_arrivee: "07:00", train_no: "BACK", od_happy_card: "OUI", axe: "IC NUIT" },
      // A day return that must NOT be used when "only night trains" is on.
      { date: "2026-07-03", origine: "BRIANCON", destination: "PARIS (intramuros)", heure_depart: "08:00", heure_arrivee: "12:00", train_no: "DAYBACK", od_happy_card: "OUI", axe: "SUD EST" },
    ] as RawRecord[]);
    const g = getaways(sleeperRT, "PARIS (intramuros)", "2026-07-01", { maxConnections: 0, onlyNight: true, nights: 1 });
    expect(g).toHaveLength(1);
    expect(g[0]!.nights).toBe(1); // one night AT the destination
    expect(g[0]!.outbound.legs[0]!.trainNo).toBe("OUT"); // sleeper out (arrives next morning)
    expect(g[0]!.back.legs[0]!.trainNo).toBe("BACK"); // sleeper back, not the day return
    expect(g[0]!.back.date).toBe("2026-07-03"); // leaves the evening after the last night (date + nights + 1)
  });

  it("flexibleNights keeps the longest feasible stay up to the max", () => {
    // With max 3 nights, the longest feasible stay is 2 (return on 03-Jul).
    const flex = getaways(stay, "PARIS (intramuros)", "2026-07-01", {
      maxConnections: 0,
      nights: 3,
      flexibleNights: true,
    });
    expect(flex).toHaveLength(1);
    expect(flex[0]!.nights).toBe(2);
    expect(flex[0]!.back.legs[0]!.trainNo).toBe("X3");
  });
});

describe("latestReturns (backward multi-source sweep)", () => {
  const data = normalizeRecords([
    { date: "2026-09-10", origine: "LYON (intramuros)", destination: "PARIS (intramuros)", heure_depart: "10:00", heure_arrivee: "12:00", train_no: "R1", od_happy_card: "OUI" },
    { date: "2026-09-10", origine: "LYON (intramuros)", destination: "PARIS (intramuros)", heure_depart: "18:00", heure_arrivee: "20:00", train_no: "R2", od_happy_card: "OUI" },
    { date: "2026-09-10", origine: "LYON (intramuros)", destination: "PARIS (intramuros)", heure_depart: "23:30", heure_arrivee: "01:30", train_no: "LATE", od_happy_card: "OUI" },
  ] as RawRecord[]);

  it("keeps the latest-departing return that arrives by the ceiling", () => {
    const r = latestReturns(data, "PARIS (intramuros)", "2026-09-10", 24 * 60, { maxConnections: 0 });
    // R2 (18:00) is the latest that's home by midnight; LATE arrives 01:30 next day.
    expect(r.get("LYON (intramuros)")!.legs[0]!.trainNo).toBe("R2");
  });

  it("admits a past-midnight arrival when the ceiling is later", () => {
    const r = latestReturns(data, "PARIS (intramuros)", "2026-09-10", 26 * 60, { maxConnections: 0 });
    expect(r.get("LYON (intramuros)")!.legs[0]!.trainNo).toBe("LATE"); // 23:30 now fits
  });

  it("honours the depart-time window on the first leg (parity with findJourneys)", () => {
    // departBefore caps the first leg: only R1 (10:00) qualifies, not the later R2.
    const before = latestReturns(data, "PARIS (intramuros)", "2026-09-10", 24 * 60, {
      maxConnections: 0,
      departBefore: "12:00",
    });
    expect(before.get("LYON (intramuros)")!.legs[0]!.trainNo).toBe("R1");
    // departAfter excludes R1 and R2; only LATE (23:30) is left, so it needs a late ceiling.
    const after = latestReturns(data, "PARIS (intramuros)", "2026-09-10", 26 * 60, {
      maxConnections: 0,
      departAfter: "19:00",
    });
    expect(after.get("LYON (intramuros)")!.legs[0]!.trainNo).toBe("LATE");
    // With the default midnight ceiling, that late return arrives too late → no return.
    const none = latestReturns(data, "PARIS (intramuros)", "2026-09-10", 24 * 60, {
      maxConnections: 0,
      departAfter: "19:00",
    });
    expect(none.has("LYON (intramuros)")).toBe(false);
  });
});

describe("getawayIdeas (month-wide round-trip ideas)", () => {
  const dates = ["2026-06-25", "2026-06-26", "2026-06-27"];

  it("produces only valid round trips (out to dest, back to origin)", () => {
    const { trips: ideas, perDay } = getawayIdeas(trains, "PARIS (intramuros)", dates, {
      maxConnections: 1,
      nights: 1,
    });
    expect(ideas.length).toBeGreaterThan(0);
    expect(perDay).toHaveLength(dates.length); // one calendar entry per day
    for (const g of ideas) {
      expect(g.outbound.origin).toBe("PARIS (intramuros)");
      expect(g.outbound.destination).toBe(g.destination);
      expect(g.back.origin).toBe(g.destination);
      expect(g.back.destination).toBe("PARIS (intramuros)");
      expect(g.nights).toBe(1);
    }
  });

  it("matches the precise per-day scan's destinations for an N-night stay", () => {
    // For a multi-night stay the outbound's arrival doesn't gate the return, so the
    // fast two-sweep ideas and the exhaustive per-day getaways agree on which
    // destinations are round-trippable.
    const opts = { maxConnections: 1, nights: 1 } as const;
    const ideas = new Set(getawayIdeas(trains, "PARIS (intramuros)", dates, opts).trips.map((g) => g.destination));
    const precise = new Set(
      getawaysAcrossWindow(trains, "PARIS (intramuros)", dates, opts).trips.map((g) => g.destination),
    );
    expect(ideas).toEqual(precise);
  });

  it("uses the earliest-ARRIVING outbound (parity with Where-to), not the fastest, for same-day gating", () => {
    // Two outbounds to LYON: EARLY arrives 09:00 (slower), FAST arrives 10:00
    // (shorter). The single return leaves 13:30. With a 4 h minimum on site:
    //   - from EARLY (09:00): 4 h30 on site → the day trip is valid
    //   - from FAST  (10:00): 3 h30 on site → would be rejected
    // The fast two-sweep ideas must pick EARLY like bestGetawayTo, else it would
    // silently drop a day trip that "Where to?" shows.
    const data = normalizeRecords([
      { date: "2026-07-01", origine: "PARIS (intramuros)", destination: "LYON (intramuros)", heure_depart: "06:00", heure_arrivee: "09:00", train_no: "EARLY", od_happy_card: "OUI" },
      { date: "2026-07-01", origine: "PARIS (intramuros)", destination: "LYON (intramuros)", heure_depart: "08:00", heure_arrivee: "10:00", train_no: "FAST", od_happy_card: "OUI" },
      { date: "2026-07-01", origine: "LYON (intramuros)", destination: "PARIS (intramuros)", heure_depart: "13:30", heure_arrivee: "15:30", train_no: "RET", od_happy_card: "OUI" },
    ] as RawRecord[]);
    const opts = { maxConnections: 0, nights: 0 } as const;
    const ideas = getawayIdeas(data, "PARIS (intramuros)", ["2026-07-01"], opts);
    const precise = getawaysAcrossWindow(data, "PARIS (intramuros)", ["2026-07-01"], opts);
    // Both surfaces keep LYON, on the EARLY outbound, with the same time on site.
    expect(ideas.trips.map((g) => g.destination)).toEqual(["LYON (intramuros)"]);
    expect(ideas.trips[0]!.outbound.legs[0]!.trainNo).toBe("EARLY");
    expect(ideas.trips[0]!.onSiteMin).toBe(270);
    expect(ideas.perDay[0]!.count).toBe(1);
    expect(precise.trips.map((g) => g.destination)).toEqual(ideas.trips.map((g) => g.destination));
    expect(precise.trips[0]!.onSiteMin).toBe(ideas.trips[0]!.onSiteMin);
  });
});

describe("round-trip arrival uses absolute time, not the last leg's own-date minute", () => {
  it("prefers a same-day direct outbound over a via-hub one that lands the NEXT day", () => {
    const data = normalizeRecords([
      // Same-day direct: arrives 12:00 on 01-Jul.
      { date: "2026-07-01", origine: "PARIS (intramuros)", destination: "NICE VILLE", heure_depart: "08:00", heure_arrivee: "12:00", train_no: "DIRECT", od_happy_card: "OUI" },
      // Via LYON: the last leg lands 06:00 the NEXT day — its own-date minute (360) is
      // tiny, but the real arrival is ~18 h after the direct.
      { date: "2026-07-01", origine: "PARIS (intramuros)", destination: "LYON (intramuros)", heure_depart: "22:00", heure_arrivee: "23:30", train_no: "P2L", od_happy_card: "OUI" },
      { date: "2026-07-02", origine: "LYON (intramuros)", destination: "NICE VILLE", heure_depart: "00:30", heure_arrivee: "06:00", train_no: "L2N", od_happy_card: "OUI" },
      // Same-day return from Nice, home 22:00.
      { date: "2026-07-01", origine: "NICE VILLE", destination: "PARIS (intramuros)", heure_depart: "18:00", heure_arrivee: "22:00", train_no: "RET", od_happy_card: "OUI" },
    ] as RawRecord[]);
    const opts = { maxConnections: 1, hubs: ["LYON (intramuros)"], nights: 0, minOnSiteMin: 60 };
    const nice = getaways(data, "PARIS (intramuros)", "2026-07-01", opts).find((x) => x.destination === "NICE VILLE")!;
    expect(nice.outbound.legs[0]!.trainNo).toBe("DIRECT"); // NOT the next-day via-hub
    expect(nice.onSiteMin).toBe(360); // 12:00 → 18:00 = 6 h, not a fabricated 12 h+
    // The fast two-sweep "Ideas" path must agree (parity).
    const ideas = getawayIdeas(data, "PARIS (intramuros)", ["2026-07-01"], opts).trips.find((x) => x.destination === "NICE VILLE")!;
    expect(ideas.outbound.legs[0]!.trainNo).toBe("DIRECT");
    expect(ideas.onSiteMin).toBe(360);
  });

  it("rejects a return that only gets home after midnight (absolute home-by ceiling)", () => {
    const data = normalizeRecords([
      { date: "2026-07-01", origine: "PARIS (intramuros)", destination: "LYON (intramuros)", heure_depart: "08:00", heure_arrivee: "09:00", train_no: "OUT", od_happy_card: "OUI" },
      // The only way home crosses midnight: arrives PARIS 03:00 the NEXT day.
      { date: "2026-07-01", origine: "LYON (intramuros)", destination: "MARSEILLE ST CHARLES", heure_depart: "22:00", heure_arrivee: "23:30", train_no: "R1", od_happy_card: "OUI" },
      { date: "2026-07-02", origine: "MARSEILLE ST CHARLES", destination: "PARIS (intramuros)", heure_depart: "00:30", heure_arrivee: "03:00", train_no: "R2", od_happy_card: "OUI" },
    ] as RawRecord[]);
    // No same-day round trip to Lyon exists — the return lands at 03:00, past midnight.
    const g = getaways(data, "PARIS (intramuros)", "2026-07-01", { maxConnections: 1, hubs: ["MARSEILLE ST CHARLES"], nights: 0, minOnSiteMin: 60 });
    expect(g.find((x) => x.destination === "LYON (intramuros)")).toBeUndefined();
  });
});

function base(): RawRecord {
  return {
    date: "2026-06-25",
    origine: "PARIS (intramuros)",
    destination: "LYON (intramuros)",
    heure_depart: "08:00",
    heure_arrivee: "10:00",
    train_no: "6601",
    od_happy_card: "OUI",
  };
}
