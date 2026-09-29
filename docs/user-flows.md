# User flows

The canonical map of what a user can do in MAX Finder and how each flow behaves. Keep
this in sync with the app — see the rule in `AGENTS.md` ("Living documentation"): any
change to a user-facing flow must update this file in the same PR.

## Top level: three tabs + a smart form

A user picks a tab, then fills the form. The tab plus which fields are filled decides the
search (`deriveMode` in `src/app.ts`; dispatch in `renderSearch`).

| Tab | Filled fields | Mode | Flow |
|-----|---------------|------|------|
| **Trip** (`simple`) | From + To | `od` | exact trip (one-way or round trip) |
| **Trip** | only From | `from` | browse / discovery *from* a station |
| **Trip** | only To | `to` | browse *into* a station |
| **Multi-city** (`multi`) | legs or cities | `tour` | a multi-stop tour |
| **Ideas** (`ideas`) | From | `best` | best destinations, ranked |

The **trip-type control** sits beside the date: an **`Aller simple` / `Aller-retour`**
(one-way / round trip) segmented toggle — the same sliding-pill style as the main tabs.
When *Aller-retour* is on, a **nights stepper** appears — `[ − ] N [ + ]` with a "Durée sur
place" label — where **0 = "Journée"** (a same-day round trip, metric = hours on site) and
**N = N nights** at the destination (the return is derived as departure + N, adjustable on
the return calendar). Beside the stepper is a **"Flexible" pill**: tapping it switches the
round trip out of fixed-nights mode so you pick the **exact departure and return on the
Trip-tab calendar** (Ulysse-style). While Flexible is active the fixed-nights stepper stays
**in place but inert (dimmed, buttons disabled)** rather than being removed — so toggling
Flexible never moves the "Durée sur place" label or reflows the row (no layout jump); only
the pill lights up. The form's stay becomes `flexible`. Tapping the stepper or a segment leaves
Flexible again. The stepper (and the pill) are hidden for one-way. `r` toggles one-way ↔
round trip (keeping the nights count, never Flexible); `1/2/3` switch tabs. Toggling,
stepping, or picking Flexible re-runs in place (no second Search tap when origin +
destination + date are set). Legacy `?rt=day` / `?rt=round` / `?rdate=` deep links still
resolve (rt=day or rdate==date → round trip, stepper on 0; a later rdate → that many fixed
nights; a bare `rt=round` with no rdate → Flexible). Internally the stay
maps to the `StayChoice` model (`sameday`/`nN`/`flexible`); Flexible carries its explicit
return date on `query.returnDate` (URL `stay=flex` + `rdate`).

The **Trip tab's date picker is a live availability calendar on the form itself**
(`repaintFormCalendar` in `src/app.ts`, painted into `refs.formCalendar` via
`render.calendarEl`). It sits under the trip-shape row behind a one-tap
**"When to leave?"** header (which also shows the picked departure) and is **open by
default**, so the availability grid is there from the start; one tap on the header
collapses it to keep the form short on a phone.
The header names the calendar once (the in-body `<h3>` is rendered `sr-only` via
`calendarEl`'s `hideTitle`, so "When to leave?" isn't written twice). It **recomputes whenever
anything it is derived from changes** — origin, destination, the Aller simple / Aller-retour
toggle, the nights stepper, **and every filter that feeds the per-day sweeps**: Max
correspondances, the via hub, depart-after / depart-before / arrive-before, the max-duration
cap, the train type, night trains + only-night, overnight stopovers, and the same-day minimum
time on site. So a green day always means *a trip is possible that day* for the current
choice.

**Filters apply LIVE; the route stays staged.** A filter is one deliberate choice, so
changing any of the controls listed above (plus the radius, the trip span, hidden trains and
the Ideas/tour region) runs `applyFilterChange`: it repaints the form calendar **and**
refreshes the results already on screen for that route in place — their own calendars
included — with no second Search tap, and no extra history entry. What a **typed route** edit
does is unchanged: a departure/destination/leg the user hasn't committed stays staged until
Search, and a filter change never smuggles it in (the refresh is skipped whenever the form's
route, legs, cities or date no longer match what is on screen). Two other states also stay
staged, because there is nothing on screen to bring up to date: the bare landing form, and
the post-reload "press Search" prompt.

