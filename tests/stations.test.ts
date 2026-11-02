import { describe, it, expect } from "vitest";
import type { Station } from "../src/types";
import { StationRegistry, normalizeText, prettyLabel, isAirportStation } from "../src/data/stations";
import { haversineKm } from "../src/util/geo";
import stationData from "../data/stations.json";

const registry = new StationRegistry(stationData as Station[]);

describe("normalizeText", () => {
  it("strips accents and lowercases", () => {
    expect(normalizeText("Nîmes")).toBe("nimes");
    expect(normalizeText("  Besançon  ")).toBe("besancon");
  });
});

describe("prettyLabel", () => {
  it("makes a readable label from a raw station id", () => {
    expect(prettyLabel("PARIS (intramuros)")).toBe("Paris");
    expect(prettyLabel("MARSEILLE ST CHARLES")).toBe("Marseille St Charles");
  });
});

describe("isAirportStation", () => {
  it("flags the TGV airport stations", () => {
    expect(isAirportStation("AEROPORT CDG2 TGV")).toBe(true);
    expect(isAirportStation("AEROPORT CHARLES DE GAULLE 2 TGV")).toBe(true);
    expect(isAirportStation("LYON ST EXUPERY TGV")).toBe(true);
    expect(isAirportStation("ROISSY")).toBe(true);
  });
  it("does not flag ordinary city / suburb stations", () => {
    expect(isAirportStation("PARIS (intramuros)")).toBe(false);
    expect(isAirportStation("LYON (intramuros)")).toBe(false);
    expect(isAirportStation("MASSY TGV")).toBe(false);
    expect(isAirportStation("MARNE LA VALLEE CHESSY")).toBe(false);
  });
});

describe("StationRegistry.search", () => {
  it("matches by prefix", () => {
    const ids = registry.search("lyon").map((s) => s.id);
    expect(ids).toContain("LYON (intramuros)");
  });

  it("is accent-insensitive", () => {
    const ids = registry.search("nimes").map((s) => s.id);
    expect(ids).toContain("NIMES");
  });

  it("matches aliases", () => {
    const ids = registry.search("disneyland").map((s) => s.id);
    expect(ids).toContain("MARNE LA VALLEE CHESSY");
  });

  it("respects the result limit", () => {
    expect(registry.search("a", 3).length).toBeLessThanOrEqual(3);
  });
});

describe("StationRegistry.setPresent", () => {
  it("swaps one dataset's stations for another's", () => {
    const r = new StationRegistry(stationData as Station[]);
    r.addMissing(["ARRAS", "PARIS (intramuros)"]);
    r.setPresent(["PARIS (intramuros)", "ZZ MADE UP GARE"]);
    expect(r.get("ARRAS")).toBeUndefined();
    expect(r.search("arras")).toHaveLength(0);
    expect(r.get("ZZ MADE UP GARE")).toBeDefined();
    expect(r.resolve("PARIS (intramuros)")).toBe("PARIS (intramuros)");
    // The curated stations stay.
    expect(r.get("LILLE")).toBeDefined();
  });
});

describe("StationRegistry.addMissing", () => {
  it("makes dataset-only stations searchable, with a pretty label", () => {
    const r = new StationRegistry(stationData as Station[]);
    expect(r.search("arras")).toHaveLength(0); // not searchable until present in the dataset
    r.addMissing(["ARRAS", "PARIS (intramuros)", "LILLE FLANDRES", "ZZ MADE UP GARE"]);
    expect(r.get("ARRAS")).toBeDefined();
    expect(r.label("ARRAS")).toBe("Arras");
    expect(r.search("arras").map((s) => s.id)).toContain("ARRAS");
    // A station with no matching city reference stays unplotted.
    expect(r.coords("ZZ MADE UP GARE")).toBeUndefined();
    // Stations matching a city reference inherit its coordinates (city-name
    // variants too), so the list and the map stay in sync.
    expect(r.coords("ARRAS")).toEqual([50.291, 2.781]);
    expect(r.coords("LILLE FLANDRES")).toEqual([50.6376, 3.0753]);
    expect(r.city("ARRAS")).toBe("Arras");
  });

  it("resolves a city for guide links, stripping station qualifiers", () => {
    const r = new StationRegistry(stationData as Station[]);
    r.addMissing(["BRUXELLES MIDI", "TGV HAUTE PICARDIE"]);
    expect(r.city("BRUXELLES MIDI")).toBe("Bruxelles"); // via city reference
    expect(r.city("TGV HAUTE PICARDIE")).toBe("Haute-Picardie");
  });

  it("plots an out-of-town station at the station, not at its city centre", () => {
    const r = new StationRegistry(stationData as Station[]);
    r.addMissing(["LYON ST EXUPERY TGV.", "LYON (intramuros)", "VALENCE TGV AUVERGNE RHONE ALPES", "VALENCE VILLE", "CALAIS FRETHUN", "CALAIS VILLE", "TOURS", "ST PIERRE DES CORPS", "MARSEILLE ST CHARLES", "MARSEILLE BLANCARDE", "LES AUBRAIS ORLEANS"]);
    const km = (a: string, b: string): number => haversineKm(r.coords(a)!, r.coords(b)!);
    expect(km("LYON ST EXUPERY TGV.", "LYON (intramuros)")).toBeGreaterThan(15);
    expect(km("VALENCE TGV AUVERGNE RHONE ALPES", "VALENCE VILLE")).toBeGreaterThan(8);
    expect(km("CALAIS FRETHUN", "CALAIS VILLE")).toBeGreaterThan(5);
    // Two stations of one town on one point hide each other from the nearby search.
    expect(km("TOURS", "ST PIERRE DES CORPS")).toBeGreaterThan(2);
    expect(km("MARSEILLE ST CHARLES", "MARSEILLE BLANCARDE")).toBeGreaterThan(2);
    expect(r.city("LYON ST EXUPERY TGV.")).toBe("Lyon"); // guide link still opens the city
    expect(r.city("LES AUBRAIS ORLEANS")).toBe("Orléans");
  });

  it("dedupes label collisions, preferring the id present in the dataset", () => {
    const r = new StationRegistry(stationData as Station[]);
    // The curated registry has id "LILLE"; a dataset variant renders the same.
    r.addMissing(["LILLE (intramuros)"]);
    const lilles = r.list().filter((s) => s.label === "Lille");
    expect(lilles).toHaveLength(1);
    expect(lilles[0]!.id).toBe("LILLE (intramuros)"); // the bookable one wins
  });
});

