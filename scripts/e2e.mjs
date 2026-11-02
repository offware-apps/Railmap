/**
 * scripts/e2e.mjs — end-to-end behaviour tests for the built app.
 *
 * Where `verify-render.mjs` only proves the app *mounts* without errors,
 * this drives real user journeys against the built `dist` in headless Chromium
 * and asserts on observable behaviour: the right results title, populated (or a
 * valid empty) results panel, mode switching, the "staged edits only apply on
 * Search" model, deep-link routing, history back/forward, and the PWA manifest.
 *
 * It runs fully offline against the committed data snapshot (public/data), so it
 * needs no network. Cross-origin failures (Leaflet map tiles) are ignored — only
 * uncaught page errors and *same-origin* resource failures fail a scenario, the
 * same policy as verify-render.mjs.
 *
 *   npm run build && npm run test:e2e
 *
 * Exit 0 = every scenario passed; exit 1 = at least one failed (prints details).
 */
import http from "node:http";
import { readFileSync, existsSync, statSync, mkdtempSync } from "node:fs";
import { join, extname } from "node:path";
import { tmpdir } from "node:os";
import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";

const DIST = join(process.cwd(), "dist");
if (!existsSync(join(DIST, "index.html"))) {
  console.error("dist/index.html not found — run `npm run build` first.");
  process.exit(1);
}
const TYPES = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
  ".webmanifest": "application/manifest+json", ".map": "application/json",
  ".txt": "text/plain", ".xml": "application/xml", ".ico": "image/x-icon",
};

