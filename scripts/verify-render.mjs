/**
 * scripts/verify-render.mjs — deploy gate: prove the built app actually renders.
 *
 * Serves ./dist and loads it in headless Chromium (home + a deep-link). Fails
 * (exit 1) if #app stays effectively empty, any uncaught page error or CSP
 * violation fires, low-end mode (map off) downloads map code or tiles, any
 * text is cut on a phone, or the controls in the phone header row differ in
 * size, so a build that would show a blank or broken page can never reach
 * production.
 *
 *   npm run build && npm run verify
 */
import http from "node:http";
import { readFileSync, existsSync, statSync, mkdtempSync } from "node:fs";
import { join, extname } from "node:path";
import { tmpdir } from "node:os";
import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";

const DIST = join(process.cwd(), "dist");
const TYPES = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
  ".webmanifest": "application/manifest+json", ".map": "application/json",
};
const MIN_APP_HTML = 500; // a rendered app is many KB; blank is ~the <noscript> only

const server = http.createServer((req, res) => {
  let p = decodeURIComponent((req.url || "/").split("?")[0]).replace(/^\/Railmap\//, "/").replace(/^\/+/, "");
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
const BASE = `http://127.0.0.1:${server.address().port}/Railmap/`;

const args = chromium.args.filter((a) => !a.startsWith("--user-data-dir") && !a.startsWith("--proxy"));
const browser = await puppeteer.launch({
  args: [...args, "--no-sandbox", "--disable-setuid-sandbox", "--no-proxy-server"],
  executablePath: await chromium.executablePath(),
  headless: true,
  userDataDir: mkdtempSync(join(tmpdir(), "verify-")),
});

const P = encodeURIComponent("PARIS (intramuros)");
const T = encodeURIComponent("TOULOUSE MATABIAU");
const DATE = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
const pages = [
  { name: "home", url: BASE },
  { name: "exact-trip", url: `${BASE}?mode=od&from=${P}&to=${T}&date=${DATE}` },
  { name: "tour", url: `${BASE}?mode=tour&from=${P}&cities=${encodeURIComponent("LYON (intramuros)")}&date=${DATE}&dmin=1&dmax=3` },
];

const failures = [];
for (const { name, url } of pages) {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && m.text().includes("Content Security Policy")) errors.push(m.text().slice(0, 160));
  });
  // Ignore cross-origin (map tile) failures — they're expected and harmless.
  page.on("requestfailed", (r) => {
    const u = r.url();
    if (u.startsWith(BASE) && !u.includes("/data/")) errors.push(`request failed: ${u}`);
  });
  try {
    await page.goto(url, { waitUntil: "networkidle2", timeout: 45000 });
  } catch (e) {
    failures.push(`[${name}] navigation failed: ${e.message}`);
    await page.close();
    continue;
  }
  await new Promise((r) => setTimeout(r, 1200));
  const appLen = await page.evaluate(() => document.getElementById("app")?.innerHTML.length ?? -1);
  if (appLen < MIN_APP_HTML) failures.push(`[${name}] #app rendered only ${appLen} chars (blank?)`);
  if (errors.length) failures.push(`[${name}] page errors: ${errors.join(" | ")}`);
  console.log(`  ${name}: #app=${appLen} chars, errors=${errors.length}`);
  await page.close();
}

// Phone header: every visible control in the one-line row shares one height, and
// every control but the pass select shares one width.
const phone = await browser.newPage();
for (const width of [360, 390]) {
  // Only a change of isMobile/hasTouch reloads the page; a width change reflows it.
  await phone.setViewport({ width, height: 844, isMobile: true, hasTouch: true });
  if (width === 360) {
    await phone.goto(BASE, { waitUntil: "load", timeout: 45000 });
    await phone.waitForSelector(".header-quick select");
  }
  const ctls = await phone.evaluate(() =>
    [...document.querySelectorAll(".site-header .logo, .header-quick > *, .header-nav > .menu-btn")]
      .map((e) => ({ e, r: e.getBoundingClientRect() }))
      .filter(({ r }) => r.width > 0 && r.height > 0)
      .map(({ e, r }) => ({ name: e.className || e.tagName, select: e.tagName === "SELECT", w: r.width, h: r.height })),
  );
  const spread = (xs) => Math.max(...xs) - Math.min(...xs);
  const icons = ctls.filter((c) => !c.select);
  const sizes = ctls.map((c) => `${c.name} ${c.w.toFixed(1)}x${c.h.toFixed(1)}`).join(", ");
  if (spread(ctls.map((c) => c.h)) > 1) failures.push(`[header ${width}px] control heights differ: ${sizes}`);
  if (spread(icons.map((c) => c.w)) > 1) failures.push(`[header ${width}px] icon button widths differ: ${sizes}`);
  console.log(`  header ${width}px: ${sizes}`);
}
await phone.close();

// Low-end mode must not fetch the map chunk or a tile; with the map on, Leaflet still mounts.
for (const map of [false, true]) {
  const page = await browser.newPage();
  await page.evaluateOnNewDocument((s) => localStorage.setItem("mj.settings", s), JSON.stringify({ map }));
  const mapRequests = [];
  page.on("request", (r) => {
    if (/\/assets\/map-|tile\.openstreetmap/.test(r.url())) mapRequests.push(r.url());
  });
  await page.goto(pages[1].url, { waitUntil: "load", timeout: 45000 });
  await page.waitForSelector(".results article.journey, .results .empty", { timeout: 45000 });
  if (map) {
    const mounted = await page.waitForSelector(".leaflet-container", { timeout: 20000 }).catch(() => null);
    if (!mounted) failures.push("[map on] Leaflet never mounted");
  } else {
    await page.waitForNetworkIdle({ idleTime: 500, timeout: 20000 }).catch(() => {});
    if (mapRequests.length) failures.push(`[map off] fetched map assets: ${mapRequests.join(", ")}`);
  }
  console.log(`  map ${map ? "on" : "off"}: map requests=${mapRequests.length}`);
  await page.close();
}

