import type { Journey } from "../types";
import type { Tour } from "../core/tour";
import type { RenderCtx } from "./render";
import { el } from "./dom";
import * as render from "./render";
import { t } from "../i18n";
import { APP_VERSION, APP_BUILD } from "../config";

/* ── internal helpers ── */

/**
 * Wire the shared dialog lifecycle: remove from the DOM once closed, close on a
 * backdrop click, then mount and open it.
 * @param dialog the dialog element to mount and open.
 */
function mountModal(dialog: HTMLDialogElement): void {
  dialog.addEventListener("close", () => dialog.remove());
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) dialog.close();
  });
  document.body.append(dialog);
  dialog.showModal();
}

/**
 * A standard "Close" button bound to the dialog.
 * @param dialog the dialog the button closes.
 * @param variant the button style variant.
 * @returns the close button element.
 */
function closeButton(dialog: HTMLDialogElement, variant: "primary" | "ghost"): HTMLElement {
  return el("button", {
    class: `btn btn-${variant} modal-close`,
    type: "button",
    text: t("act_close"),
    on: { click: () => dialog.close() },
  });
}

let settingSeq = 0;

/**
 * A labelled toggle switch (role="switch") for the settings modal — same control as
 * the form's booleans, state read from the knob position + ✓/✕, not colour alone.
 */
function settingSwitch(label: string, hint: string, on: boolean, onChange: (v: boolean) => void): HTMLElement {
  let state = on;
  const id = `set-${(settingSeq += 1)}`;
  const knob = el("span", { class: "switch-knob", attrs: { "aria-hidden": "true" } });
  const toggle = el(
    "button",
    {
      class: `switch${state ? " is-on" : ""}`,
      type: "button",
      attrs: { role: "switch", "aria-checked": String(state), "aria-labelledby": `${id}-l`, ...(hint ? { "aria-describedby": `${id}-h` } : {}) },
    },
    [el("span", { class: "switch-track", attrs: { "aria-hidden": "true" } }, [knob])],
  );
  const sync = (): void => {
    toggle.classList.toggle("is-on", state);
    toggle.setAttribute("aria-checked", String(state));
  };
  toggle.addEventListener("click", () => {
    state = !state;
    sync();
    onChange(state);
  });
  return el("div", { class: "set-row" }, [
    el("div", { class: "set-row-text" }, [
      el("span", { class: "set-row-label", text: label, attrs: { id: `${id}-l` } }),
      ...(hint ? [el("span", { class: "set-row-hint muted small", text: hint, attrs: { id: `${id}-h` } })] : []),
    ]),
    toggle,
  ]);
}

/**
 * Settings dialog: performance / display options for low-end devices. Each toggle
 * applies immediately (and is persisted by the caller). "Low-end device" is a preset
 * that flips the three savers at once.
 */
export function showSettingsModal(opts: {
  reduceMotion: boolean;
  map: boolean;
  compact: boolean;
  onReduceMotion: (v: boolean) => void;
  onMap: (v: boolean) => void;
  onCompact: (v: boolean) => void;
  /** Master "Low-end mode": ON = all three savers on, OFF = all three off. */
  onLowEnd: (v: boolean) => void;
}): void {
  const dialog = el("dialog", { class: "modal settings-modal" }) as HTMLDialogElement;
  // Low-end mode is ON exactly when all three savers are active — a master switch, not
  // a one-shot preset: toggling it OFF restores motion, the map and comfortable density.
  const lowEnd = opts.reduceMotion && !opts.map && opts.compact;
  const rebuild = (next: Partial<typeof opts>): void => {
    dialog.close();
    showSettingsModal({ ...opts, ...next });
  };
  const master = settingSwitch(t("set_lowend"), t("set_lowend_hint"), lowEnd, (v) => {
    opts.onLowEnd(v);
    // Reflect the flipped sub-switches by re-rendering with the new state.
    rebuild({ reduceMotion: v, map: !v, compact: v });
  });
  // Each individual saver applies its own change, then re-renders so the master switch
  // above reflects whether all three are now on.
  const body = el("div", { class: "set-rows" }, [
    settingSwitch(t("set_reduce_motion"), t("set_reduce_motion_hint"), opts.reduceMotion, (v) => {
      opts.onReduceMotion(v);
      rebuild({ reduceMotion: v });
    }),
    settingSwitch(t("set_show_map"), t("set_show_map_hint"), opts.map, (v) => {
      opts.onMap(v);
      rebuild({ map: v });
    }),
    settingSwitch(t("set_compact"), t("set_compact_hint"), opts.compact, (v) => {
      opts.onCompact(v);
      rebuild({ compact: v });
    }),
  ]);
  dialog.append(
    el("div", { class: "modal-body" }, [
      el("h2", { class: "modal-title", text: t("settings_title") }),
      el("p", { class: "modal-text muted small", text: t("set_perf") }),
      el("div", { class: "set-rows set-master" }, [master]),
      body,
      el("p", {
        class: "muted small set-version",
        text: `MAX Finder v${APP_VERSION}${APP_BUILD ? ` · ${APP_BUILD}` : ""}`,
      }),
      el("div", { class: "modal-actions" }, [closeButton(dialog, "primary")]),
    ]),
  );
  mountModal(dialog);
}

/* ── public modals ── */

/**
 * A simple accessible dialog: a title and one or more message lines.
 * @param title the dialog heading.
 * @param lines the message paragraphs, in order.
 */
