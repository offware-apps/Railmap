import { fr, type Dict, type Plural } from "./fr";
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
let plurals = new Intl.PluralRules(current);

export function isLang(x: unknown): x is Lang {
  return typeof x === "string" && LANGS.some((l) => l.code === x);
}

export function setLang(lang: Lang): void {
  current = lang;
  plurals = new Intl.PluralRules(lang);
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

/** Keys whose value is a plain string, and keys whose value is a set of plural forms. */
type TextKey = { [K in keyof Dict]: Dict[K] extends string ? K : never }[keyof Dict];
type PluralKey = { [K in keyof Dict]: Dict[K] extends Plural ? K : never }[keyof Dict];

/** Substitute `{name}` placeholders in `s` from `params`. */
function fill(s: string, params?: Record<string, string | number>): string {
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      s = s.split(`{${k}}`).join(String(v)); // literal replace — no RegExp escaping needed
    }
  }
  return s;
}

/** Translate `key`, substituting `{name}` placeholders from `params`. */
export function t(key: TextKey, params?: Record<string, string | number>): string {
  return fill(dicts[current][key] ?? fr[key] ?? String(key), params);
}

/** Translate a count: the plural form the current language uses for `n`, with `{n}` filled. */
export function tn(key: PluralKey, n: number, params?: Record<string, string | number>): string {
  const forms = dicts[current][key];
  return fill(forms[plurals.select(n)] ?? forms.other, { ...params, n });
}

/** Human duration in the current language's units, e.g. 135 -> "2 h 15", 14245 -> "9 j 21 h". */
export function formatDuration(min: number): string {
  const d = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  const m = min % 60;
  // Past a day, count days and drop minutes — "9 j 21 h" beats "237 h 25".
  if (d > 0) return h === 0 ? t("dur_d", { d }) : t("dur_dh", { d, h });
  if (h === 0) return t("dur_m", { m });
  return m === 0 ? t("dur_h", { h }) : t("dur_hm", { h, m: String(m).padStart(2, "0") });
}