describe("non-bookable stations are hidden", () => {
  it("never surface in search or list, even once present in the dataset", () => {
    const r = new StationRegistry(stationData as Station[]);
    r.addMissing(["BRUXELLES MIDI", "GENEVE", "PARIS (intramuros)"]);
    // International stops the MAX pass can't book: registered (so labels/city
    // links still resolve) but filtered out of every user-facing list.
    expect(r.search("bruxelles")).toHaveLength(0);
    expect(r.search("geneve")).toHaveLength(0);
    expect(r.list().some((s) => s.id === "BRUXELLES MIDI")).toBe(false);
    expect(r.list().some((s) => s.id === "GENEVE")).toBe(false);
    // Bookable stations are unaffected.
    expect(r.search("paris").map((s) => s.id)).toContain("PARIS (intramuros)");
  });
});

describe("StationRegistry lookups", () => {
  it("returns coordinates and labels", () => {
    expect(registry.coords("PARIS (intramuros)")).toEqual([48.8566, 2.3522]);
    expect(registry.label("LYON (intramuros)")).toBe("Lyon");
  });

  it("falls back to a pretty label for unknown ids", () => {
    expect(registry.label("SOME UNKNOWN GARE")).toBe("Some Unknown Gare");
  });
});

describe("StationRegistry.resolve", () => {
  const r = new StationRegistry(stationData as Station[]);
  r.addMissing([
    "PARIS (intramuros)",
    "PAU",
    "TOURS",
    "ST PIERRE DES CORPS",
    "AIX EN PROVENCE TGV",
    "AIX LES BAINS LE REVARD",
    "MORLAIX",
    "MARNE LA VALLEE CHESSY",
  ]);

  it("reads hyphens, accents, case and St/Saint alike", () => {
    expect(normalizeText("St-Pierre")).toBe(normalizeText("saint pierre"));
    expect(normalizeText("Ste-Foy")).toBe("sainte foy");
  });

  it("resolves a name spelling an id, label or alias, however it is written", () => {
    expect(r.resolve("Paris")).toBe("PARIS (intramuros)");
    expect(r.resolve("St-Pierre-des-Corps")).toBe("ST PIERRE DES CORPS");
    expect(r.resolve("aix")).toBe("AIX EN PROVENCE TGV"); // a curated alias
  });

  it("prefers a station's own name to another station's alias", () => {
    // TOURS carries the alias "saint pierre des corps"; the station itself wins.
    expect(r.resolve("saint pierre des corps")).toBe("ST PIERRE DES CORPS");
  });

  it("resolves the only station a partial name matches", () => {
    expect(r.resolve("disneyland")).toBe("MARNE LA VALLEE CHESSY");
    expect(r.resolve("aix en provence")).toBe("AIX EN PROVENCE TGV");
    expect(r.resolve("aix les")).toBe("AIX LES BAINS LE REVARD");
  });

  it("leaves a name matching several stations, or none, unresolved", () => {
    expect(r.resolve("les a")).toBeUndefined(); // Les Arcs, Les Aubrais
    expect(r.resolve("mont")).toBeUndefined();
    expect(r.resolve("pa")).toBeUndefined();
    expect(r.resolve("ai")).toBeUndefined();
    expect(r.resolve("zzz")).toBeUndefined();
  });
});
