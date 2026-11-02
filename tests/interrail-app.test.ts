import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Leaflet needs a real browser canvas; stub the map module (as the smoke suite does).
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

// Another pass's timetable loads from the network; hand back the sample's MAX trains.
vi.mock("../src/data/dataset", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/data/dataset")>();
  const { default: rows } = await import("../data/tgvmax.sample.json");
  return {
    ...real,
    loadDataset: vi.fn(async (profile: import("../src/data/profile").DatasetProfile) => ({
      trains: real.normalizeRecords(rows as RawRecord[], profile),
      meta: { updatedAt: "", source: "sample", recordCount: 0, isSample: true },
      profile,
    })),
  };
});

import type { RawRecord, Station, DataMeta } from "../src/types";
import { normalizeRecords, loadDataset } from "../src/data/dataset";
import { INTERRAIL_PROFILE, SNCF_PROFILE } from "../src/data/profile";
import { setSeatUnknown } from "../src/i18n";
import { StationRegistry } from "../src/data/stations";
import { initApp } from "../src/app";
import sample from "../data/tgvmax.sample.json";
import stations from "../data/stations.json";

const P = "PARIS (intramuros)";
const L = "LYON (intramuros)";
const meta: DataMeta = { updatedAt: "", source: "sample", recordCount: 0, isSample: true };

/** Mount the app on the Interrail snapshot at `search`. */
function setup(search: string): HTMLElement {
  localStorage.clear();
  document.body.innerHTML = '<div id="app"></div>';
  const root = document.getElementById("app") as HTMLElement;
  history.replaceState(null, "", `/${search}`);
  initApp(
    root,
    { trains: normalizeRecords(sample as RawRecord[], INTERRAIL_PROFILE), meta, profile: INTERRAIL_PROFILE },
    new StationRegistry(stations as Station[]),
  );
  return root;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-06-25T12:00:00Z"));
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  }) as typeof requestAnimationFrame;
  Element.prototype.scrollIntoView = function scrollIntoView(): void {};
});

afterEach(() => {
  vi.useRealTimers();
  setSeatUnknown(false);
});

describe("Interrail pass (app)", () => {
  it("says the seat is unknown above the results and shows the pass as picked", () => {
    const root = setup(`?mode=od&from=${encodeURIComponent(P)}&to=${encodeURIComponent(L)}&date=2026-06-25&card=interrail`);
    const notices = [...root.querySelectorAll(".notice")].map((n) => n.textContent ?? "");
    expect(notices.some((n) => n.includes("Interrail"))).toBe(true);
    const select = root.querySelector<HTMLSelectElement>(".header-quick select");
    expect(select?.value).toBe("interrail");
    expect(root.textContent).not.toContain("place MAX");
    // The route resolved and rendered its trains.
    expect(root.querySelectorAll(".journey").length).toBeGreaterThan(0);
  });

  it("switches to a MAX pass in place, without leaving the page", async () => {
    const url = `?mode=od&from=${encodeURIComponent(P)}&to=${encodeURIComponent(L)}&date=2026-06-25&card=interrail`;
    const root = setup(url);
    const select = root.querySelector<HTMLSelectElement>(".header-quick select")!;
    select.value = "jeune";
    select.dispatchEvent(new Event("change"));
    // The page stays up, dimmed under a spinner, while the MAX timetable loads.
    expect(root.classList.contains("pass-loading")).toBe(true);
    expect(root.querySelector(".pass-spinner")).not.toBeNull();
    await vi.waitFor(() => expect(root.classList.contains("pass-loading")).toBe(false));
    expect(loadDataset).toHaveBeenCalledWith(SNCF_PROFILE, expect.any(String));
    expect(root.querySelector(".pass-spinner")).toBeNull();
    expect(select.value).toBe("jeune");
    expect(location.search).toContain("card=jeune");
    const notices = [...root.querySelectorAll(".notice")].map((n) => n.textContent ?? "");
    expect(notices.some((n) => n.includes("Interrail"))).toBe(false);
    expect(root.querySelectorAll(".journey").length).toBeGreaterThan(0);
  });
});
