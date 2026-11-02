import type { Theme, Density } from "../state/store";
import { el, optionEl, isTouch } from "./dom";
import { t, LANGS, getLang } from "../i18n";
import { APP_VERSION, APP_BUILD } from "../config";
import type { CardType } from "../types";
import { parseCard } from "../data/profile";
import {
  SHARE_SVG,
  CHECK_SVG,
  MENU_SVG,
  MENU_CLOSE_SVG,
  INSTALL_SVG,
  LOGO_SVG,
  GITHUB_SVG,
  SEARCH_SVG,
  BOOKMARK_SVG,
  themeSvg,
} from "./icons";

type Card = CardType;

/** Callbacks and initial state the shell needs; it holds no app state of its own. */
export interface ShellProps {
  theme: Theme;
  card: Card;
  updatedText: string;
  form: HTMLElement;
  githubUrl: string;
  issuesUrl: string;
  goHome: () => void;
  onLang: (code: string) => void;
  onThemeChange: (theme: Theme) => void;
  onCard: (card: Card) => void;
  onShare: (onCopied: () => void) => void;
  onInstall: () => void;
  onShortcuts: () => void;
  onSettings: () => void;
  onSaved: () => void;
  onOpenMobileForm: () => void;
  onSelect: (id: string) => void;
  onPeek: (id: string | null) => void;
}

/** The elements the controller wires results/favorites/map into. */
export interface ShellHandles {
  header: HTMLElement;
  layout: HTMLElement;
  cardSelect: HTMLSelectElement;
  title: HTMLElement;
  results: HTMLElement;
  mapEl: HTMLElement;
  favList: HTMLElement;
  tripList: HTMLElement;
}

/**
 * Reflect the chosen theme on the document root, where the stylesheet keys off it.
 * @param theme the theme to apply.
 */
export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}

/** Reflect the results density on the document root, where the stylesheet keys off it. */
export function applyDensity(density: Density): void {
  document.documentElement.dataset.density = density;
}

/** Reflect the low-end / motion preferences on the root, where the stylesheet + the
 *  view-transition and map guards key off them. */
export function applyReduceMotion(on: boolean): void {
  document.documentElement.dataset.reduceMotion = on ? "on" : "";
}
export function applyMap(on: boolean): void {
  document.documentElement.dataset.map = on ? "on" : "off";
}

/** Close the header overflow menu if it is open, restoring the toggle button. */
export function closeHeaderMenu(): void {
  const nav = document.querySelector<HTMLElement>(".header-nav.menu-open");
  if (!nav) return;
  nav.classList.remove("menu-open");
  const btn = nav.querySelector<HTMLButtonElement>(".menu-btn");
  if (btn) {
    btn.setAttribute("aria-expanded", "false");
    btn.innerHTML = MENU_SVG;
  }
}

// The shell is rebuilt on every language change; the previous drawer's media-query
// and resize listeners would otherwise pile up, each keeping a detached drawer alive
// and being resized. buildShell tears the old one down before wiring a new one.
let teardownDrawer: (() => void) | null = null;

/**
 * Make the results drawer a draggable bottom sheet on narrow screens, snapping
 * between peek / half / full detents. A no-op where matchMedia is unavailable.
 * @param drawer the drawer element to size.
 * @param handle the grab handle that drives the drag.
 * @param bar the floating search bar; the drawer's full height stops just below it.
 * @returns a cleanup that removes the listeners and observer it installed.
 */
