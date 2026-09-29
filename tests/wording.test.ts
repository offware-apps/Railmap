import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Leaflet needs a real browser canvas; stub the map module so the app mounts under jsdom.
vi.mock("../src/ui/map", () => ({
  RouteMap: class {
    onSelect: ((id: string) => void) | null = null;
    show(): void {}
    route(): void {}
    radius(): void {}
    base(): void {}
    highlight(): void {}
    invalidate(): void {}
    focus(): void {}
    setInfo(): void {}
  },
}));

import type { RawRecord, Station, DataMeta } from "../src/types";
import { setLang, tn, formatDuration, LANGS, type Lang } from "../src/i18n";
import type { Dict } from "../src/i18n/fr";
import { fr } from "../src/i18n/fr";
import { en } from "../src/i18n/en";
import { es } from "../src/i18n/es";
import { de } from "../src/i18n/de";
import { it as itDict } from "../src/i18n/it";
import { ko } from "../src/i18n/ko";
import { zh } from "../src/i18n/zh";
import { ja } from "../src/i18n/ja";
import { nl } from "../src/i18n/nl";
import { pt } from "../src/i18n/pt";
import { ar } from "../src/i18n/ar";
import { StationRegistry, prettyLabel } from "../src/data/stations";
import { normalizeRecords } from "../src/data/dataset";
import { findJourneys } from "../src/core/connections";
import { availabilityCalendar } from "../src/core/calendar";
import { showSettingsModal } from "../src/ui/modals";
import { initApp } from "../src/app";
import sample from "../data/tgvmax.sample.json";
import stations from "../data/stations.json";

const DICTS: Record<Lang, Dict> = { fr, en, es, de, it: itDict, ko, zh, ja, nl, pt, ar };

/** Every string a dict holds: plain values and each plural form. */
function strings(d: Dict): [string, string][] {
  return Object.entries(d).flatMap(([k, v]) =>
    typeof v === "string" ? [[k, v] as [string, string]] : Object.values(v).map((f) => [k, f] as [string, string]),
  );
}

afterEach(() => setLang("fr"));

describe("plural forms (tn)", () => {
  it("picks the singular and plural a language uses", () => {
    setLang("fr");
    expect(tn("badge_trains", 0)).toBe("0 train");
    expect(tn("badge_trains", 1)).toBe("1 train");
    expect(tn("badge_trains", 2)).toBe("2 trains");
    expect(tn("getaway_nights", 1)).toBe("1 nuit sur place");
    expect(tn("trip_summary", 3, { dur: "4 h" })).toBe("3 nuits · 4 h de trajet aller-retour");
    setLang("en");
    expect(tn("res_destinations", 1)).toBe("1 destination");
    expect(tn("res_destinations", 0)).toBe("0 destinations");
    expect(tn("rt_reverse_count", 2)).toBe("2 possible departure points");
    setLang("de");
    expect(tn("badge_trains", 1)).toBe("1 Zug");
    expect(tn("badge_trains", 4)).toBe("4 Züge");
    setLang("es");
    expect(tn("res_origins", 2)).toBe("2 orígenes");
    setLang("ja");
    expect(tn("badge_trains", 1)).toBe("列車 1 本");
  });

  it("uses Arabic's one, two, few, many and other categories", () => {
    setLang("ar");
    expect(tn("badge_trains", 1)).toBe("قطار واحد");
    expect(tn("badge_trains", 2)).toBe("قطاران");
    expect(tn("badge_trains", 3)).toBe("3 قطارات");
    expect(tn("badge_trains", 11)).toBe("11 قطارًا");
    expect(tn("badge_trains", 100)).toBe("100 قطار");
    expect(tn("getaway_nights", 5)).toBe("5 ليالٍ هناك");
  });

  it("fills every plural key in every language with no placeholder left", () => {
    for (const { code } of LANGS) {
      setLang(code);
      for (const [key, value] of Object.entries(DICTS[code])) {
        if (typeof value === "string") continue;
        for (const n of [0, 1, 2, 3, 11, 100]) {
          const s = tn(key as Parameters<typeof tn>[0], n, { dur: "1 h" });
          expect(s, `${code}.${key}(${n})`).not.toMatch(/[{}]/);
        }
      }
    }
  });

  it("leaves no '(s)' style or slash plural in any dictionary", () => {
    for (const { code } of LANGS) {
      for (const [key, s] of strings(DICTS[code])) {
        // "leg(s)", "Ziel(e)", "trajet(s)", "viagem(ns)", "mogelijk(e)"…
        expect(s, `${code}.${key}`).not.toMatch(/\p{Script=Latin}\(\p{Script=Latin}{1,3}\)/u);
        if (typeof DICTS[code][key as keyof Dict] !== "string") {
          // "Zug/Züge", "notte/notti" (Italian "a/r" is the round-trip abbreviation)
          expect(s.replace("a/r", ""), `${code}.${key}`).not.toMatch(/\p{L}\/\p{L}/u);
        }
      }
    }
  });
});

