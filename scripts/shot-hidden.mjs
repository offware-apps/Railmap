// One-off capture of the "hidden train" (hidden-city) feature.
// Serves ./dist and intercepts the data fetch to inject a scenario where
// PARIS -> DIJON has no free seat but the same train runs on to FRASNE.
//   npm run build && node scripts/shot-hidden.mjs [out.png]
import http from "node:http";
import { readFileSync, existsSync, statSync, mkdtempSync } from "node:fs";
import { join, extname } from "node:path";
import { tmpdir } from "node:os";
import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";

const OUT = process.argv[2] || join(process.cwd(), "docs", "screenshots", "hidden.png");
const DIST = join(process.cwd(), "dist");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json", ".map": "application/json" };

// A date inside the booking window (today is 2026-07-08 in this environment).
const DATE = "2026-07-10";
const mk = (o, d, dep, arr, no, ok = "OUI") => ({ date: DATE, origine: o, destination: d, heure_depart: dep, heure_arrivee: arr, train_no: no, od_happy_card: ok, axe: "SUD EST" });
// PARIS -> DIJON is never sold free; but 9765 and 9773 run PARIS -> FRASNE and
// (same number) DIJON -> FRASNE, proving they call at Dijon and when.
const FIXTURE = [
  mk("PARIS (intramuros)", "FRASNE", "06:52", "09:39", "9765"),
  mk("DIJON VILLE", "FRASNE", "08:26", "09:39", "9765"),
  mk("PARIS (intramuros)", "FRASNE", "14:52", "17:39", "9773"),
  mk("DIJON VILLE", "FRASNE", "16:26", "17:39", "9773"),
  // A little other traffic so the dataset isn't a lone route.
  mk("PARIS (intramuros)", "LYON (intramuros)", "08:00", "10:00", "6601"),
];
const META = { updatedAt: `${DATE}T06:00:00Z`, source: "demo", recordCount: FIXTURE.length, isSample: false };

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
const URL = `${BASE}?mode=od&from=${enc("PARIS (intramuros)")}&to=${enc("DIJON VILLE")}&date=${DATE}&conn=0&hidden=1`;

const args = chromium.args.filter((a) => !a.startsWith("--user-data-dir") && !a.startsWith("--proxy"));
const browser = await puppeteer.launch({
  args: [...args, "--no-sandbox", "--disable-setuid-sandbox", "--no-proxy-server"],
  executablePath: await chromium.executablePath(),
  headless: true,
  userDataDir: mkdtempSync(join(tmpdir(), "shot-")),
});
const page = await browser.newPage();
await page.setViewport({ width: 1120, height: 1500, deviceScaleFactor: 2 });
await page.setRequestInterception(true);
page.on("request", (r) => {
  const u = r.url();
  if (u.endsWith("/data/tgvmax.json")) return r.respond({ status: 200, contentType: "application/json", body: JSON.stringify(FIXTURE) });
  if (u.endsWith("/data/meta.json")) return r.respond({ status: 200, contentType: "application/json", body: JSON.stringify(META) });
  return r.continue();
});
await page.goto(URL, { waitUntil: "networkidle2", timeout: 30000 });
await page.waitForSelector(".hidden-trains", { timeout: 10000 });
await new Promise((r) => setTimeout(r, 800));

const focus = process.env.FOCUS === "1";
const el = await page.$(focus ? ".hidden-trains" : "#app");
await el.scrollIntoView();
await new Promise((r) => setTimeout(r, 300));
const box = await el.boundingBox();
const pad = focus ? 24 : 0;
await page.screenshot({
  path: OUT,
  clip: box
    ? { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad), width: box.width + pad * 2, height: Math.min(box.height + pad * 2, 1400) }
    : undefined,
});
console.log("wrote", OUT);
await browser.close();
server.close();