function setupDrawer(drawer: HTMLElement, handle: HTMLElement, bar: HTMLElement): () => void {
  const mq = typeof window.matchMedia === "function" ? window.matchMedia("(max-width: 860px)") : null;
  if (!mq) return () => {};
  const order = ["peek", "half", "full"] as const;
  type Detent = (typeof order)[number];
  // Open at the half detent, not the tiny peek: a peek-height sheet showed only a
  // row or two and read as "stuck, can't scroll the list" until you found the drag
  // handle. Half shows a usable chunk of results straight away (still draggable).
  let state: Detent = "half";

  const sizes = (): Record<Detent, number> => {
    const full = Math.max(240, Math.round(window.innerHeight - bar.getBoundingClientRect().bottom - 8));
    const handleH = handle.offsetHeight || 46;
    return {
      peek: Math.max(handleH + 92, Math.round(full * 0.24)),
      half: Math.round(full * 0.55),
      full,
    };
  };

  const snap = (s: Detent): void => {
    state = s;
    drawer.dataset.state = s;
    // The bar only shows in the results view; measured while hidden, every detent is wrong.
    if (mq.matches && bar.getClientRects().length) drawer.style.height = `${sizes()[s]}px`;
  };

  let dragging = false;
  let startY = 0;
  let startH = 0;
  let moved = false;

  handle.addEventListener("pointerdown", (e) => {
    if (!mq.matches) return;
    dragging = true;
    moved = false;
    startY = e.clientY;
    startH = drawer.getBoundingClientRect().height;
    drawer.style.transition = "none";
    // Try to capture, but the drag no longer DEPENDS on it: the move/up listeners are
    // on window, so the gesture keeps working even where setPointerCapture is refused.
    try {
      handle.setPointerCapture(e.pointerId);
    } catch {
      /* window listeners below still track the drag */
    }
  });
  // Move/up on WINDOW, not the handle: once the finger slides off the thin grip the
  // events target whatever is underneath, so a handle-bound listener would miss them
  // and the sheet would freeze mid-drag. Guarded by `dragging` so it's inert otherwise.
  const onMove = (e: PointerEvent): void => {
    if (!dragging) return;
    if (Math.abs(e.clientY - startY) > 6) moved = true;
    const s = sizes();
    const h = Math.max(s.peek, Math.min(s.full, startH + (startY - e.clientY)));
    drawer.style.height = `${h}px`;
  };
  const finish = (): void => {
    if (!dragging) return;
    dragging = false;
    drawer.style.transition = "";
    const s = sizes();
    const h = drawer.getBoundingClientRect().height;
    let best: Detent = order[0];
    for (const k of order) {
      if (Math.abs(s[k] - h) < Math.abs(s[best] - h)) best = k;
    }
    snap(best);
  };
  const onCancel = (): void => {
    finish();
    // No click follows a cancelled gesture, so the click handler can't clear
    // `moved` — reset it here or the next genuine tap on the handle is swallowed.
    moved = false;
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", finish);
  window.addEventListener("pointercancel", onCancel);
  handle.addEventListener("click", () => {
    if (moved) {
      moved = false;
      return;
    }
    snap(state === "peek" ? "half" : "peek");
  });

  const sync = (): void => {
    if (mq.matches) {
      // A layout change resizes the sheet at once; only a tap or a drag animates it.
      drawer.style.transition = "none";
      snap(state);
      void drawer.offsetHeight;
      drawer.style.transition = "";
    } else {
      drawer.style.height = "";
      drawer.style.transition = "";
    }
  };
  mq.addEventListener("change", sync);
  window.addEventListener("resize", sync);
  // Re-measure each time the bar appears (entering the results view) or changes height.
  const ro = typeof ResizeObserver === "function" ? new ResizeObserver(() => sync()) : null;
  ro?.observe(bar);
  return () => {
    ro?.disconnect();
    mq.removeEventListener("change", sync);
    window.removeEventListener("resize", sync);
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", finish);
    window.removeEventListener("pointercancel", onCancel);
  };
}

/* ── header ── */

/**
 * Build the site header: brand, and an overflow menu holding the language and pass
 * selectors plus the icon actions (GitHub, shortcuts, theme, share, install).
 * @param props shell state and callbacks.
 * @returns the header element and the pass selector (needed by the controller).
 */
function buildHeader(props: ShellProps): { header: HTMLElement; cardSelect: HTMLSelectElement } {
  const langSel = el(
    "select",
    { class: "ctl", attrs: { "aria-label": t("ctl_lang") } },
    LANGS.map((l) => optionEl(l.code, l.label, getLang() === l.code)),
  ) as HTMLSelectElement;
  langSel.addEventListener("change", () => props.onLang(langSel.value));

  let currentTheme = props.theme;
  const themeBtn = el("button", {
    class: "ctl icon-ctl",
    type: "button",
    attrs: { "aria-label": t("ctl_theme"), title: t("ctl_theme") },
    html: themeSvg(currentTheme),
  });
  themeBtn.addEventListener("click", () => {
    const order: Theme[] = ["auto", "light", "dark"];
    currentTheme = order[(order.indexOf(currentTheme) + 1) % order.length]!;
    applyTheme(currentTheme);
    themeBtn.innerHTML = themeSvg(currentTheme);
    props.onThemeChange(currentTheme);
  });

  const keysBtn = el("button", {
    class: "ctl icon-ctl keys-btn",
    type: "button",
    text: "?",
    attrs: { "aria-label": t("keys_title"), title: t("keys_title") },
    on: { click: () => props.onShortcuts() },
  });
  if (isTouch()) keysBtn.style.display = "none";

  // Settings (performance / display options for low-end devices). Density lives here
  // too now (as "Compact results"), so the old standalone density header button is
  // gone — one entry point, less clutter in the menu.
  const SETTINGS_SVG =
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';
  const settingsBtn = el("button", {
    class: "ctl icon-ctl settings-btn",
    type: "button",
    attrs: { "aria-label": t("act_settings"), title: t("act_settings") },
    html: SETTINGS_SVG,
    on: { click: () => props.onSettings() },
  });

  const cardSel = el("select", { class: "ctl", attrs: { "aria-label": t("field_card") } }, [
    optionEl("jeune", t("card_jeune"), props.card === "jeune"),
    optionEl("senior", t("card_senior"), props.card === "senior"),
    optionEl("interrail", t("card_interrail"), props.card === "interrail"),
  ]) as HTMLSelectElement;
  cardSel.addEventListener("change", () => props.onCard(parseCard(cardSel.value)));

  const installBtn = el("button", {
    class: "ctl install-btn",
    type: "button",
    attrs: { "aria-label": t("act_install"), title: t("act_install") },
    html: `${INSTALL_SVG}<span class="install-label">${t("act_install")}</span>`,
    on: { click: () => props.onInstall() },
  });

  const shareBtn = el("button", {
    class: "ctl icon-ctl share-btn",
    type: "button",
    attrs: { "aria-label": t("act_share"), title: t("act_share") },
    html: SHARE_SVG,
  });
  shareBtn.addEventListener("click", () => {
    props.onShare(() => {
      shareBtn.innerHTML = CHECK_SVG;
      shareBtn.title = t("share_copied");
      setTimeout(() => {
        shareBtn.innerHTML = SHARE_SVG;
        shareBtn.title = t("act_share");
      }, 1600);
    });
  });

  // Saved trips + favorites live in the results column, which a phone hides on the
  // form screen; this entry opens the saved page from anywhere.
  const savedBtn = el("button", {
    class: "ctl saved-btn",
    type: "button",
    html: `${BOOKMARK_SVG}<span>${t("menu_saved")}</span>`,
    on: { click: () => props.onSaved() },
  });

  const ghLink = el("a", {
    class: "ctl icon-ctl gh-link",
    html: GITHUB_SVG,
    href: props.githubUrl,
    attrs: { target: "_blank", rel: "noopener noreferrer", "aria-label": "GitHub", title: "GitHub" },
  });

  // A few controls stay visible in the header at all times (never behind the menu): the
  // MAX pass (switched often), Install, and Settings. Everything else — language, GitHub,
  // theme, share, shortcuts — lives behind the hamburger to keep the mobile header compact.
  const quickCtls = el("div", { class: "header-quick" }, [cardSel, installBtn, settingsBtn]);
  const headerCtls = el("div", { class: "header-ctls" }, [
    el("div", { class: "menu-selects" }, [langSel, savedBtn]),
    el("div", { class: "menu-actions" }, [ghLink, keysBtn, themeBtn, shareBtn]),
  ]);
  const menuBtn = el("button", {
    class: "ctl icon-ctl menu-btn",
    type: "button",
    attrs: {
      "aria-label": t("ctl_menu"),
      title: t("ctl_menu"),
      "aria-expanded": "false",
      "aria-haspopup": "true",
    },
    html: MENU_SVG,
  });
  const headerNav = el("div", { class: "header-nav" }, [quickCtls, menuBtn, headerCtls]);
  menuBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    const open = headerNav.classList.toggle("menu-open");
    menuBtn.setAttribute("aria-expanded", String(open));
    menuBtn.innerHTML = open ? MENU_CLOSE_SVG : MENU_SVG;
  });

  const header = el("header", { class: "site-header" }, [
    el("div", { class: "brand" }, [
      el("button", {
        class: "logo",
        type: "button",
        attrs: { "aria-label": t("appName"), title: t("appName") },
        on: { click: () => props.goHome() },
        html: LOGO_SVG,
      }),
      el("div", { class: "brand-head" }, [
        el("h1", { text: t("appName") }),
        el("span", { class: "brand-badge", text: "SNCF · OPEN DATA" }),
      ]),
    ]),
    headerNav,
  ]);
  return { header, cardSelect: cardSel };
}

