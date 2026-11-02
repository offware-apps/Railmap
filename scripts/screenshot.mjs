// Regenerate the README screenshots from the production build.
//   npm run build && npm run screenshot
// Serves ./dist from an in-process HTTP server and captures with the
// npm-bundled Chromium (no system browser needed).
import http from "node:http";
import { readFileSync, existsSync, statSync, mkdtempSync } from "node:fs";
import { join, extname } from "node:path";
import { tmpdir } from "node:os";
import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";

const DIST = join(process.cwd(), "dist");
const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
  ".map": "application/json",
};

const server = http.createServer((req, res) => {
  let pathname = decodeURIComponent((req.url || "/").split("?")[0]);
  pathname = pathname.replace(/^\/Railmap\//, "/").replace(/^\/+/, "");
  let file = join(DIST, pathname);
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
const enc = encodeURIComponent;
const ORIGIN = "PARIS (intramuros)";
const P = enc(ORIGIN);

// Pick dates/routes from the committed snapshot so every screenshot shows real,
// populated results (never an empty "No MAX seat" state). Falls back to a
// few-days-out date if the snapshot is missing.
const addDays = (d, n) => new Date(new Date(d + "T00:00:00Z").getTime() + n * 86_400_000).toISOString().slice(0, 10);
const NICE = /LYON|MARSEILLE|BORDEAUX|NANTES|RENNES|STRASBOURG|LILLE|MONTPELLIER|NICE|TOULOUSE|AVIGNON|DIJON/;
function pickFromData() {
  try {
    const recs = JSON.parse(readFileSync(join(process.cwd(), "public", "data", "tgvmax.json"), "utf-8"));
    const direct = recs.filter((r) => r.destination !== r.origine);
    const fromParis = direct.filter((r) => r.origine === ORIGIN);
    // Best "Where to?" date = most distinct destinations reachable from Paris.
    const destsByDate = {};
    for (const r of fromParis) (destsByDate[r.date] ||= new Set()).add(r.destination);
    const listDate = Object.entries(destsByDate).sort((a, b) => b[1].size - a[1].size)[0]?.[0];
    // Best exact trip = the Paris route+date with the most direct bookable trains.
    const tripByKey = {};
    for (const r of fromParis) tripByKey[`${r.destination}|${r.date}`] = (tripByKey[`${r.destination}|${r.date}`] || 0) + 1;
    const [tripKey] = Object.entries(tripByKey).sort((a, b) => b[1] - a[1])[0] || [];
    const [tripDest, tripDate] = (tripKey || "").split("|");
    // Candidate multi-city tours: Paris -> A (day d1), then A -> B (day d1+1..3),
    // preferring recognizable cities. We try these until one renders results.
    const reach = {}; // origin -> date -> Set(dest)
    for (const r of direct) ((reach[r.origine] ||= {})[r.date] ||= new Set()).add(r.destination);
    const tours = [];
    for (const d1 of Object.keys(reach[ORIGIN] || {}).sort()) {
      for (const A of reach[ORIGIN][d1]) {
        if (!NICE.test(A)) continue;
        for (let k = 1; k <= 3; k++) {
          const bs = reach[A]?.[addDays(d1, k)];
          if (!bs) continue;
          for (const B of bs) {
            if (B === ORIGIN || B === A || !NICE.test(B)) continue;
            tours.push({ date: d1, cities: [A, B] });
          }
        }
      }
    }
    return { listDate, tripDest, tripDate, tours };
  } catch {
    return {};
  }
}
const fallback = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
const picked = pickFromData();
const DATE = picked.listDate || fallback;
const TRIP_TO = enc(picked.tripDest || "LYON (intramuros)");
const TRIP_DATE = picked.tripDate || DATE;
const tourList = (picked.tours && picked.tours.length ? picked.tours : [{ date: DATE, cities: ["LYON (intramuros)", "MARSEILLE ST CHARLES"] }]);
const tourURL = (t) => `${BASE}?mode=tour&from=${P}&date=${t.date}&cities=${t.cities.map(enc).join("~")}`;

const shots = [
  { name: "from", url: `${BASE}?mode=from&from=${P}&date=${DATE}` },
  { name: "trip", url: `${BASE}?mode=od&from=${P}&to=${TRIP_TO}&date=${TRIP_DATE}` },
  { name: "best", url: `${BASE}?mode=best&from=${P}&date=${DATE}&conn=2` },
  // Try candidate tours until one produces a non-empty itinerary.
  { name: "tour", candidates: tourList.slice(0, 40).map(tourURL), emptyText: "No MAX tour" },
  { name: "mobile", url: `${BASE}?mode=from&from=${P}&date=${DATE}`, mobile: true },
  { name: "arabic", url: `${BASE}?mode=from&from=${P}&date=${DATE}`, lang: "ar" },
];

const args = chromium.args.filter((a) => !a.startsWith("--user-data-dir") && !a.startsWith("--proxy"));
const browser = await puppeteer.launch({
  args: [...args, "--no-sandbox", "--disable-setuid-sandbox", "--no-proxy-server"],
  executablePath: await chromium.executablePath(),
  headless: true,
  userDataDir: mkdtempSync(join(tmpdir(), "shot-")),
});

for (const s of shots) {
  const page = await browser.newPage();
  await page.setCacheEnabled(false);
  await page.setViewport(
    s.mobile
      ? { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true }
      : { width: 1120, height: 1400, deviceScaleFactor: 2 },
  );
  if (s.lang) {
    await page.evaluateOnNewDocument((lang) => {
      localStorage.setItem("mj.settings", JSON.stringify({ lang, theme: "auto", card: "jeune" }));
    }, s.lang);
  }
  // Some shots (tour) supply several candidate URLs; use the first that returns
  // real results instead of an empty "nothing found" state.
  const urls = s.candidates || [s.url];
  let picked = urls[0];
  for (const u of urls) {
    await page.goto(u, { waitUntil: "networkidle2", timeout: 30000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 1500));
    if (!s.emptyText) break;
    const empty = await page.evaluate((t) => document.body.innerText.includes(t), s.emptyText).catch(() => false);
    picked = u;
    if (!empty) break;
  }
  if (s.candidates) console.log("  tour ->", decodeURIComponent(picked.split("cities=")[1] || ""));
  // Crop tightly to the app (#app is centred with a max width), not the full
  // page, and cap the height so a long result list doesn't produce a giant,
  // grid-unfriendly image — we only need enough rows to show the feature.
  const el = await page.$("#app");
  const box = el ? await el.boundingBox() : null;
  const cap = s.mobile ? 900 : 1320; // CSS px; output is x2 (deviceScaleFactor)
  if (box) {
    await page.screenshot({
      path: `docs/screenshots/${s.name}.png`,
      clip: { x: box.x, y: box.y, width: box.width, height: Math.min(box.height, cap) },
    });
  } else {
    await page.screenshot({ path: `docs/screenshots/${s.name}.png` });
  }
  console.log("captured", s.name);
  await page.close();
}
await browser.close();
server.close();
console.log("done");
