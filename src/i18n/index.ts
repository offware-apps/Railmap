import { fr, type Dict } from "./fr";
import { en } from "./en";
import { es } from "./es";
import { de } from "./de";
import { it } from "./it";
import { ko } from "./ko";
import { zh } from "./zh";
import { ja } from "./ja";
import { nl } from "./nl";
import { pt } from "./pt";
import { ar } from "./ar";

export type Lang = "fr" | "en" | "es" | "de" | "it" | "ko" | "zh" | "ja" | "nl" | "pt" | "ar";

const dicts: Record<Lang, Dict> = { fr, en, es, de, it, ko, zh, ja, nl, pt, ar };

/** Languages written right-to-left. */
const RTL_LANGS = new Set<Lang>(["ar"]);

/** Supported languages, in display order, with their autonym (native label). */
export const LANGS: ReadonlyArray<{ code: Lang; label: string }> = [
  { code: "fr", label: "Français" },
  { code: "en", label: "English" },
  { code: "es", label: "Español" },
  { code: "de", label: "Deutsch" },
  { code: "it", label: "Italiano" },
  { code: "pt", label: "Português" },
  { code: "nl", label: "Nederlands" },
  { code: "ko", label: "한국어" },
  { code: "ja", label: "日本語" },
  { code: "zh", label: "中文" },
  { code: "ar", label: "العربية" },
];

let current: Lang = "fr";
/** True when the loaded pass's data can't say whether a seat is left (Interrail). */
let seatUnknown = false;

export function isLang(x: unknown): x is Lang {
  return typeof x === "string" && LANGS.some((l) => l.code === x);
}

export function setLang(lang: Lang): void {
  current = lang;
  document.documentElement.lang = lang;
  document.documentElement.dir = RTL_LANGS.has(lang) ? "rtl" : "ltr";
}

export function getLang(): Lang {
  return current;
}

/** Best supported language for the browser, else French. */
export function detectLang(): Lang {
  const code = (navigator.language || "fr").toLowerCase().split("-")[0];
  return isLang(code) ? code : "fr";
}

/**
 * Switch copy to the "seat unknown" wording (Interrail). A key with an `<key>_ir`
 * variant then reads that variant, so no screen claims a free MAX seat it can't know.
 */
export function setSeatUnknown(on: boolean): void {
  seatUnknown = on;
}

/** Translate `key`, substituting `{name}` placeholders from `params`. */
export function t(key: keyof Dict, params?: Record<string, string | number>): string {
  const ir = `${key}_ir` as keyof Dict;
  if (seatUnknown && ir in fr) key = ir;
  let s: string = dicts[current][key] ?? fr[key] ?? String(key);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      s = s.split(`{${k}}`).join(String(v)); // literal replace — no RegExp escaping needed
    }
  }
  return s;
}
