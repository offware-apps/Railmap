# Railmap

**Every train, every pass.** Find the trains your rail pass can take, across a whole country, in one search.

**Live app: [offware-apps.github.io/Railmap](https://offware-apps.github.io/Railmap/)**. No account, nothing to install, it runs in your browser.

[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](./LICENSE)
[![Tests](https://github.com/offware-apps/Railmap/actions/workflows/test.yml/badge.svg)](https://github.com/offware-apps/Railmap/actions/workflows/test.yml)

Railmap was called MAX Finder until October 2026. Old `/MAX-Finder/` links redirect here.

## Contents

- [What it does](#what-it-does)
- [Supported passes](#supported-passes)
- [Screenshots](#screenshots)
- [Getting started](#getting-started)
- [How it works](#how-it-works)
- [Mobile app](#mobile-app)
- [Data API](#data-api)
- [Contributing](#contributing)
- [License](#license)

## What it does

A MAX JEUNE or MAX SENIOR pass makes SNCF high-speed trains free, but only on trains that still have a MAX seat open. SNCF Connect makes you check one route at a time. Railmap searches every train at once and shows you where you can go.

- **Where to?** Every destination you can reach from a station, ranked by availability.
- **Where from?** Every origin that reaches a destination.
- **Exact trip.** One route, with connections, a 30-day availability calendar and a round-trip finder.
- **Ideas.** The fastest destinations reachable on a given day.
- **Tour.** A multi-city itinerary, day by day, each leg on a pass seat.

It also handles connections (up to 6 changes, an optional stopover city, overnight stops), night trains, filters by time, duration and train type, a map of every station, calendar export and shareable links. It is available in 11 languages, including Arabic with a right-to-left layout, works offline once installed, and keeps your favorites and settings on your device only.

## Supported passes

| Pass | Who can use it | How it works |
| --- | --- | --- |
| **[MAX JEUNE](https://www.sncf-connect.com/catalogue/description/max-jeune)** | 16 to 27, €79/month, 12-month minimum | €0 seats in 2nd class on TGV INOUI, OUIGO high-speed and Intercités with reservation, in France plus Luxembourg and Freiburg. Book up to 30 days ahead, 6 trips at a time, one €0 trip a day from the same station, confirm 1 to 2 days before. No €0 seats on Friday and Sunday afternoons and evenings or holiday eves. Railmap shows the trains with a free MAX seat open for booking. |
| **[MAX SENIOR](https://www.sncf-connect.com/catalogue/description/max-senior)** | 60 and over, same price | Same €0 seats as MAX JEUNE. |
| **[Interrail](https://www.interrail.com/en/interrail-passes/global-pass)** | Residents of the 33 Interrail countries (everyone else buys Eurail). Youth up to 27, senior from 60, children 4 to 11 free with a Child Pass | Any train with a pass-holder reservation (€10 to 20 on TGV, limited seats). Living in France: a Global Pass covers only one trip out of France and one trip back in, and there is no One Country Pass for your own country. Railmap shows every SNCF train a pass holder can take, international stops included. |

**Lower carbon.** A TGV trip emits about 50 times less CO₂ than driving alone and 100 times less than flying ([ADEME](https://impactco2.fr/outils/transport)). Each exact trip shows its own figure.

Booking always happens on [SNCF Connect](https://www.sncf-connect.com/). Railmap is an independent project, not affiliated with SNCF, and does not sell tickets. Availability is refreshed about once a day, so confirm before you book.

## Screenshots

| Where to? | Tour |
| --- | --- |
| [![Every destination reachable with a free MAX seat, ranked by availability, beside a map of France](docs/screenshots/from.png)](docs/screenshots/from.png) | [![A multi-city itinerary, each leg with Book, calendar and map buttons](docs/screenshots/tour.png)](docs/screenshots/tour.png) |
| **Ideas** | **Exact trip** |
| [![The fastest destinations reachable that day](docs/screenshots/best.png)](docs/screenshots/best.png) | [![One route with a 30-day availability calendar](docs/screenshots/trip.png)](docs/screenshots/trip.png) |

<p>
  <img src="docs/screenshots/mobile.png" alt="Railmap on a phone, in a single-column layout" height="360">
  <img src="docs/screenshots/arabic.png" alt="Railmap in Arabic, with a mirrored right-to-left layout" height="360">
</p>

## Getting started

You need Node 20 or later and npm. CI runs Node 22.

```bash
git clone https://github.com/offware-apps/Railmap.git
cd Railmap
npm install
npm run dev
```

Then open <http://localhost:5173>. The dev server uses the committed data snapshot, or a small fixture if there is none.

| Command | What it does |
| --- | --- |
| `npm run dev` | Start the dev server |
| `npm test` | Unit tests, no network needed |
| `npm run build` | Type-check and build the static site into `dist/` |
| `npm run verify` | Check that the built app renders (home, exact trip, tour) |
| `npm run test:e2e` | End-to-end journeys in headless Chromium against `dist/` (run `build` first) |
| `npm run fetch-data` | Download a fresh availability snapshot |

CI runs `build`, `test`, `verify` and `test:e2e` on every pull request and on `main`, and only deploys to GitHub Pages when they pass.

<details>
<summary><strong>Project layout</strong></summary>

```
public/data/  daily availability snapshot (tgvmax.json + meta.json)
data/         station registry and a small fixture for dev and tests
src/core      search, connections and calendar logic (unit-tested)
src/data      dataset loading and station lookup
src/ui        search form, results, map, calendar
scripts/      data fetch, render check, e2e and screenshot scripts
tests/        unit tests (vitest)
docs/         plain-language guides and screenshots
specs/        guiding principles
```

</details>

## How it works

SNCF publishes which trains have a free MAX seat as open data. Railmap is a static site on top of it:

1. [train-api](https://github.com/offware-apps/train-api) publishes each pass's timetable every morning as static JSON. The app reads it first.
2. A scheduled GitHub Action also snapshots the dataset into the app itself (about 77 MB trimmed to about 6 MB), which the app falls back to when train-api is unreachable or out of date.
3. Your browser downloads the timetable and runs every search on your device.
4. Everything is served as static files from GitHub Pages. There is no backend, no database and no server cost.

More detail:

- [How it works](docs/how-it-works.md): a plain-language tour of the app and its data.
- [Algorithms](docs/algorithms.md): how it finds trains, connections, round trips and tours.
- [Vision](VISION.md): where the project is headed, including more operators across Europe.

## Mobile app

The same app is wrapped as an Android app with [Capacitor](https://capacitorjs.com/).

```bash
npm run cap:sync      # build for native and copy it into android/
npx cap open android  # open in Android Studio
```

You need the Android SDK to compile it. Publishing a GitHub Release builds and signs the APK automatically, and the app is also packaged for F-Droid. See [docs/FDROID.md](docs/FDROID.md) for signing and release steps.

## Data API

The deployed site doubles as a read-only API. [`llms.txt`](public/llms.txt) and [`api.json`](public/api.json) describe it.

- `/data/tgvmax.json` lists availability. A record with `od_happy_card: "OUI"` has a free MAX seat.
- `/data/meta.json` and `/data/stations.json` hold snapshot metadata and the station registry.
- Searches are deep-linkable: `?mode=&from=&to=&date=&conn=…`, with modes `from`, `to`, `od`, `tour` and `best`.

## Contributing

Fork the repo, run `npm install` and `npm test`, then open a pull request. The project's principles are in [`specs/constitution.md`](./specs/constitution.md).

Thanks to [@AhmedFr](https://github.com/AhmedFr) for the map-first view and the connection-count pin colors ([#2](https://github.com/offware-apps/Railmap/pull/2), carried over in [#21](https://github.com/offware-apps/Railmap/pull/21) and [#26](https://github.com/offware-apps/Railmap/pull/26)).

## License

Code: [AGPL-3.0](./LICENSE).

Data: [SNCF Open Data, MAX JEUNE and MAX SENIOR availability over 30 days](https://ressources.data.sncf.com/explore/dataset/tgvmax/information/) (the `tgvmax` dataset), under the [Licence Ouverte / Open Licence](https://www.etalab.gouv.fr/licence-ouverte-open-licence).