// Zero truncated text (product rule 2): every visible text node on these screens must fit,
// never ellipsized, line-clamped, clipped by an overflow:hidden box or pushed off screen.
const L = (id) => encodeURIComponent(id);
const CDG = "AEROPORT ROISSY CDG 2 TGV", VAL = "VALENCE TGV AUVERGNE RHONE ALPES", SPC = "ST PIERRE DES CORPS";
const DATE2 = new Date(Date.now() + 6 * 86_400_000).toISOString().slice(0, 10);
// The first day, from tomorrow on, the snapshot runs both legs of a connection through `hub`,
// so connecting cards (via chips, long leg names) render; DATE when the data has none.
const TOMORROW = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
const snapshot = JSON.parse(readFileSync(join(DIST, "data", "tgvmax.json"), "utf-8"));
const runs = (o, d) =>
  new Set(snapshot.filter((t) => t.origine === o && t.destination === d && t.date >= TOMORROW).map((t) => t.date));
const viaDate = (o, hub, d) => [...runs(o, hub)].filter((day) => runs(hub, d).has(day)).sort()[0] ?? DATE;
const PARIS = "PARIS (intramuros)", LYON = "LYON (intramuros)", BDX = "BORDEAUX ST JEAN", TLS = "TOULOUSE MATABIAU";
const textPages = [
  {
    name: "exact-trip",
    width: 390,
    url: `${BASE}?mode=od&from=${P}&to=${T}&date=${viaDate(PARIS, BDX, TLS)}`,
    must: ".msearch-text",
  },
  {
    name: "long-names",
    width: 360,
    url: `${BASE}?mode=od&from=${L(CDG)}&to=${L(VAL)}&date=${viaDate(CDG, LYON, VAL)}`,
    must: ".msearch-text",
  },
  {
    name: "tour-legs",
    width: 390,
    url: `${BASE}?mode=tour&legs=${L(`${SPC}>${VAL}@${DATE}~${VAL}>${CDG}@${DATE2}`)}&date=${DATE}`,
    must: ".mc-route",
  },
  // Desktop too: an airport name beside its ✈ badge was cut here.
  {
    name: "browse",
    width: 1100,
    url: `${BASE}?mode=from&from=${L(VAL)}&date=${[...runs(VAL, CDG)].sort()[0] ?? DATE}`,
    must: ".stn-airport",
  },
];
for (const { name, width, url, must } of textPages) {
  const page = await browser.newPage();
  await page.setViewport({ width, height: 844, isMobile: width < 861, hasTouch: width < 861 });
  // Reduced motion: no view transition, so the screen is final once the results render.
  await page.evaluateOnNewDocument(() => localStorage.setItem("mj.settings", '{"lang":"en","reduceMotion":true}'));
  await page.goto(url, { waitUntil: "load", timeout: 45000 });
  await page.waitForFunction(
    (sel) =>
      document.querySelector(sel)?.textContent.trim() &&
      document.querySelector(".results")?.children.length &&
      !document.querySelector(".results .loading"),
    { timeout: 45000 },
    must,
  ).catch(() => failures.push(`[${name}@${width}] ${must} never rendered`));
  const cut = await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll("#app *")) {
      const texts = [...el.childNodes].filter((c) => c.nodeType === 3 && c.textContent.trim());
      if (!texts.length || el.closest(".sr-only, .leaflet-container, [aria-hidden='true'], select")) continue;
      const cs = getComputedStyle(el);
      const box = el.getBoundingClientRect();
      if (cs.visibility !== "visible" || box.width < 2 || box.height < 2) continue; // hidden or visually hidden
      const label = `${el.className || el.tagName} "${el.textContent.trim().slice(0, 40)}"`;
      const overflows = el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1;
      if ((cs.textOverflow === "ellipsis" || cs.webkitLineClamp !== "none") && overflows) {
        out.push(`${label} ellipsized`);
        continue;
      }
      const range = document.createRange();
      range.selectNodeContents(texts[0]);
      const r = range.getBoundingClientRect();
      if (r.right > document.documentElement.clientWidth + 1 || r.left < -1) {
        out.push(`${label} off screen`);
        continue;
      }
      for (let a = el; a && a.id !== "app"; a = a.parentElement) {
        const o = getComputedStyle(a).overflowX;
        if (o === "auto" || o === "scroll") break;
        const ar = a.getBoundingClientRect();
        if ((o === "hidden" || o === "clip") && (r.right > ar.right + 1 || r.left < ar.left - 1)) {
          out.push(`${label} clipped`);
          break;
        }
      }
    }
    return out;
  });
  if (cut.length) failures.push(`[${name}@${width}] cut text: ${cut.slice(0, 5).join(" | ")}`);
  const vias = await page.$$eval(".results .chip-via", (n) => n.length);
  console.log(`  ${name}@${width}: cut text=${cut.length}, via chips=${vias}`);
  await page.close();
}

await browser.close();
server.close();

if (failures.length) {
  console.error("\nRENDER VERIFICATION FAILED:");
  for (const f of failures) console.error("  ✗ " + f);
  process.exit(1);
}
console.log("\nRender verification passed — the app mounts, low-end mode skips the map, no text is cut.");