describe("German register", () => {
  it("addresses the user as du throughout, never Sie", () => {
    expect(strings(de).filter(([, s]) => /\b(Sie|Ihre?[mnrs]?|Ihnen)\b/.test(s))).toEqual([]);
  });
});

describe("durations in the UI language", () => {
  it("formats days, hours and minutes with each dictionary's units", () => {
    setLang("en");
    expect([formatDuration(45), formatDuration(120), formatDuration(135), formatDuration(1440), formatDuration(14245)]).toEqual([
      "45 min",
      "2 h",
      "2 h 15",
      "1 d",
      "9 d 21 h",
    ]);
    setLang("fr");
    expect(formatDuration(14245)).toBe("9 j 21 h");
    setLang("de");
    expect(formatDuration(135)).toBe("2 Std. 15 Min.");
    setLang("ja");
    expect(formatDuration(65)).toBe("1時間05分");
  });

  it("gives every dictionary all five duration templates", () => {
    const need: Record<string, string[]> = {
      dur_m: ["{m}"],
      dur_h: ["{h}"],
      dur_hm: ["{h}", "{m}"],
      dur_d: ["{d}"],
      dur_dh: ["{d}", "{h}"],
    };
    for (const { code } of LANGS) {
      for (const [key, marks] of Object.entries(need)) {
        const s = DICTS[code][key as keyof Dict] as string;
        for (const m of marks) expect(s, `${code}.${key}`).toContain(m);
      }
      setLang(code);
      for (const min of [5, 60, 125, 1440, 1500]) expect(formatDuration(min), code).not.toMatch(/[{}]/);
    }
  });
});

describe("station display names", () => {
  it("cases raw ids: acronyms, French particles, hyphenated parts, a space before '('", () => {
    expect(prettyLabel("CAUSSADE(TARN ET GARONNE)")).toBe("Caussade (Tarn et Garonne)");
    expect(prettyLabel("AEROPORT ROISSY CDG 2 TGV")).toBe("Aeroport Roissy CDG 2 TGV");
    expect(prettyLabel("SAINT-PIERRE-DES-CORPS")).toBe("Saint-Pierre-des-Corps");
    expect(prettyLabel("BRIVE LA GAILLARDE")).toBe("Brive la Gaillarde");
    expect(prettyLabel("ST PIERRE DES CORPS")).toBe("St Pierre des Corps");
    expect(prettyLabel("LES SABLES D'OLONNE")).toBe("Les Sables d'Olonne");
    expect(prettyLabel("L'ARGENTIERE LES ECRINS")).toBe("L'Argentiere les Ecrins");
    expect(prettyLabel("LYON ST EXUPERY TGV.")).toBe("Lyon St Exupery TGV");
    expect(prettyLabel("MONTELIMAR GARE SNCF")).toBe("Montelimar Gare SNCF");
  });

  it("takes a city's own spelling, else the override table, and keeps the id", () => {
    const r = new StationRegistry(stations as Station[]);
    const ids = [
      "SETE",
      "BRIVE LA GAILLARDE",
      "CHAMPAGNE ARDENNE TGV",
      "ST BRIEUC",
      "NIMES CENTRE",
      "CALAIS FRETHUN",
      "AEROPORT ROISSY CDG 2 TGV",
      "ST PIERRE DES CORPS",
    ];
    r.addMissing(ids);
    expect(ids.map((id) => r.label(id))).toEqual([
      "Sète",
      "Brive-la-Gaillarde",
      "Champagne-Ardenne TGV",
      "Saint-Brieuc",
      "Nîmes Centre",
      "Calais Frethun", // matched by an alias, whose spelling is not a display name
      "Aéroport Roissy CDG 2 TGV",
      "Saint-Pierre-des-Corps",
    ]);
    for (const id of ids) expect(r.get(id)?.id).toBe(id);
    expect(r.label("BELFORT MONTBELIARD TGV")).toBe("Belfort-Montbéliard TGV");
  });
});