// Serve dist, mirroring the GitHub-Pages /Railmap/ base-path rewrite.
const server = http.createServer((req, res) => {
  let p = decodeURIComponent((req.url || "/").split("?")[0])
    .replace(/^\/Railmap\//, "/")
    .replace(/^\/+/, "");
  let file = join(DIST, p);
  if (!file.startsWith(DIST)) return res.writeHead(403).end();
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(DIST, "index.html");
  if (!existsSync(file)) return res.writeHead(404).end("not found");
  res.writeHead(200, { "Content-Type": TYPES[extname(file)] || "application/octet-stream" });
  // Runs on the bundled snapshot, never the live train-api (see trainApiBase in src/config.ts).
  const body = readFileSync(file);
  res.end(file.endsWith(".html") ? body.toString("utf-8").replace(/<meta name="train-api"[^>]*>/, "") : body);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PORT = server.address().port;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const BASE = `${ORIGIN}/Railmap/`;

const cargs = chromium.args.filter((a) => !a.startsWith("--user-data-dir") && !a.startsWith("--proxy"));
const browser = await puppeteer.launch({
  args: [...cargs, "--no-sandbox", "--disable-setuid-sandbox", "--no-proxy-server"],
  executablePath: await chromium.executablePath(),
  headless: true,
  userDataDir: mkdtempSync(join(tmpdir(), "e2e-")),
});

const DATE = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
const DATE2 = new Date(Date.now() + 6 * 86_400_000).toISOString().slice(0, 10);
const P = "PARIS (intramuros)";
const T = "TOULOUSE MATABIAU";
const L = "LYON (intramuros)";
const enc = encodeURIComponent;

// The committed snapshot's trains, empty when the file can't be read.
let TRAINS = [];
try {
  const raw = JSON.parse(readFileSync(join(DIST, "data", "tgvmax.json"), "utf-8"));
  TRAINS = Array.isArray(raw) ? raw : raw.trains || [];
} catch {}

// The round-trip scenario needs a REAL outbound journey on the chosen day: the return
// availability calendar only renders once the outbound produced at least one journey.
// Free-MAX availability is spotty day-to-day in the committed snapshot (some dates have
// no Paris→Lyon at all), so a blind now+5d would land on an empty day and flake. Pick,
// instead, the first snapshot date that actually has a Paris→Lyon MAX outbound — and its
// next day for the return — so the scenario is deterministic against whatever snapshot
// is committed. Falls back to the plain now+5d dates if the data can't be read.
function pickRoundTripDates() {
  const today = new Date().toISOString().slice(0, 10);
  const days = [
    ...new Set(
      TRAINS
        .filter((t) => t.origine === P && t.destination === L && t.od_happy_card === "OUI" && t.date >= today)
        .map((t) => t.date),
    ),
  ].sort();
  if (!days.length) return [DATE, DATE2];
  const out = days[0];
  const next = new Date(`${out}T00:00:00Z`).getTime() + 86_400_000;
  return [out, new Date(next).toISOString().slice(0, 10)];
}
const [RT_DATE, RT_DATE2] = pickRoundTripDates();

// The Ideas and scroll scenarios need a long Paris list, and a day five days out can carry
// a dozen destinations. Pick the snapshot day, from tomorrow on, with the most of them.
function pickBusiestParisDate() {
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const dests = new Map();
  for (const t of TRAINS) {
    if (t.origine !== P || t.od_happy_card !== "OUI" || t.date < tomorrow) continue;
    if (!dests.has(t.date)) dests.set(t.date, new Set());
    dests.get(t.date).add(t.destination);
  }
  return [...dests].sort((a, b) => b[1].size - a[1].size)[0]?.[0] ?? DATE;
}
const BUSY_DATE = pickBusiestParisDate();

// --- tiny assertion harness -------------------------------------------------
const results = [];
class Fail extends Error {}
function assert(cond, msg) {
  if (!cond) throw new Fail(msg);
}

/**
 * Open a fresh page, capture uncaught errors + same-origin request failures,
 * hand the page to `body`, then fail the scenario if anything threw or a
 * same-origin resource failed. Cross-origin failures (map tiles) are ignored.
 */
async function scenario(name, url, body, opts = {}) {
  const page = await browser.newPage();
  // Default to the desktop UI: stay above the 860px mobile breakpoint, below which
  // the form collapses into a floating search bar and the tabs move behind a menu.
  // Pass opts.viewport to exercise the mobile layout instead.
  await page.setViewport(opts.viewport ?? { width: 1366, height: 900 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("requestfailed", (r) => {
    const u = r.url();
    // Only same-origin, non-data failures are real; tiles/CDNs are expected to fail here.
    if (u.startsWith(ORIGIN) && !u.includes("/data/")) {
      errors.push(`request failed: ${u} (${r.failure()?.errorText || "?"})`);
    }
  });
  let ok = true, detail = "";
  try {
    await page.goto(url, { waitUntil: "networkidle2", timeout: 45_000 });
    // Wait for the mounted UI, never a fixed sleep: the dataset loads asynchronously
    // and a busy machine pushes the first render past whatever the guess was.
    await until(async () => (await $count(page, ".mode-tab.active")) > 0);
    await body(page);
    if (errors.length) throw new Fail(`page/same-origin errors: ${errors.join(" | ")}`);
  } catch (e) {
    ok = false;
    detail = e instanceof Fail ? e.message : `${e.name}: ${e.message}`;
  } finally {
    await page.close();
  }
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "✓" : "✗"} ${name}${ok ? "" : "\n      " + detail}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Helpers evaluated in-page.
const $count = (page, sel) => page.$$eval(sel, (els) => els.length).catch(() => 0);
const $text = (page, sel) => page.$eval(sel, (el) => el.textContent || "").catch(() => null);
// A search runs off the main thread and settles in 0.5-2.0s against the committed
// snapshot, so anything asserting on its output polls instead of sleeping a guess.
async function until(fn, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() >= deadline) return null;
    await sleep(100);
  }
}
const titleMatching = (page, re) =>
  until(async () => {
    const t = (await $text(page, "#results-title")) || "";
    return re.test(t) ? t : null;
  });
// The v2 UI tabs by trip type (data-trip: simple | return | multi | ideas); the
// search *mode* (from/to/od/tour/best) is derived from the active trip plus which
// station fields are filled, and still travels in the URL as ?mode=.
const activeTrip = (page) =>
  page.$eval(".mode-tab.active", (el) => el.getAttribute("data-trip")).catch(() => null);
const resultsState = (page) =>
  page.$eval(".results", (el) => ({
    children: el.childElementCount,
    firstClass: el.firstElementChild ? el.firstElementChild.className : null,
    hasEmpty: !!el.querySelector(".empty"),
  })).catch(() => ({ children: -1, firstClass: null, hasEmpty: false }));

// ---------------------------------------------------------------------------
console.log(`\nE2E against ${BASE} (offline, committed snapshot)\n`);

// 1. Home shell renders with the expected controls.
await scenario("home: shell renders (3 trip tabs, default 'simple', search form)", BASE, async (page) => {
  assert((await $count(page, ".mode-tab")) === 3, "expected 3 trip tabs (Trip, Multi-city, Ideas)");
  assert((await activeTrip(page)) === "simple", "default active tab should be 'simple'");
  assert((await $count(page, ".search-form")) === 1, "search form missing");
  assert((await $count(page, '.search-form input[list="station-list"]')) >= 1, "no station inputs");
  const appLen = await page.$eval("#app", (el) => el.innerHTML.length);
  assert(appLen > 3000, `#app looks blank (${appLen} chars)`);
});

// 2. Clicking a trip tab switches trip type + reflects the derived mode in the URL.
await scenario("nav: clicking the 'Multi-city' tab switches trip + URL mode", BASE, async (page) => {
  await page.click('.mode-tab[data-trip="multi"]');
  await sleep(400);
  assert((await activeTrip(page)) === "multi", "tab did not become active");
  // Multi-city derives the 'tour' search mode regardless of the station fields.
  assert(new URL(page.url()).searchParams.get("mode") === "tour", "URL mode= not updated to tour");
});

// 3. Exact-trip deep link renders the right title + a populated/valid results panel.
//    A one-way od deep link opens on the 'simple' tab (od → simple; return only when rdate is set).
await scenario(
  "deep-link: exact trip Paris → Toulouse renders titled results",
  `${BASE}?mode=od&from=${enc(P)}&to=${enc(T)}&date=${DATE}`,
  async (page) => {
    assert((await activeTrip(page)) === "simple", "active tab should be 'simple'");
    const title = await titleMatching(page, /paris[\s\S]*toulouse/i);
    assert(title, `title wrong: "${(await $text(page, "#results-title")) || ""}"`);
    const rs = await resultsState(page);
    assert(rs.children >= 1, "results panel is empty (no calendar/rows/empty-state)");
  },
);

// 4. Staged-edits model: editing the ROUTE must NOT re-run the search until Search is clicked.
//    (Regression guard for PR #12 / #18 / #19.)
await scenario(
  "behaviour: a typed route edit stays staged until Search is clicked",
  `${BASE}?mode=od&from=${enc(P)}&to=${enc(T)}&date=${DATE}`,
  async (page) => {
    const before = await titleMatching(page, /toulouse/i);
    assert(before, `precondition failed, title="${(await $text(page, "#results-title")) || ""}"`);
    // Change the destination to Lyon WITHOUT searching. `.od-fields` holds the origin
    // then the destination; the other station inputs belong to the multi-city legs.
    await page.evaluate((val) => {
      const inputs = document.querySelectorAll('.search-form .od-fields input[list="station-list"]');
      const dest = inputs[1];
      dest.value = val;
      dest.dispatchEvent(new Event("input", { bubbles: true }));
      dest.dispatchEvent(new Event("change", { bubbles: true }));
    }, L);
    await sleep(400);
    const staged = (await $text(page, "#results-title")) || "";
    assert(/toulouse/i.test(staged) && !/lyon/i.test(staged),
      `title changed before Search (staged edit leaked): "${staged}"`);
    // Now click Search — the staged change applies.
    await page.click(".search-form .form-actions button.btn-primary");
    const after = await titleMatching(page, /lyon/i);
    assert(after, `title did not update after Search: "${(await $text(page, "#results-title")) || ""}"`);
  },
);

// 4b. …while a FILTER is one deliberate choice, so it applies live: raising "Max
//     correspondances" refreshes the list and its possible-days calendar with no second
//     Search tap, and puts the applied value in the URL.
await scenario(
  "behaviour: a filter change applies live (no second Search tap)",
  `${BASE}?mode=od&from=${enc(P)}&to=${enc(T)}&conn=0`,
  async (page) => {
    const green = () =>
      page.$$eval(".results .cal-grid .cal-cell.ok", (cells) => cells.length).catch(() => 0);
    const direct = await green();
    await page.evaluate(() => {
      const sel = document.querySelector(".connections-field select.input");
      sel.value = "2";
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await sleep(900);
    const viaTwo = await green();
    assert(viaTwo > direct, `calendar did not refresh from the filter (${direct} -> ${viaTwo} green days)`);
    assert(new URL(page.url()).searchParams.get("conn") === "2", "the applied filter is not in the URL");
  },
);

// 5. Multi-city deep link (explicit legs — the v2 'multi' tab flow) renders one
//    titled leg section per hop (results or a valid empty-state, never a crash).
await scenario(
  "deep-link: multi-city Paris → Lyon → Paris renders leg sections",
  `${BASE}?mode=tour&legs=${enc(`${P}>${L}@${DATE}~${L}>${P}@${DATE2}`)}&date=${DATE}`,
  async (page) => {
    assert((await activeTrip(page)) === "multi", "active tab should be 'multi'");
    const title = await titleMatching(page, /multi/i);
    assert(title, `multi-city title wrong: "${(await $text(page, "#results-title")) || ""}"`);
    assert(await until(async () => (await $count(page, ".mc-result")) >= 1),
      "no multi-city leg sections rendered");
    const rs = await resultsState(page);
    assert(rs.children >= 1, "multi-city results panel empty");
  },
);

// 6. Ideas/best deep link ranks destinations (data-backed, expect populated).
await scenario(
  "deep-link: ideas from Paris ranks destinations",
  `${BASE}?mode=best&from=${enc(P)}&date=${BUSY_DATE}`,
  async (page) => {
    assert((await activeTrip(page)) === "ideas", "active tab should be 'ideas'");
    // Ideas discovers EVERY destination from the origin — it must render a populated ranked
    // list, not a blank/empty state (regression: the page rendered nothing).
    const rs = await until(async () => {
      const s = await resultsState(page);
      return s.children >= 3 && !s.hasEmpty ? s : null;
    });
    assert(rs, "ideas did not render a populated destination list");
    assert(
      (await $count(page, ".results [data-station], .results [class*='-row']")) > 0,
      "ideas rendered no destination rows",
    );
  },
);

// 7. History: deep-link → switch trip → Back returns to the deep-linked trip.
await scenario(
  "history: Back restores the previous trip",
  `${BASE}?mode=od&from=${enc(P)}&to=${enc(T)}&date=${DATE}`,
  async (page) => {
    assert((await activeTrip(page)) === "simple", "precondition: simple");
    await page.click('.mode-tab[data-trip="multi"]');
    await sleep(400);
    assert((await activeTrip(page)) === "multi", "did not switch to multi");
    await page.goBack({ waitUntil: "networkidle2" });
    await sleep(500);
    assert((await activeTrip(page)) === "simple", "Back did not restore 'simple'");
  },
);

// 9. Legacy tour deep-link (?cities=) restores the planner, not the legs editor.
//    Regression: v2 short-circuited every tour into the multi-city legs view, so
//    the city planner (Surprise me / Nearest / auto-ordered tour) was unreachable.
await scenario(
  "deep-link: legacy ?cities= tour restores the planner (not the legs editor)",
  `${BASE}?mode=tour&from=${enc(P)}&cities=${enc(L)}&date=${DATE}&dmin=1&dmax=3`,
  async (page) => {
    assert((await activeTrip(page)) === "multi", "active tab should be 'multi'");
    // The Multi tab is on its 'plan' sub-mode (the tour planner), not the leading
    // 'legs' one — so it's the SECOND button in the switch that must be pressed.
    const planPressed = await page
      .$eval(".multi-switch .multi-tab:nth-of-type(2)", (el) => el.getAttribute("aria-pressed"))
      .catch(() => null);
    assert(planPressed === "true", "the tour-plan sub-mode is not active");
    // The planner ran: no explicit-leg sections, and a real result (a tour card or a
    // valid empty-state), never the legs editor's "fill in a leg" hint.
    assert((await $count(page, ".mc-result")) === 0, "legs editor rendered instead of the planner");
    const rs = await resultsState(page);
    assert(rs.children >= 1, "planner produced no output");
  },
);

// 10. Legacy od + rdate deep-link opens the Trip tab with the round-trip control on —
//     the trip-type control is now a 2-option segmented toggle (Aller simple / Aller-
//     retour) plus a nights stepper shown only for a round trip. RT_DATE2 is RT_DATE + 1
//     day, so a return-the-next-day link resolves to "Aller-retour" pressed with the
//     stepper on "1 night". Both legs still render as a two-step accordion; the outbound
//     possible-days calendar is collapsed by default, the return shown.
await scenario(
  "deep-link: od + rdate opens the Trip tab with the round-trip toggle + 1-night stepper on",
  `${BASE}?mode=od&from=${enc(P)}&to=${enc(L)}&date=${RT_DATE}&rdate=${RT_DATE2}`,
  async (page) => {
    assert((await activeTrip(page)) === "simple", "active tab should be 'simple' (Trip)");
    // Return the next day = 1 night → the "Aller-retour" segment (2nd) reads pressed, the
    // "Aller simple" segment (1st) must NOT, and the nights stepper shows "1 night".
    const roundOn = await page
      .$eval(".trip-toggle .trip-seg:nth-of-type(2)", (el) => el.getAttribute("aria-pressed") === "true")
      .catch(() => false);
    const onewayOff = await page
      .$eval(".trip-toggle .trip-seg:nth-of-type(1)", (el) => el.getAttribute("aria-pressed") !== "true")
      .catch(() => false);
    const stepperText = await page.$eval(".nights-val", (el) => el.textContent?.trim()).catch(() => "");
    assert(roundOn, "'Aller-retour' segment should be pressed for a next-day return");
    assert(onewayOff, "'Aller simple' segment should not be pressed when a return is set");
    // Locale of the headless browser can be en or fr; accept either 1-night label.
    assert(["1 night", "1 nuit"].includes(stepperText), `nights stepper should read one night (got '${stepperText}')`);
    // Two-leg accordion (Aller / Retour), each a collapsible .mc-result section.
    assert(await until(async () => (await $count(page, ".mc-result")) === 2),
      "expected a two-leg accordion (outbound + return)");
    // Both possible-days calendars (outbound + return) are collapse-by-click: for a FIXED
    // 1-night stay each is collapsed behind its own "Départ / Retour : … · Changer" toggle,
    // so at least two calendar grids and two toggles exist in the DOM.
    assert(await until(async () => (await $count(page, ".cal-grid")) >= 2),
      "expected the outbound + return availability calendars");
    assert(await until(async () => (await $count(page, ".cal-toggle")) >= 2),
      "expected both collapsed-calendar toggles");
  },
);

// 11. Mobile layout: below 860px the app is either the full form sheet or the
//     full-bleed map + results drawer behind a floating search bar — never both.
//     A deep link opens on results (it already carries a search); the bar reopens
//     the form and Search collapses it again. Asserts on what is *displayed*, not
//     on presence — every one of these nodes also exists at 1366px (they are only
//     display:none'd), so counting them proves nothing.
await scenario(
  "mobile: the form sheet and the results drawer swap at 390px",
  `${BASE}?mode=od&from=${enc(P)}&to=${enc(T)}&date=${DATE}`,
  async (page) => {
    const shown = (sel) =>
      page.$eval(sel, (el) => el.getBoundingClientRect().height > 0).catch(() => false);
    const mform = () => page.$eval("#app", (el) => el.dataset.mform);
    // A shared link runs its search straight away, so it lands on the results view.
    assert((await mform()) === "results", `deep link should land on results, got "${await mform()}"`);
    assert(await shown(".msearch-bar"), "no floating search bar after a mobile deep link");
    assert(await shown(".results-drawer"), "the results drawer is not displayed");
    assert(!(await shown(".search-form")), "the form sheet should be collapsed on results");
    // The results view is locked to 100dvh: neither axis may scroll the page.
    const over = await page.evaluate(() => ({
      x: document.documentElement.scrollWidth - window.innerWidth,
      y: document.documentElement.scrollHeight - window.innerHeight,
    }));
    assert(over.x <= 2, `page scrolls horizontally at 390px (${over.x}px)`);
    assert(over.y <= 2, `results view scrolls vertically at 390px (${over.y}px)`);
    // The bar reopens the whole form...
    await page.click(".msearch-bar");
    await sleep(900); // the bar→form view transition runs 0.34s
    assert((await mform()) === "form", `the bar should reopen the form, got "${await mform()}"`);
    assert(await shown(".search-form"), "the form sheet did not open from the search bar");
    assert(!(await shown(".msearch-bar")), "the collapsed bar should be hidden while the form is open");
    // ...and searching collapses it back to the drawer.
    await page.click(".search-form .form-actions button.btn-primary");
    await sleep(900);
    assert((await mform()) === "results", `searching should return to results, got "${await mform()}"`);
    assert(await shown(".results-drawer"), "the results drawer is not displayed after searching");
    assert(!(await shown(".search-form")), "the form sheet should be collapsed after searching");
  },
  { viewport: { width: 390, height: 844, isMobile: true, hasTouch: true } },
);

// 13. Regression: refining the trip type (Aller-retour / nights stepper) on a results page
//     must NOT push new history entries. The old bug pushed one per toggle, so browser Back
//     needed ~10 presses and showed "the same window again and again", and the departure
//     appeared wiped. Assert zero pushes + zero history growth across several refinements,
//     and that a single Back returns to the form with the route still filled.
await scenario(
  "history: refining the trip type does not pile up entries; one Back restores the form",
  `${BASE}?mode=od&from=${enc(P)}&to=${enc(L)}&date=${DATE}`,
  async (page) => {
    assert((await activeTrip(page)) === "simple", "precondition: Trip tab");
    await page.evaluate(() => {
      window.__ps = 0;
      const orig = history.pushState.bind(history);
      history.pushState = function (s, t, u) {
        window.__ps++;
        return orig(s, t, u);
      };
    });
    const before = await page.evaluate(() => history.length);
    for (let i = 0; i < 6; i++) {
      await page.evaluate((k) => document.querySelectorAll(".trip-toggle .trip-seg")[k % 2]?.click(), i);
      await sleep(70);
      await page.evaluate(() => {
        const s = document.querySelectorAll(".nights-step")[1];
        if (s && !s.disabled) s.click();
      });
      await sleep(70);
    }
    const pushes = await page.evaluate(() => window.__ps);
    const after = await page.evaluate(() => history.length);
    assert(pushes === 0, `refining the trip type pushed ${pushes} history entries (must be 0)`);
    assert(after === before, `history grew ${before}→${after} on in-place refinement`);
    // One Back leaves the deep-linked results (no stack of duplicate results pages to wade
    // through). (Form-state restoration after a manual fill is exercised in the unit tests.)
    await page.goBack({ waitUntil: "networkidle2" });
    await sleep(400);
    assert(!new URL(page.url()).searchParams.get("from"), "one Back did not leave the results page");
  },
);

// 14. Regression: toggle Round trip on the form, THEN press Search — the search must not
//     push a second, identical results entry (the old bug left two duplicate screens, so
//     Back needed two presses: "I go round trip, I search, then have to return twice").
await scenario(
  "history: toggle Round trip then Search adds no duplicate entry (one Back to the form)",
  BASE,
  async (page) => {
    await page.evaluate(
      (o, d) => {
        const [oi, di] = document.querySelectorAll("input.has-clear");
        for (const [el, v] of [
          [oi, o],
          [di, d],
        ]) {
          el.value = v;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        }
      },
      P,
      L,
    );
    await sleep(500);
    await page.evaluate(() => document.querySelectorAll(".trip-toggle .trip-seg")[1]?.click()); // Round trip
    await sleep(700);
    const afterToggle = await page.evaluate(() => history.length);
    await page.evaluate(() => {
      const b = [...document.querySelectorAll("button")].find((x) => /search|recherch/i.test(x.textContent || ""));
      b?.click();
    });
    await sleep(900);
    const afterSearch = await page.evaluate(() => history.length);
    assert(afterSearch === afterToggle, `Search after a toggle grew history ${afterToggle}→${afterSearch} (duplicate entry)`);
    await page.goBack({ waitUntil: "networkidle2" });
    await sleep(500);
    assert(!new URL(page.url()).searchParams.get("from"), "one Back did not return to the form");
    const filled = await page.$$eval("input.has-clear", (els) => els.map((e) => e.value).join("|"));
    assert(/Paris/i.test(filled) && /Lyon/i.test(filled), `form not restored after Back (got "${filled}")`);
  },
  { viewport: { width: 390, height: 844, isMobile: true, hasTouch: true } },
);

// 15. Regression: build a FLEXIBLE round trip interactively, then Back — the whole build
//     (route + Flexible + the départ→retour range) must be restored, not a form frozen at
//     the same-day round trip it was the instant "Aller-retour" was toggled. ("Keep all data
//     of the initial form across every screen — still not the case for flexible.")
await scenario(
  "history: Back restores an interactively-built Flexible round trip",
  BASE,
  async (page) => {
    await page.evaluate(
      (o, d) => {
        const [oi, di] = document.querySelectorAll("input.has-clear");
        for (const [el, v] of [[oi, o], [di, d]]) {
          el.value = v;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        }
      },
      P,
      L,
    );
    await sleep(500);
    await page.evaluate(() => document.querySelectorAll(".trip-toggle .trip-seg")[1]?.click()); // Round trip
    await sleep(300);
    await page.evaluate(() => document.querySelector(".nights-flex")?.click()); // Flexible
    await sleep(400);
    // The calendar never auto-opens — tap its header to reveal the départ → retour grid.
    await page.evaluate(() => {
      const body = document.querySelector(".form-cal-body");
      if (body?.hasAttribute("hidden")) document.querySelector(".form-cal-toggle")?.click();
    });
    await sleep(300);
    // Tap a départ then a later retour on the (now open) Flexible calendar.
    const dep = await page.evaluate(() => {
      const cs = [...document.querySelectorAll(".form-cal-mount .cal-cell")];
      const t = cs.find((c) => c.classList.contains("ok")) || cs[2];
      t.click();
      return t.getAttribute("data-date");
    });
    await sleep(300);
    await page.evaluate((d) => {
      const cs = [...document.querySelectorAll(".form-cal-mount .cal-cell")];
      const i = cs.findIndex((c) => c.getAttribute("data-date") === d);
      (cs[i + 4] || cs[cs.length - 1]).click();
    }, dep);
    await sleep(600);
    const built = await page.evaluate(() => ({
      flex: document.querySelector(".nights-flex")?.getAttribute("aria-pressed"),
      rdate: new URL(location.href).searchParams.get("rdate"),
    }));
    assert(built.flex === "true" && built.rdate, `precondition: flexible range not built (${JSON.stringify(built)})`);
    await page.goBack({ waitUntil: "networkidle2" });
    await sleep(500);
    const restored = await page.evaluate(() => ({
      flex: document.querySelector(".nights-flex")?.getAttribute("aria-pressed"),
      range: document.querySelectorAll(".form-cal-mount .cal-cell.range").length,
      filled: [...document.querySelectorAll("input.has-clear")].map((e) => e.value).join("|"),
    }));
    assert(restored.flex === "true", `Back dropped Flexible (nights-flex aria-pressed=${restored.flex})`);
    assert(restored.range > 0, "Back dropped the départ→retour range band");
    assert(/Paris/i.test(restored.filled) && /Lyon/i.test(restored.filled), `Back wiped the route (got "${restored.filled}")`);
  },
  { viewport: { width: 390, height: 844, isMobile: true, hasTouch: true } },
);

const MOBILE = { width: 390, height: 844, isMobile: true, hasTouch: true };
const urlParam = (page, key) => new URL(page.url()).searchParams.get(key);
const fields = (page) => page.$$eval(".search-form .od-fields input", (els) => els.map((e) => e.value).join("|"));
async function fillOd(page, from, to) {
  await page.evaluate(
    (vals) => {
      const inputs = document.querySelectorAll(".search-form .od-fields input");
      vals.forEach((v, i) => {
        inputs[i].value = v;
        inputs[i].dispatchEvent(new Event("input", { bubbles: true }));
        inputs[i].dispatchEvent(new Event("change", { bubbles: true }));
      });
    },
    [from, to],
  );
}
// The landing searches today, which the snapshot may carry no Paris → Lyon train for: pin
// the form's date to RT_DATE, a day that has one, before a scenario searches from it.
async function fillDate(page, date) {
  await page.evaluate((d) => {
    const input = document.querySelector(".search-form input.dp-native");
    input.value = d;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, date);
}
const clickSearch = (page) => page.click(".search-form .form-actions button.btn-primary");

// 16. Regression: each history entry restores its OWN form and tab. Search Paris → Lyon from
//     the landing, open Ideas, Back twice: the landing comes back on the Trip tab with Paris →
//     Lyon filled (not the Ideas form built after it), and its bare URL shows no results.
await scenario(
  "history: Back to the landing restores its own form and tab, with no results under it",
  BASE,
  async (page) => {
    await fillOd(page, P, L);
    await fillDate(page, RT_DATE);
    await clickSearch(page);
    assert(await until(async () => (await $count(page, "article.journey")) > 0), "precondition: no Paris → Lyon results");
    await page.click('.mode-tab[data-trip="ideas"]');
    assert(await until(async () => urlParam(page, "mode") === "best"), "precondition: Ideas did not open");
    await page.goBack();
    await page.goBack();
    assert(await until(async () => !new URL(page.url()).search), `two Backs did not reach the landing (${page.url()})`);
    const landed = await until(async () =>
      (await activeTrip(page)) === "simple" && (await $count(page, ".results .empty")) > 0 ? true : null,
    );
    assert(landed, `landing shows tab "${await activeTrip(page)}", results "${(await $text(page, ".results"))?.slice(0, 60)}"`);
    const filled = await fields(page);
    assert(/paris/i.test(filled) && /lyon/i.test(filled), `landing form is not its own (got "${filled}")`);
    const rows = await $count(page, ".results .group-card, .results article.journey");
    assert(rows === 0, `the bare landing URL shows ${rows} result rows`);
  },
);

// 17. Regression: the tab follows the entry, not the last form. Legs link → Ideas (no origin)
//     → Multi-city → Back must land on the Ideas tab its URL names, without the legs results.
await scenario(
  "history: Back to an Ideas entry shows the Ideas tab, not the Multi-city built after it",
  `${BASE}?mode=tour&legs=${enc(`${P}>${L}@${DATE}`)}&date=${DATE}`,
  async (page) => {
    assert(await until(async () => (await $count(page, ".mc-result")) > 0), "precondition: legs did not render");
    await page.click('.mode-tab[data-trip="ideas"]');
    assert(await until(async () => urlParam(page, "mode") === "best"), "precondition: Ideas did not open");
    await page.click('.mode-tab[data-trip="multi"]');
    assert(await until(async () => urlParam(page, "mode") === "tour"), "precondition: Multi-city did not open");
    await page.goBack();
    const back = await until(async () =>
      urlParam(page, "mode") === "best" && (await activeTrip(page)) === "ideas" && (await $count(page, ".mc-result")) === 0,
    );
    assert(back, `Back to ?mode=best shows tab "${await activeTrip(page)}" with ${await $count(page, ".mc-result")} legs`);
  },
);

// 18. Regression: the saved-trips page is its own history entry. See all → Back → Forward
//     must land on the saved page again, not on the list under it.
await scenario(
  "history: Forward returns to the saved-trips page",
  `${BASE}?mode=od&from=${enc(P)}&to=${enc(L)}&date=${RT_DATE}`,
  async (page) => {
    assert(await until(async () => (await $count(page, "article.journey button[aria-pressed]")) > 0), "precondition: no train to save");
    await page.click("article.journey button[aria-pressed]");
    await page.click(".saved-see-all");
    assert(await until(async () => (await $count(page, ".saved-page-card")) > 0), "the saved-trips page did not open");
    await page.goBack();
    assert(await until(async () => (await $count(page, "article.journey")) > 0), "Back did not return to the list");
    await page.goForward();
    assert(
      await until(async () => (await $count(page, ".saved-page-card")) > 0 && (await $count(page, "article.journey")) === 0),
      `Forward shows "${await $text(page, "#results-title")}" instead of the saved-trips page`,
    );
  },
);

// 19. Regression: a dialog owns one history entry. At 390px, Back with a dialog open closes
//     it and stays on the results; a dialog closed by its own button leaves no stray entry,
//     so the next Back reaches the form.
await scenario(
  "history: Back closes an open dialog first; a dialog closed by its button leaves no entry",
  BASE,
  async (page) => {
    await fillOd(page, P, L);
    await fillDate(page, RT_DATE);
    await clickSearch(page);
    assert(await until(async () => (await $count(page, "article.journey")) > 0), "precondition: no Paris → Lyon results");
    const openDialog = async () => {
      await page.keyboard.press("?");
      assert(await until(async () => (await $count(page, "dialog[open]")) === 1), "the help dialog did not open");
    };
    await openDialog();
    await page.goBack();
    assert(await until(async () => (await $count(page, "dialog[open]")) === 0), "Back left the dialog open");
    assert(urlParam(page, "from"), "Back with a dialog open left the results page");
    assert((await $count(page, "article.journey")) > 0, "Back with a dialog open re-rendered the page empty");
    await openDialog();
    await page.click("dialog[open] .modal-close");
    assert(await until(async () => (await $count(page, "dialog[open]")) === 0), "the Close button did not close the dialog");
    await page.goBack();
    assert(await until(async () => !urlParam(page, "from")), `one Back after closing did not reach the form (${page.url()})`);
  },
  { viewport: MOBILE },
);

// 20. Regression: Back from a drilled-in route puts the list back where it was scrolled, in
//     the drawer at 390px and in the main column at 1366px.
for (const [viewport, label] of [[MOBILE, "390px drawer"], [undefined, "1366px column"]]) {
  await scenario(
    `history: Back from a route restores the list's scroll (${label})`,
    `${BASE}?mode=from&from=${enc(P)}&date=${BUSY_DATE}`,
    async (page) => {
      assert(await until(async () => (await $count(page, ".results .group-card")) > 30), "precondition: short list");
      const scrollTop = () =>
        page.evaluate(() => {
          const el = [".drawer-scroll", ".main-col"]
            .map((s) => document.querySelector(s))
            .find((e) => e && /auto|scroll/.test(getComputedStyle(e).overflowY));
          return (el ?? document.scrollingElement).scrollTop;
        });
      await page.evaluate(() => document.querySelectorAll(".results .group-card")[25].scrollIntoView());
      const before = await scrollTop();
      assert(before > 500, `precondition: the list did not scroll (${before}px)`);
      await page.evaluate(() => {
        const card = document.querySelectorAll(".results .group-card")[25];
        (card.querySelector(".dest-main") || card).click();
      });
      assert(await until(async () => (await $count(page, ".back-btn")) > 0), "the route did not open");
      await page.goBack();
      const restored = await until(async () => Math.abs((await scrollTop()) - before) <= 2);
      assert(restored, `Back put the list at ${await scrollTop()}px, it was at ${before}px`);
    },
    viewport && { viewport },
  );
}

// 21. Regression: "See all dates" in the trip dialog shows the dates in place — both
//     calendars open, same page — instead of re-running the route as a new detail page.
await scenario(
  "trip dialog: 'See all dates' opens the calendars in place, with no new page",
  `${BASE}?mode=od&from=${enc(P)}&to=${enc(L)}&date=${RT_DATE}&rdate=${RT_DATE2}`,
  async (page) => {
    assert(await until(async () => page.$eval(".rt-view-ticket", (b) => !b.hidden).catch(() => false)), "precondition: no ticket");
    const url = page.url();
    await page.click(".rt-view-ticket");
    assert(await until(async () => (await $count(page, "dialog[open] .trip-more")) === 1), "the trip dialog did not open");
    await page.click("dialog[open] .trip-more");
    const opened = await until(async () =>
      (await $count(page, "dialog[open]")) === 0 && (await $count(page, '.results .cal-toggle[aria-expanded="true"]')) >= 2,
    );
    assert(opened, `calendars open: ${await $count(page, '.results .cal-toggle[aria-expanded="true"]')} of 2`);
    assert(page.url() === url, `the URL changed to ${page.url()}`);
    assert((await $count(page, ".back-btn")) === 0, "'See all dates' opened a new detail page");
  },
);

// 22. Regression: the tab shortcuts keep working after one lands on an empty tab. Landing
//     on the empty Trip tab must not pull focus into its field, where "3" would be typed.
await scenario(
  "keyboard: 1/2/3 keep switching tabs after landing on an empty one",
  `${BASE}?mode=tour&date=${DATE}`,
  async (page) => {
    await page.keyboard.press("1");
    const settled = await until(async () => (await activeTrip(page)) === "simple" && (await $count(page, ".results .loading")) === 0);
    assert(settled, "'1' did not open the Trip tab");
    await page.keyboard.press("3");
    const ideas = await until(async () => (await activeTrip(page)) === "ideas");
    assert(ideas, `'3' did not open Ideas; the fields read "${await fields(page)}"`);
    await page.keyboard.press("?");
    assert(await until(async () => (await $count(page, "dialog[open]")) === 1), "'?' did not open the shortcuts help");
  },
);

// 23. A pinch on the map (ctrl+wheel in Chromium/Firefox, gesture events in Safari) zooms the
//     map and is kept from zooming the page; a plain wheel still scrolls the page.
await scenario(
  "map: a pinch zooms the map, not the page",
  `${BASE}?mode=od&from=${enc(P)}&to=${enc(T)}&date=${DATE}`,
  async (page) => {
    assert(await until(async () => (await $count(page, ".leaflet-container .leaflet-tile")) > 0), "the map never drew");
    // Tiles fail to load offline, but their src still names the zoom level.
    const zoom = () =>
      page.$$eval(".leaflet-tile", (ts) => Math.max(...ts.map((t) => +(t.src.match(/\/(\d+)\/\d+\/\d+\.png/) || [])[1])));
    const fire = (type, init) =>
      page.$eval(".leaflet-container", (el, type, init) => {
        const r = el.getBoundingClientRect();
        const opts = { bubbles: true, cancelable: true };
        const at = { clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 };
        const e =
          type === "wheel"
            ? new WheelEvent(type, { ...opts, ...at, ...init })
            : Object.assign(new Event(type, opts), at, init); // Safari's GestureEvent, which Chromium lacks
        el.dispatchEvent(e);
        return e.defaultPrevented;
      }, type, init);
    // Let the results' fit-to-route settle first.
    let last = -1;
    await until(async () => { const z = await zoom(); const same = z === last; last = z; await sleep(400); return same; });
    const z0 = await zoom();
    assert(!(await fire("wheel", { deltaY: 100 })), "a plain wheel over the map no longer scrolls the page");
    let kept = true;
    for (let i = 0; i < 10; i++) kept = (await fire("wheel", { deltaY: -10, ctrlKey: true })) && kept;
    assert(kept, "a trackpad pinch on the map was left to zoom the page");
    assert(await until(async () => (await zoom()) > z0), "a trackpad pinch did not zoom the map in");
    const z1 = await zoom();
    assert(await fire("gesturestart", { scale: 1 }), "a Safari pinch on the map was left to zoom the page");
    await fire("gesturechange", { scale: 0.4 });
    await fire("gestureend", { scale: 0.4 });
    assert(await until(async () => (await zoom()) < z1), "a Safari pinch did not zoom the map out");
  },
);

// Switching MAX → Interrail loads the other timetable with the page still up: no
// navigation, a "Loading…" pill over dimmed results, then the Interrail results.
await scenario(
  "pass: switching to Interrail swaps the timetable in place, without reloading",
  `${BASE}?mode=od&from=${enc(P)}&to=${enc(L)}&date=${RT_DATE}`,
  async (page) => {
    assert(await until(async () => (await $count(page, "article.journey")) > 0), "precondition: no MAX results");
    await page.evaluate(() => {
      window.__samePage = true;
    });
    await page.select(".header-quick select", "interrail");
    assert(await until(async () => urlParam(page, "card") === "interrail"), "the URL did not take card=interrail");
    const swapped = await until(async () =>
      (await $count(page, ".pass-spinner")) === 0 &&
      (await $count(page, ".results .notice")) > 0 &&
      (await $count(page, "article.journey")) > 0
        ? true
        : null,
    );
    assert(swapped, `Interrail results did not show (results "${(await $text(page, ".results"))?.slice(0, 80)}")`);
    assert(await page.evaluate(() => window.__samePage === true), "the page reloaded");
    // And back: the MAX timetable is already loaded, so it shows without a pill.
    await page.select(".header-quick select", "jeune");
    assert(await until(async () => (await $count(page, ".results .notice")) === 0 && (await $count(page, "article.journey")) > 0), "MAX results did not come back");
    assert(await page.evaluate(() => window.__samePage === true), "the page reloaded going back to MAX");
  },
);

// 12. PWA manifest is served and parseable, icon reference resolves.
await scenario("pwa: manifest is served and valid JSON", BASE, async (page) => {
  const manifestHref = await page.$eval('link[rel="manifest"]', (el) => el.getAttribute("href"));
  assert(manifestHref, "no <link rel=manifest>");
  const res = await page.evaluate(async (href) => {
    const r = await fetch(href);
    return { status: r.status, text: await r.text() };
  }, manifestHref);
  assert(res.status === 200, `manifest HTTP ${res.status}`);
  const m = JSON.parse(res.text);
  assert(Array.isArray(m.icons) && m.icons.length > 0, "manifest has no icons");
});

// ---------------------------------------------------------------------------
await browser.close();
server.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} E2E scenarios passed.`);
if (failed.length) {
  console.error("\nE2E FAILED:");
  for (const f of failed) console.error(`  ✗ ${f.name}\n      ${f.detail}`);
  process.exit(1);
}
console.log("All E2E scenarios passed.");
