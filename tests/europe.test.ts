import { describe, it, expect, afterEach } from "vitest";
import type { SearchBundle } from "../src/europe/engine";
import { Europe } from "../src/europe/network";
import { toAppJourney, returnDates } from "../src/europe/client";
import { findJourneys, setJourneySource, toJourney } from "../src/core/connections";
import { availabilityCalendar } from "../src/core/calendar";
import { operatorById, setOperatorBooking } from "../src/data/operators";
import { journeyFee } from "../src/data/fees";
import { StationRegistry } from "../src/data/stations";
import type { Journey, MaxTrain } from "../src/types";

const DAY = "2026-11-10";

/** One operator's bundle running every trip on DAY; stops are [station, "HH:MM"] or [station, "HH:MM/HH:MM"]. */
function bundle(
  operator: string,
  trips: [string, [string, string][], string?][],
  coords: Record<string, [number, number]> = {},
): SearchBundle {
  const stations: SearchBundle["stations"] = [];
  const idx = new Map<string, number>();
  const families: string[] = [];
  const at = (name: string): number => {
    let i = idx.get(name);
    if (i === undefined) {
      i = stations.length;
      idx.set(name, i);
      const c = coords[name];
      stations.push(c ? [name, c[0], c[1]] : [name, null, null]);
    }
    return i;
  };
  const min = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
  return {
    v: 2,
    operator,
    dates: [DAY],
    stations,
    families,
    trips: trips.map(([no, stops, family]) => {
      let fam = -1;
      if (family) {
        fam = families.indexOf(family);
        if (fam < 0) fam = families.push(family) - 1;
      }
      return [
        no,
        fam,
        "1",
        stops.map(([s]) => at(s)),
        stops.flatMap(([, t]) => {
          const [a = t, d = t] = t.split("/");
          return [min(a), min(d)];
        }),
      ];
    }),
  };
}

// SNCF's open data names its stations without positions; Renfe's GTFS places them.
const sncf = bundle("sncf", [
  ["9713", [["PARIS (intramuros)", "08:00"], ["BARCELONA SANTS", "14:30"]], "SUD EST"],
  ["6601", [["PARIS (intramuros)", "09:00"], ["LYON (intramuros)", "11:00"]], "SUD EST"],
]);
const renfe = bundle(
  "renfe",
  [
    ["03063", [["Barcelona-Sants", "15:30"], ["Zaragoza Delicias", "16:50/16:52"], ["Madrid-Puerta de Atocha", "18:15"]], "AVE"],
    ["03073", [["Barcelona-Sants", "17:30"], ["Madrid-Chamartín", "20:10"]], "AVE"],
    ["00900", [["Madrid-Puerta de Atocha", "23:00"], ["Sevilla-Santa Justa", "25:40"]], "TRENHOTEL"],
  ],
  {
    "Barcelona-Sants": [41.3793, 2.1404],
    "Zaragoza Delicias": [41.6588, -0.9116],
    "Madrid-Puerta de Atocha": [40.4066, -3.6892],
    "Madrid-Chamartín": [40.4722, -3.6825],
    "Sevilla-Santa Justa": [37.3918, -5.9757],
  },
);
const SNCF_COORDS: Record<string, [number, number]> = {
  "PARIS (intramuros)": [48.8566, 2.3522],
  "LYON (intramuros)": [45.7578, 4.832],
  "BARCELONA SANTS": [41.3792, 2.1405],
};