/* ── shell ── */

/**
 * Build the whole page shell: header, the search form column with its results
 * drawer and mobile search bar, and the map column.
 * @param props shell state and callbacks.
 * @returns the header, layout, and the element handles the controller wires into.
 */
export function buildShell(props: ShellProps): ShellHandles {
  // Tear down the previous shell's drawer listeners before building a new one, so a
  // language-change rebuild doesn't stack them on orphaned elements.
  teardownDrawer?.();
  teardownDrawer = null;
  const { header, cardSelect } = buildHeader(props);

  const title = el("h2", {
    class: "results-title",
    id: "results-title",
    text: t("tagline"),
    attrs: { tabindex: "-1" },
  });
  const results = el("div", { class: "results", attrs: { "aria-live": "polite" } });
  const mapEl = el("div", { class: "map", attrs: { "aria-label": t("map_title") } });

  const tripList = el("div", { class: "trip-list" });
  const savedAside = el("aside", { class: "saved-trips" }, [el("h2", { text: t("saved_title") }), tripList]);

  const favList = el("div", { class: "fav-list" });
  const aside = el("aside", { class: "favorites" }, [el("h2", { text: t("fav_title") }), favList]);

  const footer = el("footer", { class: "site-footer" }, [
    el("p", { class: "muted small updated", attrs: { title: t("data_why") }, text: props.updatedText }),
    el("p", { class: "muted", text: t("foot_source") }),
    el("p", { class: "muted small", text: t("foot_disclaimer") }),
    el("div", { class: "foot-actions" }, [
      el("a", {
        class: "btn btn-ghost feedback-btn",
        text: t("act_report"),
        href: props.issuesUrl,
        attrs: { target: "_blank", rel: "noopener noreferrer" },
      }),
      el("a", {
        class: "foot-link",
        text: "GitHub",
        href: props.githubUrl,
        attrs: { target: "_blank", rel: "noopener noreferrer" },
      }),
    ]),
    el("p", {
      class: "muted small foot-version",
      text: `Railmap v${APP_VERSION}${APP_BUILD ? ` · ${APP_BUILD}` : ""}`,
    }),
  ]);

  const mapSection = el("section", { class: "map-section", attrs: { "aria-label": t("map_title") } }, [mapEl]);
  const drawerHandle = el(
    "button",
    { class: "drawer-handle", type: "button", attrs: { "aria-label": t("act_results"), title: t("act_results") } },
    [el("span", { class: "drawer-grip", attrs: { "aria-hidden": "true" } })],
  );
  const resultsDrawer = el("div", { class: "results-drawer" }, [
    drawerHandle,
    el("div", { class: "drawer-scroll" }, [title, results, savedAside, aside, footer]),
  ]);
  const msearchBar = el(
    "button",
    { class: "msearch-bar", type: "button", attrs: { "aria-label": t("btn_search") }, on: { click: () => props.onOpenMobileForm() } },
    [
      el("span", { class: "msearch-icon", attrs: { "aria-hidden": "true" }, html: SEARCH_SVG }),
      el("span", { class: "msearch-text" }),
    ],
  );
  const layout = el("div", { class: "layout" }, [
    el("div", { class: "main-col" }, [msearchBar, props.form, resultsDrawer]),
    el("div", { class: "side-col" }, [mapSection]),
  ]);

  teardownDrawer = setupDrawer(resultsDrawer, drawerHandle, msearchBar);

  results.addEventListener("click", (ev) => {
    const card = (ev.target as HTMLElement).closest<HTMLElement>("[data-station]");
    if (card?.dataset.station) props.onSelect(card.dataset.station);
  });
  let peekedStation: string | null = null;
  results.addEventListener("mouseover", (ev) => {
    const card = (ev.target as HTMLElement).closest<HTMLElement>("[data-station]");
    const id = card?.dataset.station ?? null;
    if (id !== peekedStation) {
      peekedStation = id;
      props.onPeek(id);
    }
  });
  results.addEventListener("mouseleave", () => {
    peekedStation = null;
    props.onPeek(null);
  });

  return { header, layout, cardSelect, title, results, mapEl, favList, tripList };
}