export function showInfoModal(title: string, lines: string[]): void {
  const dialog = el("dialog", { class: "modal" }) as HTMLDialogElement;
  dialog.append(
    el("div", { class: "modal-body" }, [
      el("h2", { class: "modal-title", text: title }),
      ...lines.map((line) => el("p", { class: "modal-text", text: line })),
      el("div", { class: "modal-actions" }, [closeButton(dialog, "primary")]),
    ]),
  );
  mountModal(dialog);
}

/**
 * Step-by-step booking dialog for a connecting journey: one deep link per train,
 * in order.
 * @param journey the connecting journey to lay out as bookable legs.
 * @param ctx render context supplying station labels and booking URLs.
 */
export function showBookingModal(journey: Journey, ctx: RenderCtx): void {
  const dialog = el("dialog", { class: "modal" }) as HTMLDialogElement;
  const steps = el("ol", { class: "book-steps" });
  journey.legs.forEach((leg, i) => {
    steps.append(
      el("li", { class: "book-step" }, [
        el("div", { class: "book-step-info" }, [
          el("div", { class: "book-step-route" }, [
            el("strong", { text: ctx.label(leg.origin) }),
            el("span", { class: "muted", text: " → " }),
            el("strong", { text: ctx.label(leg.destination) }),
          ]),
          el("div", {
            class: "book-step-meta muted small",
            text: `${leg.depart} → ${leg.arrive} · ${t("lbl_train", { no: leg.trainNo })}`,
          }),
        ]),
        el("a", {
          class: "btn btn-primary book-step-btn",
          href: ctx.bookUrl(leg.origin, leg.destination, leg.date, leg.depart),
          attrs: { target: "_blank", rel: "noopener noreferrer" },
          text: t("act_book_leg", { n: i + 1 }),
        }),
      ]),
    );
  });
  dialog.append(
    el("div", { class: "modal-body" }, [
      el("h2", { class: "modal-title", text: t("book_steps_title") }),
      el("p", { class: "modal-text", text: t("book_steps_note") }),
      steps,
      el("div", { class: "modal-actions" }, [closeButton(dialog, "ghost")]),
    ]),
  );
  mountModal(dialog);
}

/**
 * The whole trip on one page: a single journey or a round trip, with both legs
 * bookable, a share action, and a shortcut to the route's full calendar. Map
 * actions are neutralised — there's no map behind the dialog to draw on.
 * @param outbound the outbound journey.
 * @param ctx render context for the trip card.
 * @param opts optional inbound leg and a share handler.
 */
export function showTripModal(
  outbound: Journey,
  ctx: RenderCtx,
  opts: { inbound?: Journey; onShare?: (onCopied: () => void) => void } = {},
): void {
  const { inbound, onShare } = opts;
  const dialog = el("dialog", { class: "modal trip-modal" }) as HTMLDialogElement;
  const moreDates = el("button", {
    class: "linklike trip-more",
    type: "button",
    text: t("trip_more_dates"),
    on: {
      click: () => {
        dialog.close();
        ctx.onOpenRoute(outbound.origin, outbound.destination);
      },
    },
  });
  const actions: HTMLElement[] = [];
  if (onShare) {
    const shareTripBtn = el("button", {
      class: "btn btn-ghost share-feedback",
      type: "button",
      text: t("act_share"),
      on: {
        click: () =>
          onShare(() => {
            shareTripBtn.textContent = t("share_copied");
            setTimeout(() => {
              shareTripBtn.textContent = t("act_share");
            }, 1600);
          }),
      },
    });
    actions.push(shareTripBtn);
  }
  actions.push(moreDates, closeButton(dialog, "ghost"));
  const modalCtx: RenderCtx = { ...ctx, onShowJourney: () => {} };
  dialog.append(
    el("div", { class: "modal-body" }, [
      render.tripViewEl(outbound, modalCtx, inbound),
      el("div", { class: "modal-actions" }, actions),
    ]),
  );
  mountModal(dialog);
}

/**
 * A multi-leg selection on one page, each leg bookable. Map actions are no-ops.
 * @param legs the chosen legs, in order.
 * @param ctx render context for the leg cards.
 */
export function showMultiTripModal(legs: render.RecapLeg[], ctx: RenderCtx): void {
  const modalCtx: RenderCtx = { ...ctx, onShowJourney: () => {} };
  const dialog = el("dialog", { class: "modal trip-modal" }) as HTMLDialogElement;
  dialog.append(
    el("div", { class: "modal-body" }, [
      render.multiTripViewEl(legs, modalCtx),
      el("div", { class: "modal-actions" }, [closeButton(dialog, "ghost")]),
    ]),
  );
  mountModal(dialog);
}

/**
 * A saved multi-city tour on one page: the full itinerary with every bookable
 * leg. Map actions are no-ops.
 * @param tour the tour to lay out.
 * @param ctx render context for the tour card.
 */
export function showTourModal(tour: Tour, ctx: RenderCtx): void {
  const modalCtx: RenderCtx = { ...ctx, onShowTour: () => {}, onShowJourney: () => {} };
  const dialog = el("dialog", { class: "modal trip-modal" }) as HTMLDialogElement;
  dialog.append(
    el("div", { class: "modal-body" }, [
      render.tourEl(tour, modalCtx),
      el("div", { class: "modal-actions" }, [closeButton(dialog, "ghost")]),
    ]),
  );
  mountModal(dialog);
}