describe("coupled trains", () => {
  const row = (train_no: string, heure_depart = "10:00"): RawRecord => ({
    date: "2026-06-25",
    origine: "PARIS (intramuros)",
    destination: "RENNES",
    heure_depart,
    heure_arrivee: "11:25",
    train_no,
    od_happy_card: "OUI",
    axe: "ATLANTIQUE",
  });

  it("shows two numbers on the same run as one journey naming both", () => {
    const trains = normalizeRecords([row("12209"), row("8609"), row("8611", "09:30")]);
    const js = findJourneys(trains, "PARIS (intramuros)", "RENNES", "2026-06-25", { maxConnections: 0 });
    expect(js.map((j) => j.legs.map((l) => l.trainNo).join(">"))).toEqual(["8611", "12209 / 8609"]);
    // The calendar counts the same journeys the list shows.
    const [day] = availabilityCalendar(trains, "PARIS (intramuros)", "RENNES", ["2026-06-25"], { maxConnections: 0 });
    expect(day!.count).toBe(2);
  });
});

describe("accessible names", () => {
  function setup(search: string, favorites?: unknown, extra: Station[] = []): HTMLElement {
    localStorage.clear();
    localStorage.setItem("mj.settings", JSON.stringify({ lang: "en" }));
    if (favorites) localStorage.setItem("mj.favorites", JSON.stringify(favorites));
    document.body.innerHTML = '<div id="app"></div>';
    const root = document.getElementById("app") as HTMLElement;
    history.replaceState(null, "", `/${search}`);
    const meta: DataMeta = { updatedAt: "", source: "sample", recordCount: 0, isSample: true };
    initApp(root, { trains: normalizeRecords(sample as RawRecord[]), meta }, new StationRegistry([...(stations as Station[]), ...extra]));
    return root;
  }
  const P = encodeURIComponent("PARIS (intramuros)");

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-25T12:00:00Z"));
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    }) as typeof requestAnimationFrame;
    Element.prototype.scrollIntoView = function scrollIntoView(): void {};
  });
  afterEach(() => vi.useRealTimers());

  it("names each Settings switch by its label", () => {
    setLang("en");
    HTMLDialogElement.prototype.showModal = function showModal(): void {};
    document.body.innerHTML = "";
    const noop = (): void => {};
    showSettingsModal({ reduceMotion: false, map: true, compact: false, onReduceMotion: noop, onMap: noop, onCompact: noop, onLowEnd: noop });
    const names = [...document.querySelectorAll('[role="switch"]')].map(
      (s) => document.getElementById(s.getAttribute("aria-labelledby") ?? "")?.textContent,
    );
    expect(names).toEqual(["Low-end device", "Reduce motion", "Show map", "Compact results"]);
  });

  it("names the remove and star buttons with their route", () => {
    const root = setup(`?mode=from&from=${P}&date=2026-06-25`, [
      { origin: "PARIS (intramuros)", destination: "LYON (intramuros)" },
    ]);
    const remove = root.querySelector(".fav-row .iconbtn");
    expect(remove?.getAttribute("aria-label")).toBe("Remove from favorites — Paris → Lyon");
    const stars = [...root.querySelectorAll(".star")].map((s) => s.getAttribute("aria-label"));
    expect(stars.length).toBeGreaterThan(1);
    expect(new Set(stars).size).toBe(stars.length);
    expect(stars).toContain("Remove from favorites — Paris → Lyon");
    expect(stars).toContain("Add to favorites — Paris → Lille");
  });

  it("keeps focus on the language control after the language changes", () => {
    setup(`?mode=from&from=${P}&date=2026-06-25`);
    const sel = document.querySelector<HTMLSelectElement>(".menu-selects select")!;
    sel.focus();
    sel.value = "de";
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    const now = document.activeElement as HTMLSelectElement;
    expect(now.closest(".menu-selects")).not.toBeNull();
    expect(now.value).toBe("de");
  });

  it("names country regions in the UI language, keeping the stored value", () => {
    const frankfurt: Station = { id: "FRANKFURT", label: "Frankfurt", lat: 50.107, lng: 8.663, region: "Allemagne" };
    const root = setup(`?mode=best&from=${P}`, undefined, [frankfurt]);
    const region = [...root.querySelectorAll("select option")].find((o) => o.textContent === "Germany") as HTMLOptionElement;
    expect(region?.value).toBe("Allemagne");
  });
});