describe("Europe's network", () => {
  const europe = new Europe([sncf, renfe], SNCF_COORDS);

  it("keeps SNCF's ids where SNCF stops, and the engine's elsewhere", () => {
    const dir = europe.directory();
    const ids = dir.map((p) => p.id);
    expect(ids).toContain("PARIS (intramuros)");
    // Renfe's Barcelona-Sants is SNCF's BARCELONA SANTS: one place, under SNCF's id.
    expect(ids).toContain("BARCELONA SANTS");
    expect(ids).not.toContain("barcelona-sants");
    const atocha = dir.find((p) => p.name === "Madrid-Puerta de Atocha");
    expect(atocha).toMatchObject({ id: "madrid-puerta-de-atocha", town: "Madrid", lat: 40.4066 });
    expect(atocha?.calls).toBeGreaterThan(0);
  });

  it("finds Paris to Madrid, changing from SNCF to Renfe in Barcelona", () => {
    const [j] = europe.journeys("PARIS (intramuros)", "madrid-puerta-de-atocha", DAY, 4);
    expect(j?.legs.map((l) => [l.operator, l.trainNo, l.from, l.to])).toEqual([
      ["sncf", "9713", "PARIS (intramuros)", "BARCELONA SANTS"],
      ["renfe", "03063", "BARCELONA SANTS", "madrid-puerta-de-atocha"],
    ]);
  });

  it("searches a whole town: either Madrid station answers", () => {
    const list = europe.journeys("PARIS (intramuros)", "madrid-chamartin", DAY, 4);
    expect(list.map((j) => j.legs[1]?.trainNo)).toContain("03063");
  });

  it("keeps the change count the query allows", () => {
    expect(europe.journeys("PARIS (intramuros)", "madrid-puerta-de-atocha", DAY, 1)).toEqual([]);
  });

  it("lists the towns reachable from Paris, one row each", () => {
    const rows = europe.reachable("PARIS (intramuros)", DAY, 4);
    const stations = rows.map((r) => r.station);
    expect(stations).toContain("LYON (intramuros)");
    expect(stations).toContain("BARCELONA SANTS");
    // Atocha and Chamartín are one town: Madrid appears once.
    expect(stations.filter((s) => s.startsWith("madrid"))).toHaveLength(1);
    expect(stations).not.toContain("PARIS (intramuros)");
  });

  it("answers nothing for a station it doesn't know", () => {
    expect(europe.knows("NOWHERE")).toBe(false);
    expect(europe.knows("LYON (intramuros)")).toBe(true);
    expect(europe.journeys("NOWHERE", "madrid-puerta-de-atocha", DAY, 4)).toEqual([]);
    expect(europe.reachable("NOWHERE", DAY, 4)).toEqual([]);
  });
});

describe("toAppJourney", () => {
  it("turns the engine's legs into the app's trains, operator and all", () => {
    const j = toAppJourney({
      duration: 600,
      legs: [
        { operator: "sncf", trainNo: "9713", category: "SUD EST", from: "PARIS (intramuros)", to: "BARCELONA SANTS", departure: `${DAY}T08:00`, arrival: `${DAY}T14:30` },
        { operator: "renfe", trainNo: "00900", from: "BARCELONA SANTS", to: "sevilla-santa-justa", departure: `${DAY}T23:00`, arrival: "2026-11-11T06:00" },
      ],
    });
    expect(j).not.toBeNull();
    const [a, b] = j!.legs;
    expect(a).toMatchObject({ date: DAY, depart: "08:00", arrive: "14:30", departMin: 480, arriveMin: 870, axe: "SUD EST", available: true });
    expect(a?.operator).toBeUndefined();
    expect(b).toMatchObject({ operator: "renfe", depart: "23:00", arrive: "06:00", arriveMin: 1800, durationMin: 420 });
    expect(j).toMatchObject({ origin: "PARIS (intramuros)", destination: "sevilla-santa-justa", hubs: ["BARCELONA SANTS"], layovers: [510] });
    // The engine's duration, which counts each clock's time zone.
    expect(j!.totalDurationMin).toBe(600);
  });

  it("drops a journey with no legs", () => {
    expect(toAppJourney({ duration: 0, legs: [] })).toBeNull();
  });
});

