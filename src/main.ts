import "@fontsource/hanken-grotesk/400.css";
import "@fontsource/hanken-grotesk/500.css";
import "@fontsource/hanken-grotesk/600.css";
import "@fontsource/hanken-grotesk/700.css";
import "@fontsource/space-grotesk/500.css";
import "@fontsource/space-grotesk/600.css";
import "@fontsource/space-grotesk/700.css";
import "@fontsource/space-mono/400.css";
import "@fontsource/space-mono/700.css";
import "./styles.css";
import { loadDataset } from "./data/dataset";
import { parseCard, profileForCard } from "./data/profile";
import { loadSettings } from "./state/store";
import { trainApiBase } from "./config";
import { StationRegistry } from "./data/stations";
import type { Station } from "./types";
import stationData from "../data/stations.json";
import { initApp } from "./app";
import { registerServiceWorker } from "./pwa/register";
import { initNative } from "./native/capacitor";
import { el } from "./ui/dom";
import { showPostcard } from "./ui/toast";
import { t, setLang, detectLang } from "./i18n";

/** Centered spinner + label shown while the dataset loads. */
function loadingStateEl(): HTMLElement {
  return el("div", { class: "app-loading", attrs: { role: "status" } }, [
    el("span", { class: "spinner", attrs: { "aria-hidden": "true" } }),
    el("p", { class: "app-loading-label", text: t("loading") }),
  ]);
}

/** Clean error card with a retry action: the data failed to load, or the page failed to open. */
function errorStateEl(message: string, retry: () => void): HTMLElement {
  return el("div", { class: "error-state", attrs: { role: "alert" } }, [
    el("span", {
      class: "error-icon",
      attrs: { "aria-hidden": "true" },
      html: `<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>`,
    }),
    el("p", { class: "error-title", text: message }),
    el("button", {
      class: "btn btn-primary",
      type: "button",
      text: t("act_retry"),
      on: { click: retry },
    }),
  ]);
}

(window as unknown as { __mfBoot?: boolean }).__mfBoot = true;

const root = document.getElementById("app");
if (root) {
  // The boot UI (loading/error) renders before initApp picks up the saved
  // language, so localize it from the browser here.
  setLang(detectLang());
  // The SEO build prerenders the home shell into #app. When present, keep that
  // static markup painted while the dataset loads (initApp rebuilds #app anyway)
  // instead of flashing it away to a spinner; only show the spinner when #app is
  // empty — a normal, non-prerendered build.
  const prerendered = root.querySelector(".mode-tabs") != null;
  if (!prerendered) {
    root.replaceChildren(loadingStateEl());
  }
  const registry = new StationRegistry(stationData as Station[]);
  // The pass picks the dataset: a link's card= wins, else the pass the user saved.
  const linkedCard = new URLSearchParams(location.search).get("card");
  const card = linkedCard ? parseCard(linkedCard) : loadSettings().card;
  loadDataset(profileForCard(card), trainApiBase()).then(
    (dataset) => {
      try {
        initApp(root, dataset, registry);
      } catch (err) {
        // The data loaded but this link or saved state broke the page: retry without the link.
        console.error(err);
        root.replaceChildren(errorStateEl(t("err_app"), () => location.assign(location.pathname)));
      }
    },
    (err: unknown) => {
      console.error(err);
      root.replaceChildren(errorStateEl(t("err_load"), () => location.reload()));
    },
  );
}

// When a new build is deployed, greet the user with a dismissible "reload to update"
// postcard rather than reloading under them.
registerServiceWorker(() => {
  showPostcard({
    title: t("update_title"),
    message: t("update_msg"),
    actionLabel: t("update_reload"),
    onAction: () => location.reload(),
  });
});
void initNative();