| State | Builder (reused) | Green means |
|-------|------------------|-------------|
| no origin yet | — (neutral month) | any day, tappable — with a "pick a departure station" hint |
| origin + dest, one-way | `availabilityCalendar` | a departure exists that day (count = trains) |
| origin + dest, same day (0 nights) | `stayCalendar` (hours) | a same-day there-and-back works (count = hours on site) |
| origin + dest, N nights | `stayCalendar` (nights) | an N-night round trip is feasible (count = nights) |
| origin only, one-way | `reachableCountCalendar` | you can leave that day (count = destinations) |
| origin only, round / same day | `getawayIdeas().perDay` | a getaway is possible that day (count = destinations) |

Tapping a green day sets the departure (`query.date` + the form's date field); with both
endpoints filled it also shows/refreshes that day's trip in place. It reuses the same option
helpers (`odJourneyOptsFor` / `getawayOptsFor`) as the real search, so the per-day journey
sweeps hit the warm memo caches; origin typing is debounced. The Trip tab has no separate
date field: this calendar is its only date picker (the Multi-city tab keeps its own date
pills).

**In Flexible mode the same inline calendar becomes a departure→return RANGE picker**
(`pickFormRange`, driven by `calendarEl`'s `range` option). The **first tap sets the
departure** and arms the calendar for the return (`formRangeAwait`); the **next tap on/after
it sets the return** — `query.returnDate` with `stay: "flexible"` — and (route complete) runs
the flexible round trip in place, while an earlier tap just restarts. A **third tap begins a
fresh range**. The days between the two picked endpoints (both `.sel`) get a `.range` band,
and while the return is being chosen hovering previews the pending span (`.preview`).
Availability is shown exactly as the single-date calendar (round-trip feasibility). The
collapsed header spells out the two endpoints ("Aller: … → Retour: …", or a "choose the
return" prompt); `syncFormFromQuery` restores the highlighted range from `stay=flex` +
`rdate`. Fixed-nights and one-way modes keep the single-date departure picker; only Flexible
turns on range selection. The results-page return calendar still handles the return too —
this only adds the pick on the **first page**.

**Max correspondances** (0 / 1 / 2 / 3 / no limit) is a **main-form field**, not buried in
Advanced. **Night trains are included by default.** On the results screen, once a specific
date is chosen the possible-days calendar is **collapsed by default** (one tap to reveal
other dates); it stays expanded only during discovery (no exact date/destination yet).

**Every exact-route calendar is graded by the sweep its list runs** — `odJourneyOptsFor`
returns both the connection options and the accept-filter, and the one-way calendar, the
round-trip **return** calendar and the form calendar all use it, so the Advanced **max trip
span (days)** cap narrows the green days exactly as it narrows the trains. Before this the
span applied to the lists only, and a day could read green while its list was empty.

## Trip tab

1. **From + To, One-way** → exact one-way trip (`runOdSearch`). The 30-day availability
   calendar is **collapsed by default** behind a "Departure: <date> · Change" toggle (the
   date is already chosen; the strip only re-appears on tap), above the selected day's train
   list. Tap a green day to move; tap a train to book (direct → deep link; connecting →
   step-by-step).
2. **From + To, a stay chosen** → the round-trip flow (`runTripSearch`). Two-leg accordion,
   with linked calendars:
   - **Leg 1 Outbound** — possible-days calendar collapsed as "Departure: <date> · Change"
     (it mirrors the form date, never re-asks it); below it the day's outbound trains.
     Clicking a departure day **restarts the return calendar from that day** (departure + N
     for a fixed stay, else same-day-first). Pick a train → it collapses to a ✓ summary and…
   - **Leg 2 Return** opens (gently revealed only if below the fold — a calendar tap never
     scrolls the drawer up) — a return calendar whose **first cell is the same day** (hours
     on site), later cells are nights at the destination, pre-selected to the stay's return.
     For a **fixed** N-night stay the return is derived with no second question, so its
     calendar is **collapsed by default** behind a "Return: <date> · Change" toggle (same
     `.cal-collapsible` / `.cal-toggle` / `.cal-panel` pattern as the outbound one). In
     **Flexible** mode the return calendar **stays open** (it is the return-length control):
     tapping a day sets `query.returnDate` and keeps the stay `flexible`. **Exception** —
     when the proposed return day has **no free-MAX return**, the return leg and its calendar
     **open by default** (never a collapsed summary hiding an empty list), so the days that
     *do* have a return are visible and one tap away. Pick a return →
   - **Trip modal** = booking recap: each leg's own **travel date** rides on the ticket header
     (beside "Outbound" / "Return"), and an unmistakable per-leg action — "Book the outbound" /
     "Book the return" (each deep-links SNCF Connect; a connecting leg opens the step modal)
     — plus Save the whole trip. Back inside the accordion re-opens the outbound before it
     exits the flow (step-wise back).
3. **Only From, One-way** → browse (`runBrowse` "from"). Every destination reachable from the
   station, ranked by how well-served it is, with availability. Tap a card → the exact trip.
4. **Only From, a stay chosen** → discovery (`runGetaways`), "Where can you get away to?".
   Destinations ranked by **time at the destination** (hours on site if same-day is best,
   else nights) + a possible-start-days calendar. Tap a day → narrows to that day
   (auto-scrolls to results). Tap a destination → opens the round trip.
   - Ranking: `sortGetaways` puts most hours-on-site first for same-day trips.
   - The same-day minimum time on site (`minOnSiteMin`, default 4 h) is the form's
     **Minimum time there** select (2 to 8 h, URL `stayh`), shown for a same-day round trip.
5. **Only To** → reverse browse (`runBrowse` "to"): where you can come *from* to reach the
   station. With a **round trip / stay** chosen and only a destination, this is a **reverse
   round-trip discovery** — the origins you can round-trip *from* to reach this station,
   with a possible-departure-days calendar — never a blank screen.

## Multi-city tab (tour)

- **Custom legs** — spell out each hop (from → to @ date). "Surprise me" fills a random
  reachable next stop; can build a whole trip from an empty editor.
- **Tour planner** — add cities to visit (or "Surprise" / "Nearest stop"), set days-per-city;
  it auto-orders a feasible tour. Save as a tour.

## Ideas tab (best)

Best free-MAX destinations from the origin, ranked (fastest / most-served / closest…),
either an all-days overview or one specific day. Tap → open the route.

## Cross-cutting (everywhere)

- **Map** — full-bleed behind a results drawer on mobile, side panel on desktop. Markers per
  destination, hover/selection synced with the list; route line for exact trips; auto-fits
  above the drawer on mobile.
- **Saved & Favorites** — star a route / save a trip, from the header menu. (The two overlap
  — a known cleanup item.)
- **Settings** — theme, MAX Jeune/Senior, comfortable/compact, and Low-end mode (map off +
  reduced motion + compact) with a one-time nudge on weak devices; language.
- **Mobile** — the form is a sheet that collapses to a search bar; results are a bottom-sheet
  drawer with detents. Back navigation preserves form state and never lands on a dead screen.
- **History model** — a genuine navigation (Search, drilling into a route, opening the saved
  page) pushes **one** history entry carrying a form snapshot, so browser Back returns to the
  prior page with the form intact. Refining the current view — the Aller simple/retour toggle,
  the nights stepper, the Flexible pill, picking a calendar day — updates **in place**
  (`replaceState`), never pushing a new entry. So repeated toggling can't pile up duplicate
  entries (the old bug where Back needed ~10 presses and the form appeared wiped).
- **Deep links** — every search is a shareable URL; legacy `?rdate=` / `?rt=` links still work.
- **PWA** — installable; a "new version — reload" postcard on updates.

## Known open items (see docs/trip-redesign.md for the audit plan)

- Collapse the two save systems (favorite star + Save bookmark) into one.
- One `openRoute()` primitive (list cards / favorites / map pins behave consistently).
- One home for the availability calendar (form popover vs results).
- Mobile browser-Back should close detail pages via history.