describe("findJourneys with Europe's journeys", () => {
  afterEach(() => setJourneySource(null));

  const leg = (over: Partial<MaxTrain>): MaxTrain => ({
    date: DAY,
    origin: "PARIS (intramuros)",
    destination: "madrid-puerta-de-atocha",
    depart: "08:00",
    arrive: "18:00",
    departMin: 480,
    arriveMin: 1080,
    durationMin: 600,
    trainNo: "1",
    available: true,
    ...over,
  });
  const early = toJourney([leg({})]);
  const late = toJourney([leg({ trainNo: "2", depart: "15:00", departMin: 900, arriveMin: 1500, arrive: "01:00", durationMin: 600 })]);
  const found: Journey[] = [late, early];

  it("reads them first, narrowed to the query's times, and falls back on the trains otherwise", () => {
    setJourneySource((o, _d, date) => (o === "PARIS (intramuros)" && date === DAY ? found : undefined));
    expect(findJourneys([], "PARIS (intramuros)", "madrid-puerta-de-atocha", DAY).map((j) => j.legs[0]?.trainNo)).toEqual(["1", "2"]);
    expect(findJourneys([], "PARIS (intramuros)", "madrid-puerta-de-atocha", DAY, { departAfter: "12:00" })).toEqual([late]);
    expect(findJourneys([], "PARIS (intramuros)", "madrid-puerta-de-atocha", DAY, { arriveBefore: "23:00" })).toEqual([early]);
    // A day not searched yet: the trains answer (none here).
    expect(findJourneys([], "PARIS (intramuros)", "madrid-puerta-de-atocha", "2026-11-11")).toEqual([]);
    const cal = availabilityCalendar([], "PARIS (intramuros)", "madrid-puerta-de-atocha", [DAY, "2026-11-11"]);
    expect(cal.map((d) => d.count)).toEqual([2, 0]);
  });

  it("passes the query's change count to the source", () => {
    let asked = -1;
    setJourneySource((_o, _d, _date, maxConnections) => {
      asked = maxConnections;
      return [];
    });
    findJourneys([], "A", "B", DAY, { maxConnections: 3 });
    expect(asked).toBe(3);
  });
});

describe("operators", () => {
  afterEach(() => setOperatorBooking({}));

  it("books SNCF on SNCF Connect, the others on their own site", () => {
    expect(operatorById("sncf")).toBeUndefined();
    expect(operatorById(undefined)).toBeUndefined();
    expect(operatorById("renfe")).toMatchObject({ name: "Renfe", bookingUrl: "https://www.renfe.com/es/en" });
    setOperatorBooking({ renfe: "https://www.renfe.com/es/en/interrail" });
    expect(operatorById("renfe")?.bookingUrl).toBe("https://www.renfe.com/es/en/interrail");
  });

  it("leaves a journey with another operator's train without a fee", () => {
    const j = toAppJourney({
      duration: 135,
      legs: [{ operator: "renfe", trainNo: "03063", category: "AVE", from: "BARCELONA SANTS", to: "madrid-puerta-de-atocha", departure: `${DAY}T15:30`, arrival: `${DAY}T17:45` }],
    });
    expect(journeyFee(j!)).toBeUndefined();
  });
});

describe("returnDates", () => {
  it("adds the days after the last one", () => {
    expect(returnDates(["2026-11-10", "2026-11-12"], 2)).toEqual(["2026-11-10", "2026-11-12", "2026-11-13", "2026-11-14"]);
    expect(returnDates(["2026-11-10"], 0)).toEqual(["2026-11-10"]);
  });
});

describe("StationRegistry.addPlaces", () => {
  it("adds Europe's stations, searchable by town, and a pass switch drops them", () => {
    const reg = new StationRegistry([]);
    reg.addMissing(["PARIS (intramuros)"]);
    reg.addPlaces([
      { id: "madrid-puerta-de-atocha", label: "Madrid-Puerta de Atocha", city: "Madrid", lat: 40.4066, lng: -3.6892 },
      { id: "PARIS (intramuros)", label: "Another name", lat: 48.85, lng: 2.35 },
    ]);
    expect(reg.coords("madrid-puerta-de-atocha")).toEqual([40.4066, -3.6892]);
    expect(reg.search("madrid").map((s) => s.id)).toContain("madrid-puerta-de-atocha");
    expect(reg.resolve("Madrid-Puerta de Atocha")).toBe("madrid-puerta-de-atocha");
    // Known ids keep their entry.
    expect(reg.label("PARIS (intramuros)")).not.toBe("Another name");
    reg.setPresent(["PARIS (intramuros)"]);
    expect(reg.get("madrid-puerta-de-atocha")).toBeUndefined();
  });
});
