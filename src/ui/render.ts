import type { MaxTrain, Journey, SearchMode, CalendarDay, SortKey } from "../types";
import type { HiddenTrain } from "../core/hidden";
import type { StationGroup, WindowStat } from "../core/destinations";
import type { BestTrip } from "../core/best";
import type { Getaway } from "../core/getaways";
import type { Tour } from "../core/tour";
import type { RoutePair } from "../state/store";
import { el } from "./dom";
import { isNightTrain } from "../core/search";
import { isAirportStation } from "../data/stations";
import { formatDuration, dayIndex, addDays } from "../util/time";
import { t, getLang } from "../i18n";
import { formatFee, type Fee } from "../data/fees";
import { operatorById } from "../data/operators";

// Monotonic id source for wiring aria-labelledby (a calendar's <h3> to its grid).
let uidSeq = 0;

/** "Book on SNCF Connect", or on the site of the operator that runs the train. */
function bookOn(train: MaxTrain | undefined): string {
  const op = operatorById(train?.operator);
  return op ? t("act_book_on", { site: op.name }) : t("act_book");
}

export interface RenderCtx {
  label: (id: string) => string;
  formatDate: (iso: string) => string;
  /** Narrow localized weekday name (e.g. "Sat"). */
  formatWeekday: (iso: string) => string;
  /** Where to book a train: SNCF Connect, or another operator's site (`operator`, see operators.ts). */
  bookUrl: (origin: string, destination: string, date: string, time?: string, operator?: string) => string;
  /** External travel-guide (Wikivoyage) URL for a station's city. */
  cityInfoUrl: (id: string) => string;
  /** Open the exact O→D trip. A getaway idea passes `open.date` — its advertised start day —
   *  so the round trip opens on a day it's actually feasible, not one anchored on today (which
   *  may have only an outbound and no return). */
  onOpenRoute: (origin: string, destination: string, open?: { date?: string }) => void;
  /** Draw a specific journey (origin → interchanges → destination) on the map. */
  onShowJourney: (journey: Journey) => void;
  /** Draw a whole multi-city tour (every stop) on the map. */
  onShowTour: (tour: Tour) => void;
  /** Straight-line km between two stations (Infinity if either is unplotted). */
  distanceKm: (a: string, b: string) => number;
  onSelectDay: (date: string) => void;
  onIcs: (journey: Journey) => void;
  /** Open the step-by-step "book each train" modal for a connecting journey. */
  onBookSteps: (journey: Journey) => void;
  /** A journey's Interrail reservation fees, set only when the traveller turned them on. */
  fee?: (journey: Journey) => Fee | undefined;
  isFavorite: (route: RoutePair) => boolean;
  onToggleFavorite: (route: RoutePair) => void;
  /** Whether this trip (one-way, or a round trip with `inbound`) is saved. */
  isTripSaved: (outbound: Journey, inbound?: Journey) => boolean;
  /** Save the trip if absent, else remove it. */
  onToggleTrip: (outbound: Journey, inbound?: Journey) => void;
  /** Whether this multi-city tour is saved. */
  isTourSaved: (tour: Tour) => boolean;
  /** Save the tour if absent, else remove it. */
  onToggleTour: (tour: Tour) => void;
}

