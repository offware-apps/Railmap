import http from "node:http";
import { readFileSync, writeFileSync, existsSync, statSync, mkdtempSync } from "node:fs";
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
  let p = decodeURIComponent((req.url || "/").split("?")[0]).replace(/^\/Railmap\//, "/").replace(/^\/+/, "");
  let file = join(DIST, p);
  if (!file.startsWith(DIST)) return res.writeHead(403).end();
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(DIST, "index.html");
  if (!existsSync(file)) return res.writeHead(404).end("not found");
  res.writeHead(200, { "Content-Type": TYPES[extname(file)] || "application/octet-stream" });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}/Railmap/`;

const args = chromium.args.filter((a) => !a.startsWith("--user-data-dir") && !a.startsWith("--proxy"));
const browser = await puppeteer.launch({
  args: [...args, "--no-sandbox", "--disable-setuid-sandbox", "--no-proxy-server"],
  executablePath: await chromium.executablePath(),
  headless: true,
  userDataDir: mkdtempSync(join(tmpdir(), "prerender-")),
});

const page = await browser.newPage();
// The snapshot is built from the committed data, never the live train-api: anything off
// this server fails fast, so the app falls back to dist/data like the other gates.
await page.setRequestInterception(true);
page.on("request", (req) => (/^(data:|blob:)/.test(req.url()) || req.url().startsWith(BASE.replace(/Railmap\/$/, "")) ? req.continue() : req.abort()));
await page.evaluateOnNewDocument(() => {
  Object.defineProperty(navigator, "language", { get: () => "fr-FR" });
  Object.defineProperty(navigator, "languages", { get: () => ["fr-FR", "fr"] });
  // Map off: the snapshot must not carry Leaflet's DOM, a tile <img> or the map chunk's
  // preload links, or every visitor (low-end mode included) downloads them.
  localStorage.setItem("mj.settings", JSON.stringify({ map: false }));
});
await page.goto(BASE, { waitUntil: "networkidle2", timeout: 60000 });
await page.waitForFunction(
  () => {
    const app = document.getElementById("app");
    return !!app && app.innerHTML.length > 5000 && !app.querySelector(".loading");
  },
  { timeout: 45000 },
);
await new Promise((r) => setTimeout(r, 500));

let html = await page.evaluate(() => "<!doctype html>\n" + document.documentElement.outerHTML);
await browser.close();
server.close();

// The segmented-control sliding pills (.mode-tab-thumb) are positioned by JS from the
// LIVE layout (offsetLeft/Width), so the inline styles captured here are pinned to the
// prerender viewport — on a phone that bakes a too-wide pill (e.g. 353px on a ~320px
// control) that then visibly jumps/animates into place when the app hydrates ("first
// screen looks buggy on load"). Strip the baked geometry AND the has-thumb / animate-thumb
// flags so the static paint shows the plain active segment (highlighted by its CSS
// fallback background); hydration re-adds the pill, correctly placed for the real
// viewport, with no initial animation.
// theme.js adds the dataset preload at runtime for the visitor's pass; one baked in here
// would point at the prerender server and fetch the MAX file for every pass.
html = html
  .replace(/<link\b[^>]*\bdata-dataset-preload\b[^>]*>/g, "")
  .replace(/(<html\b[^>]*?)\s+data-map="off"/, "$1")
  .replace(/(<span class="mode-tab-thumb"[^>]*?)\s+style="[^"]*"/g, "$1")
  .replace(/(class="[^"]*?)\s+has-thumb\b/g, "$1")
  .replace(/(class="[^"]*?)\s+animate-thumb\b/g, "$1");

const failures = [];
if (html.length < 20000) failures.push(`prerendered HTML is only ${html.length} bytes`);
if (!html.includes('<html lang="fr"')) failures.push("prerendered HTML is not in French");
if (!html.includes('id="app"')) failures.push("prerendered HTML lost #app");
if (!html.includes("application/ld+json")) failures.push("prerendered HTML lost JSON-LD");
if (!html.includes("<noscript")) failures.push("prerendered HTML lost the noscript fallback");
if (!html.includes('<meta name="train-api"')) failures.push("prerendered HTML lost the train-api meta");
if (html.includes("data-dataset-preload")) failures.push("prerendered HTML carries a baked dataset preload");
if (/leaflet|assets\/map-/.test(html)) failures.push("prerendered HTML carries the map (Leaflet DOM or map chunk)");
if (failures.length) {
  console.error("PRERENDER FAILED:");
  for (const f of failures) console.error("  ✗ " + f);
  process.exit(1);
}

writeFileSync(join(DIST, "index.html"), html);
console.log(`prerendered index.html: ${html.length} bytes`);