function icon(path: string): HTMLElement {
  return el("span", {
    class: "icon",
    attrs: { "aria-hidden": "true" },
    html: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`,
  });
}

const I = {
  train: '<rect x="4" y="3" width="16" height="13" rx="2"/><path d="M4 11h16M8 16l-2 4M16 16l2 4M8.5 8h.01M15.5 8h.01"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  cal: '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2v4M16 2v4"/>',
  star: '<path d="M12 2l3 6.5 7 .6-5.3 4.6 1.6 6.9L12 17.3 5.7 20.6l1.6-6.9L2 9.1l7-.6z"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9M19 13v6H5V5h6"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  pin: '<path d="M12 21s-6-5.2-6-10a6 6 0 0 1 12 0c0 4.8-6 10-6 10z"/><circle cx="12" cy="11" r="2.2"/>',
  bookmark: '<path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1z"/>',
  // A numbered/stepped list — used when "Book" opens the step-by-step modal (book
  // each train in turn) rather than a single deep link to a new tab.
  steps: '<path d="M9 6h11M9 12h11M9 18h11M4 5l1 1 1.5-1.5M4 11l1 1 1.5-1.5M4 17l1 1 1.5-1.5"/>',
  plane: '<path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 4.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z"/>',
};

/**
 * A Save button that toggles whether a trip is kept in "Saved trips". Used both on
 * a single journey card (one-way) and in the round-trip view (`inbound` set). Keeps
 * its own label/pressed state in sync on click.
 */
function tripSaveBtn(outbound: Journey, ctx: RenderCtx, inbound?: Journey): HTMLElement {
  const saved = (): boolean => ctx.isTripSaved(outbound, inbound);
  const lbl = el("span", { text: saved() ? t("act_saved") : t("act_save") });
  const btn = el(
    "button",
    {
      class: saved() ? "btn btn-ghost is-saved" : "btn btn-ghost",
      type: "button",
      attrs: { "aria-pressed": String(saved()), title: saved() ? t("act_unsave") : t("act_save") },
      on: {
        click: () => {
          ctx.onToggleTrip(outbound, inbound);
          const now = saved();
          btn.classList.toggle("is-saved", now);
          btn.setAttribute("aria-pressed", String(now));
          btn.title = now ? t("act_unsave") : t("act_save");
          lbl.textContent = now ? t("act_saved") : t("act_save");
        },
      },
    },
    [icon(I.bookmark), lbl],
  );
  return btn;
}

/** One train as a compact row. (Every shown train is MAX-reservable by definition.) */
export function trainRowEl(train: MaxTrain): HTMLElement {
  const time = el("span", { class: "train-time" }, [
    el("strong", { text: train.depart }),
    icon(I.arrow),
    el("strong", { text: train.arrive }),
    // Overnight train: the arrival time is past midnight (arriveMin ≥ 1440), so flag
    // the day offset — otherwise "23:00 → 00:50" reads as arriving the same morning.
    ...(train.arriveMin >= 1440
      ? [el("span", { class: "day-offset", text: t("lbl_dayoffset", { n: Math.floor(train.arriveMin / 1440) }) })]
      : []),
  ]);
  const meta = el("span", { class: "train-meta" }, [
    icon(I.clock),
    el("bdi", { text: formatDuration(train.durationMin) }),
    el("span", { class: "train-no", text: t("lbl_train", { no: train.trainNo }) }),
    ...(train.axe ? [el("span", { class: "train-axe", text: train.axe })] : []),
    // A little 🌙 so a sleeper (leaves late / arrives past midnight) is obvious at a
    // glance in the list, not only from the "+1d" time badge.
    ...(isNightTrain(train)
      ? [el("span", { class: "night-badge", text: "🌙", attrs: { title: t("field_night"), "aria-label": t("field_night") } })]
      : []),
  ]);
  return el("div", { class: "train-row" }, [time, meta]);
}

/**
 * A one-line summary of a chosen journey — its departure→arrival, total time, and a
 * direct/via chip — used as the collapsed "you picked this" line in the multi-city
 * stepper. Deliberately compact: it stands in for a whole journey card.
 */
export function journeySummaryEl(j: Journey, ctx: RenderCtx): HTMLElement {
  const first = j.legs[0];
  const last = j.legs[j.legs.length - 1];
  const via = j.legs.length > 1;
  const fromLabel = first ? legEndpointLabel(ctx, first, "origin") : "";
  const toLabel = last ? legEndpointLabel(ctx, last, "destination") : "";
  const trains = j.legs.map((l) => l.trainNo).filter(Boolean);
  const axe = first?.axe;
  return el("span", { class: "mc-pick" }, [
    // The day + exact gares of THIS leg — Aller and Retour fall on different dates and can
    // use different Paris termini, so spelling it out per leg is the point of the summary.
    el("span", { class: "mc-pick-route muted small" }, [
      el("span", { class: "mc-pick-date", text: ctx.formatDate(j.date) }),
      el("span", { class: "mc-pick-gares", text: `${fromLabel} → ${toLabel}` }),
    ]),
    el("span", { class: "mc-pick-line" }, [
      el("span", { class: "mc-pick-time" }, [
        el("strong", { text: first?.depart ?? "" }),
        icon(I.arrow),
        el("strong", { text: last?.arrive ?? "" }),
      ]),
      el("span", { class: "mc-pick-dur muted" }, [icon(I.clock), el("bdi", { text: formatDuration(j.totalDurationMin) })]),
      via
        ? el("span", { class: "chip chip-via", text: t("lbl_via", { hub: j.hubs.map((h) => ctx.label(h)).join(", ") }) })
        : el("span", { class: "chip chip-direct", text: t("lbl_direct") }),
    ]),
    // The actual train(s) to look for on SNCF Connect: number + line/axe.
    trains.length
      ? el("span", { class: "mc-pick-train muted small" }, [
          ...trains.map((no) => el("span", { class: "train-no", text: t("lbl_train", { no }) })),
          ...(axe ? [el("span", { class: "train-axe", text: axe })] : []),
        ])
      : el("span"),
  ]);
}

/**
 * External travel-guide (Wikivoyage) link for a station's city. `variant: "button"`
 * styles it as a ghost button with the icon leading (matches the Save button);
 * `variant: "link"` is an inline linklike with the icon trailing the label.
 */
export function guideEl(ctx: RenderCtx, stationId: string, variant: "button" | "link" = "link"): HTMLElement {
  const label = el("span", { text: t("act_guide") });
  const ext = icon(I.external);
  const newtab = el("span", { class: "sr-only", text: t("link_newtab") });
  return el(
    "a",
    {
      class: variant === "button" ? "btn btn-ghost" : "linklike",
      href: ctx.cityInfoUrl(stationId),
      attrs: { target: "_blank", rel: "noopener noreferrer" },
    },
    variant === "button" ? [ext, label, newtab] : [label, ext, newtab],
  );
}

// Paris intra-muros is a single aggregate in the SNCF open data, but a train's axe
/**
 * A calendar tucked behind a one-tap "… · Changer" summary toggle: collapsed by
 * default on results screens (only the form calendar opens up front). Returns the
 * wrapper `host`, the `toggle` button, and a `setLabel` to (re)write its summary
 * text. Replaces the outbound / return / getaway calendars' hand-duplicated copies.
 */
export function collapsibleCalendar(
  calNode: HTMLElement,
  wrapClass = "cal-collapsible",
  startOpen = false,
): { host: HTMLElement; toggle: HTMLElement; setLabel: (text: string) => void; setOpen: (open: boolean) => void } {
  const panel = el("div", { class: "cal-panel", attrs: startOpen ? {} : { hidden: "" } }, [calNode]);
  const setOpen = (open: boolean): void => {
    panel.toggleAttribute("hidden", !open);
    toggle.setAttribute("aria-expanded", String(open));
  };
  const toggle = el("button", {
    class: "cal-toggle linklike",
    type: "button",
    attrs: { "aria-expanded": String(startOpen) },
    on: { click: () => setOpen(panel.hasAttribute("hidden")) },
  });
  const host = el("div", { class: wrapClass }, [toggle, panel]);
  return { host, toggle, setLabel: (text: string) => (toggle.textContent = text), setOpen };
}

// pins which terminus gare it actually uses. Map the main TGV axes; other axes
// (Intercités, international, night) stay as the plain "Paris" — better a city than
// a wrong gare. The mapping only applies on a concrete journey leg (where the axe is
// known), never in browse lists (where many axes mix under one "Paris").
const PARIS_GARE_BY_AXE: Record<string, string> = {
  "SUD EST": "Paris Gare de Lyon",
  ATLANTIQUE: "Paris Montparnasse",
  NORD: "Paris Nord",
  EST: "Paris Est",
  // Every Intercités de Nuit from Paris departs Austerlitz. (IC ARO / INTERNATIONAL
  // aren't tied to one gare, so they stay the plain "Paris" aggregate.)
  "IC NUIT": "Paris Austerlitz",
};

/** Display name for one end of a leg: the specific Paris terminus gare — fixed by the
 *  train's axe — when that end is the Paris aggregate; otherwise the plain station /
 *  city label. We never guess a gare the data can't pin down (Lyon, Lille, …): if we
 *  don't know, we keep the city name. */
function legEndpointLabel(ctx: RenderCtx, leg: MaxTrain, end: "origin" | "destination"): string {
  const id = end === "origin" ? leg.origin : leg.destination;
  if (id === "PARIS (intramuros)") {
    return PARIS_GARE_BY_AXE[(leg.axe ?? "").toUpperCase().trim()] ?? ctx.label(id);
  }
  return ctx.label(id);
}

/** A small ✈ flag marking an airport station (Roissy-CDG, Lyon St-Exupéry, …). */
function airportBadge(): HTMLElement {
  return el(
    "span",
    { class: "airport-badge", attrs: { title: t("lbl_airport"), "aria-label": t("lbl_airport") } },
    [icon(I.plane)],
  );
}

/** A station-name span, with an ✈ badge appended when the station is an airport.
 *  For airports the name ellipsizes in an inner span so the flag is never clipped. */
function stationNameEl(cls: string, id: string, label: string): HTMLElement {
  if (!isAirportStation(id)) return el("span", { class: cls, text: label });
  return el("span", { class: `${cls} stn-airport`.trim() }, [
    el("span", { class: "stn-text", text: label }),
    airportBadge(),
  ]);
}

/**
 * A direct or connecting journey card. `opts.saveable` (default true) adds a Save
 * button to the actions; it's turned off inside the trip modal, where a single
 * whole-trip Save already covers both legs. `opts.onPick` makes a click on the card
 * select it (highlighting it among its siblings) and run the callback — used to
 * pick the outbound for a round trip, or open a return directly. `opts.selected`
 * pre-highlights the card.
 */
export function journeyEl(
  j: Journey,
  ctx: RenderCtx,
  opts: {
    saveable?: boolean;
    onPick?: (journey: Journey) => void;
    onArrow?: (journey: Journey) => void;
    selected?: boolean;
    /** Container within which the active/selected highlight is exclusive (defaults
     * to the card's parent). Use it when the cards aren't direct siblings — e.g. the
     * trip modal, where the two legs live in separate sections. */
    group?: HTMLElement;
    /** Hide the "Show on map" action (e.g. inside a modal, where the map is hidden). */
    hideMap?: boolean;
    /** Clicking the card body books the trip (deep link, or the step modal for a
     * connecting one) instead of just highlighting it — used for the one-way list,
     * where selecting a journey has no follow-up so the click may as well book. */
    bookOnClick?: boolean;
    /** A date chip in the card head — set when a flexible-date list mixes days, so
     * each proposition says which day it's for. */
    dateLabel?: string;
    /** Render the book affordance as a clear labelled primary ("Book this leg") instead
     * of the bare arrow — used on the confirmation/booking recap where each leg's action
     * should be explicit. A direct train deep-links straight; a connecting one opens the
     * per-train step modal. */
    bookLabel?: string;
  } = {},
): HTMLElement {
  const saveable = opts.saveable !== false;
  const connecting = j.legs.length > 1;
  const book = (): void => {
    if (connecting) ctx.onBookSteps(j);
    else window.open(ctx.bookUrl(j.origin, j.destination, j.date, j.legs[0]?.depart, j.legs[0]?.operator), "_blank", "noopener,noreferrer");
  };

  // A through-ticket can't be pinned to the exact free trains in a single SNCF
  // Connect search (the connection time isn't settable from a deep link, so it
  // re-optimises to the earliest connection). So a connecting trip books train by
  // train via the step modal; a direct trip deep-links straight through.
  const bookBtn = opts.onArrow
    ? el(
        "button",
        {
          class: "book-arrow",
          type: "button",
          attrs: { "aria-label": t("act_next"), title: t("act_next") },
          on: {
            click: () => {
              select("is-selected");
              opts.onArrow!(j);
            },
          },
        },
        [icon(I.arrow)],
      )
    : opts.bookLabel
    ? connecting
      ? el(
          "button",
          { class: "btn btn-primary book-leg", type: "button", text: opts.bookLabel, on: { click: () => ctx.onBookSteps(j) } },
        )
      : el("a", {
          class: "btn btn-primary book-leg",
          href: ctx.bookUrl(j.origin, j.destination, j.date, j.legs[0]?.depart, j.legs[0]?.operator),
          attrs: { target: "_blank", rel: "noopener noreferrer" },
          text: opts.bookLabel,
        })
    : connecting
    ? el(
        "button",
        {
          class: "book-arrow",
          type: "button",
          attrs: { "aria-label": t("act_book"), title: t("act_book") },
          on: { click: () => ctx.onBookSteps(j) },
        },
        [icon(I.arrow)],
      )
    : el(
        "a",
        {
          class: "book-arrow",
          href: ctx.bookUrl(j.origin, j.destination, j.date, j.legs[0]?.depart, j.legs[0]?.operator),
          attrs: {
            target: "_blank",
            rel: "noopener noreferrer",
            "aria-label": bookOn(j.legs[0]),
            title: bookOn(j.legs[0]),
          },
        },
        [icon(I.arrow), el("span", { class: "sr-only", text: t("link_newtab") })],
      );

  const article = el("article", { class: "journey is-clickable" }, [
    el("div", { class: "journey-main" }, [
      journeyBodyEl(j, ctx, undefined, opts.dateLabel),
      journeyActionsEl(j, ctx, { saveable, hideMap: opts.hideMap }),
    ]),
    el("div", { class: "journey-book" }, [bookBtn]),
  ]);
  if (opts.selected) article.classList.add("is-selected");
  // The labelled "Book this leg" primary needs room to sit and wrap (zero truncation) —
  // widen the ticket stub for it instead of squeezing text into the arrow column.
  if (opts.bookLabel) article.classList.add("has-book-leg");

  const scope = (): HTMLElement | null => opts.group ?? article.parentElement;
  function select(cls: "is-active" | "is-selected"): void {
    scope()
      ?.querySelectorAll(".journey.is-active, .journey.is-selected")
      .forEach((x) => x.classList.remove("is-active", "is-selected"));
    article.classList.add(cls);
  }
  article.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest("button, a")) return;
    if (opts.onPick) {
      select("is-selected");
      opts.onPick(j);
    } else if (opts.bookOnClick) {
      book();
    } else {
      select("is-active");
      ctx.onShowJourney(j);
    }
  });

  return article;
}



/** A favourite-toggle star button for a route, with live aria/label updates. */
function favStarEl(route: RoutePair, ctx: RenderCtx): HTMLElement {
  const favLabel = (): string => (ctx.isFavorite(route) ? t("act_fav_remove") : t("act_fav_add"));
  return el(
    "button",
    {
      class: ctx.isFavorite(route) ? "star is-fav" : "star",
      type: "button",
      title: favLabel(),
      attrs: { "aria-pressed": String(ctx.isFavorite(route)), "aria-label": favLabel() },
      on: {
        click: (e) => {
          ctx.onToggleFavorite(route);
          const b = e.currentTarget as HTMLElement;
          const now = ctx.isFavorite(route);
          b.classList.toggle("is-fav", now);
          b.setAttribute("aria-pressed", String(now));
          const lbl = now ? t("act_fav_remove") : t("act_fav_add");
          b.setAttribute("aria-label", lbl);
          b.title = lbl;
        },
      },
    },
    [icon(I.star)],
  );
}

/**
 * A destination/origin group card (for "from"/"to" modes). Clicking opens the
 * exact-trip ("trajet précis") view for the route, where the 30-day calendar
 * shows exactly which dates are bookable. `stat` shows total MAX availability
 * over the whole booking window so the list doubles as an availability ranking.
 */
export function groupCardEl(
  group: StationGroup,
  mode: SearchMode,
  anchor: string,
  ctx: RenderCtx,
  dayCount: number,
  stat?: WindowStat,
  flexDays = 0,
): HTMLElement {
  const origin = mode === "from" ? anchor : group.station;
  const destination = mode === "from" ? group.station : anchor;
  const route: RoutePair = { origin, destination };

  const star = favStarEl(route, ctx);

  // Two figures: trains on the chosen day (or, with flexible dates, within ±N days)
  // and the total over the whole month — so the list ranks places by availability.
  const month = stat?.trains ?? group.count;
  const dayPart =
    flexDays > 0 ? t("stat_flex_month", { day: dayCount, n: flexDays, month }) : t("stat_day_month", { day: dayCount, month });
  const summary = stat ? dayPart : t("badge_trains", { n: dayCount });

  const meta: HTMLElement[] = [];
  if (stat) {
    meta.push(
      el("span", {
        class: "stat-chip",
        text: summary,
        attrs: { title: t("stat_window_hint", { trains: stat.trains, days: stat.days }) },
      }),
    );
  } else {
    meta.push(el("span", { text: t("badge_trains", { n: group.count }) }));
  }
  meta.push(el("bdi", { text: formatDuration(group.minDurationMin) }));

  const main = el(
    "button",
    {
      class: "dest-main dest-main-stacked",
      type: "button",
      attrs: { "aria-label": `${ctx.label(group.station)} — ${summary}` },
      on: { click: () => ctx.onOpenRoute(origin, destination) },
    },
    [
      // Name on its own line above the chips, as on the other discovery cards: in one row the
      // fixed-width chip and duration leave it a few pixels in a narrow list, and "Lyon" vanishes.
      el("div", { class: "dest-body" }, [
        stationNameEl("dest-name", group.station, ctx.label(group.station)),
        el("span", { class: "dest-meta", attrs: { "aria-hidden": "true" } }, meta),
      ]),
      el("span", { class: "chev", attrs: { "aria-hidden": "true" } }, [icon(I.arrow)]),
    ],
  );

  return el("article", { class: "group-card", dataset: { station: group.station } }, [
    el("div", { class: "dest-row" }, [star, main]),
  ]);
}

/**
 * A ranked journey row: the station of interest + best total time + direct/via.
 * Used by "best" mode and by the connection-aware "from"/"to" browse results.
 */
export function reachTripRowEl(
  station: string,
  j: Journey,
  ctx: RenderCtx,
  extra?: HTMLElement,
  opts?: { hideVia?: boolean; openDate?: string },
): HTMLElement {
  const route: RoutePair = { origin: j.origin, destination: j.destination };
  const via = j.legs.length > 1;
  // Connecting trips get a "via" chip so a correspondence is obvious in the list;
  // direct trips stay clean. Callers that show an explicit change-count chip (Ideas)
  // pass hideVia so the two don't duplicate.
  const viaChip = via && !opts?.hideVia
    ? [
        el("span", {
          class: "chip chip-via",
          text: t("lbl_via", { hub: j.hubs.map((h) => ctx.label(h)).join(", ") }),
        }),
      ]
    : [];
  const aria = `${ctx.label(station)} — ${formatDuration(j.totalDurationMin)}${
    via ? ` (${t("lbl_via", { hub: j.hubs.map((h) => ctx.label(h)).join(", ") })})` : ""
  }`;
  // NAME on its own line, the via/count/duration chips wrapping below it — so the city name
  // always leads and reads in full on a phone, with the arrow stub kept on the right.
  const metaChips: HTMLElement[] = [
    ...viaChip,
    ...(extra ? [extra] : []),
    el("bdi", { text: formatDuration(j.totalDurationMin) }),
  ];
  const main = el(
    "button",
    {
      class: "dest-main dest-main-stacked",
      type: "button",
      attrs: { "aria-label": aria },
      on: { click: () => ctx.onOpenRoute(j.origin, j.destination, opts?.openDate ? { date: opts.openDate } : undefined) },
    },
    [
      el("div", { class: "dest-body" }, [
        stationNameEl("dest-name", station, ctx.label(station)),
        el("span", { class: "dest-meta", attrs: { "aria-hidden": "true" } }, metaChips),
      ]),
      el("span", { class: "chev", attrs: { "aria-hidden": "true" } }, [icon(I.arrow)]),
    ],
  );
  return el("article", { class: "group-card", dataset: { station } }, [
    el("div", { class: "dest-row" }, [favStarEl(route, ctx), main]),
  ]);
}


/**
 * A journey's detail: the direct/via chip with the total duration opposite it, then
 * each leg — the route, a rule, and the train row (times, "+1d", duration, number).
 * `label` names the leg (ALLER / RETOUR) when several journeys share one card, and
 * leads the head line beside the chip. Split out of journeyEl so the getaway card
 * can stack two of them in ONE ticket.
 */
function journeyBodyEl(j: Journey, ctx: RenderCtx, label?: string, dateLabel?: string): HTMLElement {
  const legs = el("div", { class: "legs" });
  j.legs.forEach((leg, i) => {
    if (i > 0) {
      legs.append(
        el("div", { class: "layover" }, [
          icon(I.clock),
          el("span", {
            text: t("lbl_connection", {
              dur: formatDuration(j.layovers[i - 1] ?? 0),
              hub: ctx.label(j.hubs[i - 1] ?? leg.origin),
            }),
          }),
        ]),
      );
    }
    const route = el("div", { class: "leg-route" }, [
      stationNameEl("", leg.origin, legEndpointLabel(ctx, leg, "origin")),
      icon(I.arrow),
      stationNameEl("", leg.destination, legEndpointLabel(ctx, leg, "destination")),
      ...(leg.date !== j.date
        ? [
            el("span", {
              class: "day-badge",
              text: t("lbl_dayoffset", { n: dayIndex(leg.date) - dayIndex(j.date) }),
            }),
          ]
        : []),
    ]);
    legs.append(el("div", { class: "leg" }, [route, trainRowEl(leg)]));
  });
  const tag =
    j.legs.length === 1
      ? el("span", { class: "chip chip-direct", text: t("lbl_direct") })
      : el("span", {
          class: "chip chip-via",
          text: t("lbl_via", { hub: j.hubs.map((h) => ctx.label(h)).join(", ") }),
        });
  const fee = ctx.fee?.(j);
  const head = el("div", { class: "journey-head" }, [
    ...(label ? [el("h3", { class: "trip-leg-title", text: label })] : []),
    // With flexible dates the list spans several days, so each card carries its own
    // date (otherwise which day a proposition is for is lost). Leads the head.
    ...(dateLabel ? [el("span", { class: "chip chip-date", text: dateLabel })] : []),
    fee
      ? el("span", { class: "journey-tags" }, [
          tag,
          el("span", { class: "chip chip-fee", text: t("fee_chip", { fee: formatFee(fee, getLang()) }) }),
        ])
      : tag,
    el("span", { class: "journey-total" }, [icon(I.clock), el("span", { text: formatDuration(j.totalDurationMin) })]),
  ]);
  return el("div", { class: "journey-body" }, [head, legs]);
}

/**
 * The calendar / map / save row under a journey's legs. Split out of journeyEl so the
 * getaway card can close with ONE row for the round trip instead of one per leg.
 */
function journeyActionsEl(
  j: Journey,
  ctx: RenderCtx,
  opts: { saveable?: boolean; hideMap?: boolean } = {},
): HTMLElement {
  return el("div", { class: "journey-sub" }, [
    el("button", { class: "btn btn-ghost", type: "button", on: { click: () => ctx.onIcs(j) } }, [
      icon(I.cal),
      el("span", { text: t("act_ics") }),
    ]),
    ...(opts.hideMap
      ? []
      : [
          // btn-map so CSS can drop it in the mobile detail view, where the map is
          // hidden and the action would be a dead no-op.
          el("button", { class: "btn btn-ghost btn-map", type: "button", on: { click: () => ctx.onShowJourney(j) } }, [
            icon(I.pin),
            el("span", { text: t("act_map") }),
          ]),
        ]),
    ...(opts.saveable !== false ? [tripSaveBtn(j, ctx)] : []),
  ]);
}


/**
 * One destination in the duration search's LIST page: the city, how many start days
 * work (in the searched window and across the whole bookable one), the best
 * round-trip travel time, and an arrow into the city's own page — its calendar of
 * workable days plus every dated solution. Deliberately says nothing about times:
 * comparing places comes first, picking a day second.
 */
export function getawayCityRowEl(
  trip: Getaway,
  ctx: RenderCtx,
  opts: { metric?: string; openTo?: string } = {},
): HTMLElement {
  // Normal getaway: the card names `trip.destination` (where you go) and opens the route
  // origin → destination. REVERSE discovery (opts.openTo set): `trip.destination` is the
  // discovered ORIGIN we're listing, and the route opens that origin → the fixed target
  // the user typed (openTo) — so a destination-only round trip lists "where can I come
  // from" and tapping opens the real O → D trip.
  const named = trip.destination; // the station shown on the card
  const routeOrigin = opts.openTo != null ? named : trip.outbound.origin;
  const routeDest = opts.openTo != null ? opts.openTo : trip.destination;
  const route: RoutePair = { origin: routeOrigin, destination: routeDest };
  // How many changes the outbound takes — Direct / N correspondance(s), colour-matched to
  // the map pins (green direct / amber 1 / red 2+). The point of a discovery row is "can I
  // get there, and how hard is it", so this rides alongside the mode's headline metric.
  const changes = trip.outbound.legs.length - 1;
  const changeChip =
    changes === 0
      ? el("span", { class: "chip chip-direct", text: t("lbl_direct") })
      : el("span", { class: `chip chip-changes chip-changes-${Math.min(changes, 2)}`, text: t("lbl_changes", { n: changes }) });
  const main = el(
    "button",
    {
      class: "dest-main dest-main-stacked",
      type: "button",
      attrs: { "aria-label": `${ctx.label(named)} — ${opts.metric ?? t("lbl_changes", { n: changes })}` },
      // Open on the idea's OWN start day (its best there-and-back), so the round trip is
      // feasible — not anchored on today, which may have only an outbound and no return.
      on: { click: () => ctx.onOpenRoute(routeOrigin, routeDest, { date: trip.outbound.date }) },
    },
    [
      // Stack the city NAME on its own line above the chips, so a busy row (hours-on-site +
      // changes chip + travel time) can never squeeze the name down to a single letter on a
      // phone — the name is the point of the card and must always read in full.
      el("div", { class: "dest-body" }, [
        stationNameEl("dest-name", named, ctx.label(named)),
        el("span", { class: "dest-meta", attrs: { "aria-hidden": "true" } }, [
          // The mode's headline metric (hours on site / nights away) leads, so places
          // compare on what the mode is about; the changes chip follows.
          ...(opts.metric ? [el("span", { class: "chip chip-onsite", text: opts.metric })] : []),
          changeChip,
          el("bdi", { text: formatDuration(trip.travelMin) }),
        ]),
      ]),
      el("span", { class: "chev", attrs: { "aria-hidden": "true" } }, [icon(I.arrow)]),
    ],
  );
  return el("article", { class: "group-card", dataset: { station: named } }, [
    el("div", { class: "dest-row" }, [favStarEl(route, ctx), main]),
  ]);
}

/**
 * The header above a result list: the result count on the left, a "Sort" picker on
 * the right. Selecting a key calls `onSort`, which re-renders the list in place.
 */
export function listToolbarEl(
  count: string,
  current: SortKey,
  options: { value: SortKey; label: string }[],
  onSort: (key: SortKey) => void,
): HTMLElement {
  const sel = el(
    "select",
    { class: "sort-select", attrs: { "aria-label": t("sort_label") } },
    options.map((o) => el("option", { value: o.value, text: o.label })),
  ) as HTMLSelectElement;
  // The sort key is kept across modes, but each list offers a different subset. If
  // the carried-over key isn't one of these options, applySort no-ops it (natural
  // "rec" order), so show that — not a stale label the list isn't actually using.
  const offered = options.some((o) => o.value === current);
  sel.value = offered ? current : (options[0]?.value ?? "rec");
  sel.addEventListener("change", () => onSort(sel.value as SortKey));
  return el("div", { class: "list-toolbar" }, [
    el("span", { class: "muted count", text: count }),
    el("label", { class: "sort-field" }, [
      el("span", { class: "sort-label muted small", text: `${t("sort_label")}:` }),
      sel,
    ]),
  ]);
}

/**
 * A ranked best-trip row ("best" mode): the changes it takes, the month-long train count,
 * the fastest travel time, and the figure the active `sort` ranks by when it is another
 * one (days reachable, distance). Opens on the first day the destination is reachable.
 */
export function bestTripRowEl(trip: BestTrip, ctx: RenderCtx, trains?: number, sort?: SortKey): HTMLElement {
  const chips: HTMLElement[] = [];
  // How many changes it takes to get there — the point of the Ideas list: Direct, or
  // "N correspondance(s)". Colour-matched to the map pins (green direct / amber 1 / red 2+).
  const changes = trip.journey.legs.length - 1;
  chips.push(
    changes === 0
      ? el("span", { class: "chip chip-direct", text: t("lbl_direct") })
      : el("span", { class: `chip chip-changes chip-changes-${Math.min(changes, 2)}`, text: t("lbl_changes", { n: changes }) }),
  );
  if (trains != null && trains > 0) {
    chips.push(
      el("span", {
        class: "stat-chip",
        text: t("badge_trains", { n: trains }),
        attrs: { title: t("stat_window_hint", { trains, days: trip.days ?? 0 }) },
      }),
    );
  }
  if (sort === "days" && trip.days) chips.push(el("span", { class: "stat-chip", text: t("badge_days", { n: trip.days }) }));
  const km = sort === "closest" ? ctx.distanceKm(trip.journey.origin, trip.destination) : Infinity;
  if (Number.isFinite(km)) chips.push(el("span", { class: "stat-chip", text: t("nearby_km", { km: Math.round(km) }) }));
  const extra = el("span", { class: "row-chips" }, chips);
  return reachTripRowEl(trip.destination, trip.journey, ctx, extra, { hideVia: true, openDate: trip.firstDate });
}

/**
 * A nearby paid-connection alternative (radius search): the station, a `note` naming the
 * nearby station and its distance, and the free-MAX journey it offers. Clicking opens that
 * free route; the user covers the short hop to/from the exact endpoint themselves.
 */
export function nearbyTripRowEl(station: string, note: string, j: Journey, ctx: RenderCtx): HTMLElement {
  const via = j.legs.length > 1;
  const viaChip = via
    ? [el("span", { class: "chip chip-via", text: t("lbl_via", { hub: j.hubs.map((h) => ctx.label(h)).join(", ") }) })]
    : [];
  const main = el(
    "button",
    {
      class: "dest-main dest-main-stacked",
      type: "button",
      attrs: { "aria-label": `${ctx.label(station)} — ${note} — ${formatDuration(j.totalDurationMin)}` },
      on: { click: () => ctx.onOpenRoute(j.origin, j.destination) },
    },
    [
      el("div", { class: "dest-body" }, [
        stationNameEl("dest-name", station, ctx.label(station)),
        el("span", { class: "dest-meta", attrs: { "aria-hidden": "true" } }, [
          el("span", { class: "chip chip-soft km-chip", text: note }),
          ...viaChip,
          el("bdi", { text: formatDuration(j.totalDurationMin) }),
        ]),
      ]),
      el("span", { class: "chev", attrs: { "aria-hidden": "true" } }, [icon(I.arrow)]),
    ],
  );
  return el("article", { class: "group-card", dataset: { station } }, [
    el("div", { class: "dest-row" }, [favStarEl({ origin: j.origin, destination: j.destination }, ctx), main]),
  ]);
}

/**
 * A both-ends nearby alternative (radius search): leave from a nearby station AND
 * arrive at a nearby one. Shows both stations with their distances and the free
 * journey between them; clicking opens that route.
 */
export function nearbyBothRowEl(
  fromId: string,
  fromKm: number,
  toId: string,
  toKm: number,
  j: Journey,
  ctx: RenderCtx,
): HTMLElement {
  const main = el(
    "button",
    {
      class: "dest-main dest-main-stacked",
      type: "button",
      attrs: { "aria-label": `${ctx.label(fromId)} → ${ctx.label(toId)} — ${formatDuration(j.totalDurationMin)}` },
      on: { click: () => ctx.onOpenRoute(j.origin, j.destination) },
    },
    [
      el("div", { class: "dest-body" }, [
        el("span", { class: "dest-name" }, [
          el("bdi", { text: ctx.label(fromId) }),
          el("span", { class: "muted", text: " → " }),
          el("bdi", { text: ctx.label(toId) }),
        ]),
        el("span", { class: "dest-meta", attrs: { "aria-hidden": "true" } }, [
          el("span", { class: "chip chip-soft km-chip", text: t("nearby_km", { km: Math.max(fromKm, toKm) }) }),
          el("bdi", { text: formatDuration(j.totalDurationMin) }),
        ]),
      ]),
      el("span", { class: "chev", attrs: { "aria-hidden": "true" } }, [icon(I.arrow)]),
    ],
  );
  return el("article", { class: "group-card", dataset: { station: fromId } }, [
    el("div", { class: "dest-row" }, [favStarEl({ origin: j.origin, destination: j.destination }, ctx), main]),
  ]);
}

/**
 * A hidden-city ("hidden train") row: board at your origin, ride the free-MAX
 * ticket booked to a stop *past* your destination, and step off at your
 * destination. Shows your real origin → destination with the boarding and
 * calling-at times, tags the over-shoot stop you ticket to, and its Book link
 * deep-links the longer origin → beyond fare (the same départ).
 */
export function hiddenTrainRowEl(h: HiddenTrain, ctx: RenderCtx): HTMLElement {
  const b = h.book;
  const time = el("span", { class: "train-time" }, [
    el("strong", { text: b.depart }),
    icon(I.arrow),
    el("strong", { text: h.alight }),
    ...(h.alightMin >= 1440
      ? [el("span", { class: "day-offset", text: t("lbl_dayoffset", { n: Math.floor(h.alightMin / 1440) }) })]
      : []),
  ]);
  const route = el("div", { class: "leg-route" }, [
    stationNameEl("", h.origin, ctx.label(h.origin)),
    icon(I.arrow),
    stationNameEl("", h.destination, ctx.label(h.destination)),
  ]);
  const meta = el("span", { class: "train-meta" }, [
    icon(I.clock),
    el("bdi", { text: formatDuration(h.durationMin) }),
    el("span", { class: "train-no", text: t("lbl_train", { no: b.trainNo }) }),
    ...(b.axe ? [el("span", { class: "train-axe", text: b.axe })] : []),
  ]);
  const head = el("div", { class: "journey-head" }, [
    // A 🥷 marks the hidden-city trick at a glance — the same "little emoji" convention as
    // the 🌙 sleeper badge — so a hidden option never reads as a normal bookable journey.
    el("span", { class: "chip chip-hidden" }, [
      el("span", { class: "chip-hidden-emoji", attrs: { "aria-hidden": "true" }, text: "🥷" }),
      el("span", { text: t("hidden_chip") }),
    ]),
    el("span", { class: "journey-total" }, [icon(I.clock), el("span", { text: formatDuration(h.durationMin) })]),
  ]);
  // The ticket you actually buy runs origin → beyond; you alight early at your
  // destination. Spell that out so the over-shoot is never a surprise.
  const note = el("p", {
    class: "hidden-note muted small",
    text: t("hidden_row_note", { beyond: ctx.label(h.beyond), stop: ctx.label(h.destination) }),
  });
  const actions = el("div", { class: "actions" }, [
    // Book the longer origin → beyond fare (the same départ time as your ride).
    el(
      "a",
      {
        class: "btn btn-book",
        href: ctx.bookUrl(h.origin, h.beyond, b.date, b.depart),
        attrs: { target: "_blank", rel: "noopener noreferrer" },
      },
      [
        el("span", { text: t("hidden_book", { beyond: ctx.label(h.beyond) }) }),
        icon(I.external),
        el("span", { class: "sr-only", text: t("link_newtab") }),
      ],
    ),
  ]);
  const legs = el("div", { class: "legs" }, [el("div", { class: "leg" }, [route, el("div", { class: "train-row" }, [time, meta])])]);
  return el("article", { class: "journey journey-hidden" }, [head, legs, note, actions]);
}

/**
 * The 30-day strip with the selected day highlighted. Defaults to a route's
 * train-availability calendar; `opts` lets "best" mode relabel it as an
 * ideas-by-day strip (title + a "{n} destinations" count).
 */
export function calendarEl(
  days: CalendarDay[],
  ctx: RenderCtx,
  selected?: string,
  opts?: {
    title?: string;
    count?: (n: number, day: CalendarDay) => string;
    showCount?: boolean;
    countLegend?: string;
    /** Render every cell as a plain, tappable day (no available/unavailable colouring) —
     *  the neutral state used on the home form before a departure station is chosen. */
    neutral?: boolean;
    /** A short line shown in place of (neutral) or after (normal) the availability legend —
     *  e.g. "pick a departure station…" on the form, or a fallback note. */
    hint?: string;
    /** Render the heading visually hidden (sr-only) — it stays the grid's accessible label
     *  (aria-labelledby) but shows no visible text, for when an outer collapsible header
     *  already names the calendar (the home form's "Quand partir ?"), so the title isn't
     *  written twice. Results-page calendars omit it and keep the visible <h3>. */
    hideTitle?: boolean;
    /** Departure→return RANGE overlay (the Flexible Trip-tab picker): `selected` is the
     *  departure; `end` the picked return. Both endpoints read selected and the days
     *  strictly between are highlighted as a range. `awaiting` (departure chosen, no return
     *  yet) turns on a live hover preview of the pending range so the two-step is legible. */
    range?: { end?: string; awaiting?: boolean };
  },
): HTMLElement {
  const neutral = opts?.neutral === true;
  const countText = opts?.count ?? ((n: number) => t("badge_trains", { n }));
  const showCount = opts?.showCount !== false && !neutral;
  // What the per-cell number means (trains on a route, or destinations per day).
  const countLegend = opts?.countLegend ?? t("cal_legend_count");
  const headingId = `cal-h-${++uidSeq}`;
  // role=grid + aria-labelledby ties the day cells to their heading so the widget
  // announces as a labelled date grid (mirrors the form's dp-grid, which is a single
  // Tab stop with roving arrow focus rather than ~30 individual Tab stops).
  const grid = el("div", { class: "cal-grid", attrs: { role: "grid", "aria-labelledby": headingId } });
  // Arrow-key navigation: move focus between day cells (←/→ a day, ↑/↓ a row,
  // Home/End to the ends). The grid is a linear sequence of days, so the row size
  // is read live from the layout (10 columns on desktop, 7 on phones). Focus roves
  // via tabindex so only the current cell is in the Tab order.
  grid.addEventListener("keydown", (e) => {
    const keys = ["ArrowRight", "ArrowLeft", "ArrowUp", "ArrowDown", "Home", "End"];
    if (!keys.includes(e.key)) return;
    const cells = [...grid.querySelectorAll<HTMLButtonElement>(".cal-cell")];
    const i = cells.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    e.preventDefault();
    let cols = 1;
    const top = cells[0]?.offsetTop;
    for (let k = 1; k < cells.length; k++) {
      if (cells[k]?.offsetTop !== top) break;
      cols++;
    }
    const target =
      e.key === "ArrowRight" ? i + 1
      : e.key === "ArrowLeft" ? i - 1
      : e.key === "ArrowDown" ? i + cols
      : e.key === "ArrowUp" ? i - cols
      : e.key === "Home" ? 0
      : cells.length - 1;
    const dest = cells[Math.max(0, Math.min(cells.length - 1, target))];
    if (!dest) return;
    for (const cell of cells) cell.setAttribute("tabindex", "-1");
    dest.setAttribute("tabindex", "0");
    dest.focus();
  });
  // While the return is being picked (departure chosen, awaiting the second tap), hovering a
  // day previews the pending departure→return band, so the two-step range reads clearly.
  if (opts?.range?.awaiting && selected) {
    const out = selected;
    grid.addEventListener("mouseover", (e) => {
      const cell = (e.target as HTMLElement).closest<HTMLElement>(".cal-cell");
      const hover = cell?.getAttribute("data-date");
      if (!hover) return;
      for (const c of grid.querySelectorAll<HTMLElement>(".cal-cell")) {
        const cd = c.getAttribute("data-date");
        c.classList.toggle("preview", Boolean(cd) && cd! > out && cd! <= hover);
      }
    });
    grid.addEventListener("mouseleave", () => {
      for (const c of grid.querySelectorAll<HTMLElement>(".cal-cell")) c.classList.remove("preview");
    });
  }
  const first = days[0]?.date ?? "";
  const leading = first ? (new Date(`${first}T00:00:00`).getDay() + 6) % 7 : 0;
  for (let i = 0; i < leading; i++) grid.append(el("span", { class: "cal-blank", attrs: { "aria-hidden": "true" } }));
  let anyNearby = false;
  let anyBoth = false;
  // Departure→return range overlay (Flexible Trip-tab picker): both endpoints read
  // selected, the days strictly between get a `range` band.
  const rangeEnd = opts?.range?.end;
  for (const d of days) {
    const sel = d.date === selected || (rangeEnd !== undefined && d.date === rangeEnd) ? " sel" : "";
    const inRange =
      opts?.range && selected && rangeEnd && d.date > selected && d.date < rangeEnd ? " range" : "";
    // Four states: free seat on the exact route (ok); reachable by substituting one
    // endpoint with a nearby station (near); only by substituting both ends
    // (near-both); or nothing (no). The last two are radius-search only. NB: these
    // class names are calendar-local — "near" not "nearby", which is the results
    // section's class and would leak its margin onto the cells.
    const nearby = !neutral && !d.available && Boolean(d.nearby);
    const both = !neutral && !d.available && !d.nearby && Boolean(d.nearbyBoth);
    if (nearby) anyNearby = true;
    if (both) anyBoth = true;
    const state = neutral
      ? "neutral"
      : d.available
        ? "ok"
        : nearby
          ? "near"
          : both
            ? "near-both"
            : "no";
    const status = neutral
      ? ctx.formatDate(d.date)
      : d.available
        ? t("cal_available")
        : nearby
          ? t("cal_nearby")
          : both
            ? t("cal_nearby_both")
            : t("cal_unavailable");
    // A neutral cell is just a tappable day — its label is the date alone (no "— status").
    const label = neutral
      ? ctx.formatDate(d.date)
      : `${ctx.formatDate(d.date)} — ${d.available ? countText(d.count, d) : status}`;
    const cell = el(
      "button",
      {
        class: `cal-cell ${state}${sel}${inRange}`,
        type: "button",
        title: label,
        attrs: {
          // The per-cell metric (hours on site / nights / destinations) is the point of
          // the strip, so it must be IN the accessible name — the visual count badge is
          // aria-hidden, so an AT user would otherwise hear only "available" on every cell.
          "aria-label": label,
          role: "gridcell",
          tabindex: "-1",
          "data-date": d.date,
          ...(sel ? { "aria-current": "date" } : {}),
        },
        on: { click: () => ctx.onSelectDay(d.date) },
      },
      [
        el("span", { class: "cal-day", text: d.date.slice(8, 10) }),
        // A tiny per-day count, shown only where it's exact (route / return strips).
        ...(showCount && d.available && d.count > 0
          ? [el("span", { class: "cal-count", text: String(d.count), attrs: { "aria-hidden": "true" } })]
          : []),
      ],
    );
    grid.append(cell);
  }
  // One Tab stop with roving focus inside (arrows): only the entry cell is tabbable —
  // the selected day, else the first available, else the first cell.
  (grid.querySelector<HTMLElement>(".cal-cell.sel") ??
    grid.querySelector<HTMLElement>(".cal-cell.ok") ??
    grid.querySelector<HTMLElement>(".cal-cell"))?.setAttribute("tabindex", "0");
  // Neutral: the hint stands alone (no colour legend). Otherwise the availability legend,
  // with any hint appended after it.
  const legend = neutral
    ? (opts?.hint ?? "")
    : [
        t("cal_legend"),
        ...(showCount ? [countLegend] : []),
        ...(anyNearby ? [t("cal_legend_nearby")] : []),
        ...(anyBoth ? [t("cal_legend_nearby_both")] : []),
        ...(opts?.hint ? [opts.hint] : []),
      ].join(" · ");
  const dowHead = el("div", { class: "cal-dow-head", attrs: { "aria-hidden": "true" } });
  const refMonday = first ? addDays(first, -leading) : "";
  for (let i = 0; i < 7; i++)
    dowHead.append(el("span", { class: "cal-dow-c", text: refMonday ? ctx.formatWeekday(addDays(refMonday, i)) : "" }));
  return el("section", { class: "calendar" }, [
    el("h3", {
      ...(opts?.hideTitle ? { class: "sr-only" } : {}),
      text: opts?.title ?? t("cal_title"),
      attrs: { id: headingId },
    }),
    dowHead,
    grid,
    el("p", { class: "cal-legend muted", text: legend }),
  ]);
}

/**
 * The whole trip on one page: a single journey (one-way) or a round trip
 * (outbound + inbound) with a title, a nights/total-travel summary, each leg as a
 * full bookable journey card, and a Save button. Used in the trip modal and shown
 * when a getaway row or a saved trip is opened.
 */
export function tripViewEl(outbound: Journey, ctx: RenderCtx, inbound?: Journey): HTMLElement {
  const round = Boolean(inbound);
  const title = `${ctx.label(outbound.origin)} ${round ? "⇄" : "→"} ${ctx.label(outbound.destination)}`;
  const totalTravel = outbound.totalDurationMin + (inbound?.totalDurationMin ?? 0);
  let summary: string;
  if (inbound) {
    const nights = dayIndex(inbound.date) - dayIndex(outbound.date);
    if (nights > 0) {
      summary = t("trip_summary", { n: nights, dur: formatDuration(totalTravel) });
    } else {
      // Same-day round trip: surface how long you actually get in the city. Use the
      // outbound's ABSOLUTE arrival (departMin + span), not the last leg's own-date
      // arriveMin, so a connecting outbound isn't credited with bogus extra hours.
      const onSite = Math.max(0, inbound.departMin - (outbound.departMin + outbound.totalDurationMin));
      summary = t("trip_summary_day", { onsite: formatDuration(onSite), dur: formatDuration(totalTravel) });
    }
  } else {
    summary = t("trip_summary_oneway", { date: ctx.formatDate(outbound.date), dur: formatDuration(totalTravel) });
  }
  // This is the booking/confirmation screen: each leg carries a clear "Book this leg"
  // primary (a direct train deep-links straight; a connecting one opens the per-train step
  // modal) and clicking the card body books it too (`bookOnClick`). No highlight-only
  // no-op — the whole point here is to book, not to re-select.
  const view = el("div", { class: "trip-view" });
  // Each leg carries its OWN unmistakable book action, so the traveller is never left
  // wondering how to get the ticket: a round trip books the outbound with "Book the
  // outbound" and the return with "Book the return" (each a separate SNCF Connect search —
  // a through-ticket can't be deep-linked), a one-way just "Book this trip".
  const legBook = (label: string) => ({ saveable: false, bookOnClick: true, bookLabel: label, hideMap: true });
  // Each leg's DATE sits on the ticket header (beside "Outbound" / "Return") so a round-trip
  // confirmation says which day each leg is for — the two legs fall on different days, so it
  // can't be read off the shared title. It lives on the leg TITLE line (full width, wraps
  // freely) rather than crammed into the journey head beside the via/duration chips, where a
  // long date would truncate on a narrow phone. One-ways already print the date in the summary.
  const legTitle = (label: string, date: string): HTMLElement =>
    el("h3", { class: "trip-leg-title trip-leg-title-dated" }, [
      el("span", { class: "trip-leg-name", text: label }),
      el("span", { class: "trip-leg-date", text: ctx.formatDate(date) }),
    ]);
  view.append(
    el("h2", { class: "modal-title trip-title", text: title }),
    el("p", { class: "muted trip-summary", text: summary }),
    el("section", { class: "trip-leg" }, [
      ...(round ? [legTitle(t("rt_outbound"), outbound.date)] : []),
      journeyEl(outbound, ctx, legBook(round ? t("act_book_out") : t("act_book_leg_this"))),
    ]),
    ...(inbound
      ? [
          el("section", { class: "trip-leg" }, [
            legTitle(t("rt_inbound"), inbound.date),
            journeyEl(inbound, ctx, legBook(t("act_book_ret"))),
          ]),
        ]
      : []),
    // A round trip books leg by leg — say so, so the two book buttons don't read as a
    // choice of one or the other.
    ...(inbound ? [el("p", { class: "trip-book-note muted small", text: t("trip_book_note") })] : []),
    // Save the trip + a travel guide for the destination city (what to do once there).
    el("div", { class: "trip-view-actions" }, [
      tripSaveBtn(outbound, ctx, inbound),
      guideEl(ctx, outbound.destination, "button"),
    ]),
  );
  return view;
}

/**
 * One leg of a multi-city recap: the requested hop plus the chosen journey, or
 * `null` when that hop has no free MAX seat. Carrying the null (instead of dropping
 * the leg) lets the recap show the trip honestly as incomplete.
 */
export interface RecapLeg {
  from: string;
  to: string;
  date: string;
  journey: Journey | null;
}

export function multiTripViewEl(legs: RecapLeg[], ctx: RenderCtx): HTMLElement {
  const stops = legs.length ? [legs[0]!.from, ...legs.map((l) => l.to)] : [];
  const title = stops.map((s) => ctx.label(s)).join(" → ");
  const totalTravel = legs.reduce((sum, l) => sum + (l.journey?.totalDurationMin ?? 0), 0);
  const incomplete = legs.some((l) => !l.journey);
  const view = el("div", { class: "trip-view" }, [
    el("h2", { class: "modal-title trip-title", text: title }),
    el("p", { class: "muted trip-summary" }, [
      icon(I.clock),
      el("span", { text: formatDuration(totalTravel) }),
    ]),
  ]);
  // A leg with no seat can't just vanish — call the whole itinerary out as incomplete
  // so an N-1-leg chain isn't presented as a finished trip.
  if (incomplete) view.append(el("p", { class: "notice trip-incomplete", text: t("multi_incomplete") }));
  // Each leg's travel date rides on its title, as on the round-trip ticket.
  legs.forEach((leg) => {
    view.append(
      el("section", { class: "trip-leg" }, [
        el("h3", { class: "trip-leg-title trip-leg-title-dated" }, [
          el("span", { class: "trip-leg-name" }, [
            el("bdi", { text: ctx.label(leg.from) }),
            el("span", { class: "muted", text: " → " }),
            el("bdi", { text: ctx.label(leg.to) }),
          ]),
          el("span", { class: "trip-leg-date", text: ctx.formatDate(leg.date) }),
        ]),
        leg.journey ? journeyEl(leg.journey, ctx, { saveable: false, hideMap: true }) : emptyEl(t("res_none")),
      ]),
    );
  });
  return view;
}

/** Straight-line km between a journey's endpoints, or null if unmeasurable. */
function legKm(j: Journey, ctx: RenderCtx): number | null {
  const d = ctx.distanceKm(j.origin, j.destination);
  return Number.isFinite(d) ? Math.round(d) : null;
}

/** A multi-city tour itinerary (tour mode); `hideMap` drops its map actions. */
export function tourEl(tour: Tour, ctx: RenderCtx, hideMap = false): HTMLElement {
  const first = tour.legs[0];
  const stops = first ? [first.origin, ...tour.legs.map((l) => l.destination)] : [];
  // Total straight-line distance across every hop ("as the crow flies").
  const totalKm = tour.legs.reduce((s, j) => s + (legKm(j, ctx) ?? 0), 0);
  // Build the article first so each leg can share it as a selection group: clicking
  // a leg highlights only that one across the whole tour (not one per day band).
  const article = el("article", { class: "tour" });
  const headParts = [
    el("span", { class: "tour-route", text: stops.map((s) => ctx.label(s)).join(" → ") }),
    el("span", { class: "tour-totals" }, [
      ...(totalKm > 0
        ? [el("span", { class: "tour-km", attrs: { title: t("nearest_hint") }, text: `${totalKm} km` })]
        : []),
      el("span", { class: "journey-total" }, [
        icon(I.clock),
        el("span", { text: formatDuration(tour.totalDurationMin) }),
      ]),
    ]),
  ];
  // Unless the map is hidden, the header is a button drawing the whole tour (every
  // stop) on the map, so after inspecting a single leg you can get the overview back.
  const head = hideMap
    ? el("div", { class: "tour-head" }, headParts)
    : el("button", {
        class: "tour-head is-clickable",
        type: "button",
        attrs: { title: t("act_map"), "aria-label": t("act_map") },
        on: { click: () => ctx.onShowTour(tour) },
      }, headParts);
  // "Day N" is the actual trip day of each hop, so a multi-day stay shows real
  // gaps (Day 1, Day 4, …) rather than a misleading 1-per-row count. Each leg is a
  // clear day band: a bold numbered badge + the date, so days are easy to scan.
  const base = first ? dayIndex(first.date) : 0;
  const legs = tour.legs.map((j) => {
    const km = legKm(j, ctx);
    const dayNum = dayIndex(j.date) - base + 1;
    const dayLabel = t("tour_day", { n: dayNum, date: ctx.formatDate(j.date) });
    return el("div", { class: "tour-leg" }, [
      el("div", { class: "tour-leg-head" }, [
        el("span", {
          class: "tour-day-badge",
          text: String(dayNum),
          attrs: { "aria-label": dayLabel, title: dayLabel },
        }),
        el("span", { class: "tour-day-date", text: ctx.formatDate(j.date) }),
        ...(km != null
          ? [el("span", { class: "leg-km muted", attrs: { title: t("nearest_hint") }, text: `${km} km` })]
          : []),
      ]),
      journeyEl(j, ctx, { group: article, hideMap }),
    ]);
  });
  article.append(
    el("div", { class: "tour-top" }, [head, tourSaveBtn(tour, ctx)]),
    el("div", { class: "tour-legs" }, legs),
  );
  return article;
}

/** A Save button for a whole multi-city tour (mirrors the journey Save button). */
function tourSaveBtn(tour: Tour, ctx: RenderCtx): HTMLElement {
  const saved = (): boolean => ctx.isTourSaved(tour);
  const lbl = el("span", { text: saved() ? t("act_saved") : t("act_save") });
  const btn = el(
    "button",
    {
      class: saved() ? "btn btn-ghost tour-save is-saved" : "btn btn-ghost tour-save",
      type: "button",
      attrs: { "aria-pressed": String(saved()), title: saved() ? t("act_unsave") : t("act_save") },
      on: {
        click: () => {
          ctx.onToggleTour(tour);
          const now = saved();
          btn.classList.toggle("is-saved", now);
          btn.setAttribute("aria-pressed", String(now));
          btn.title = now ? t("act_unsave") : t("act_save");
          lbl.textContent = now ? t("act_saved") : t("act_save");
        },
      },
    },
    [icon(I.bookmark), lbl],
  );
  return btn;
}

export function emptyEl(message: string): HTMLElement {
  return el("p", { class: "empty", text: message });
}

/** A muted "things to try" hint shown under a no-results message. */
export function hintEl(text: string): HTMLElement {
  return el("p", { class: "empty-hint muted", text });
}
