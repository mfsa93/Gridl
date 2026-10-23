import { en, type MessageKey } from "../locales/en";
import { es } from "../locales/es";

export type Locale = "en" | "es";
export type { MessageKey };
export type Params = Record<string, string | number>;

/** Keys that come in a `.one` / `.other` pair, used with {@link plural}. */
type PluralBase<K> = K extends `${infer Base}.one` ? (`${Base}.other` extends MessageKey ? Base : never) : never;
export type PluralKey = PluralBase<MessageKey>;

const catalogs: Record<Locale, Record<MessageKey, string>> = { en, es };

/** Spanish when the first preferred language is Spanish, English otherwise. */
export function detectLocale(languages: readonly (string | null | undefined)[]): Locale {
  const first = languages.find((language) => typeof language === "string" && language.trim() !== "");
  return first?.trim().toLowerCase().startsWith("es") ? "es" : "en";
}

function systemLanguages(): readonly string[] {
  if (typeof navigator === "undefined") return [];
  // WKWebView reports the macOS preferred languages here, in order.
  if (navigator.languages?.length) return navigator.languages;
  return navigator.language ? [navigator.language] : [];
}

/** The interface language, chosen once at startup from the system. */
export const locale: Locale = detectLocale(systemLanguages());

/** Message `key` in `target`, with `{name}` placeholders filled from `params`. */
export function translate(target: Locale, key: MessageKey, params?: Params): string {
  const template = catalogs[target][key] ?? catalogs.en[key] ?? key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match));
}

/** Message `key` in the interface language. */
export function t(key: MessageKey, params?: Params): string {
  return translate(locale, key, params);
}

/** Picks `key.one` or `key.other` for `count`; `{count}` is the formatted number. */
export function pluralIn(target: Locale, key: PluralKey, count: number, params?: Params): string {
  const form = new Intl.PluralRules(target).select(count) === "one" ? "one" : "other";
  return translate(target, `${key}.${form}` as MessageKey, { ...params, count: count.toLocaleString(target) });
}

/** Like {@link pluralIn} in the interface language: `plural("common.rows", 3)` → "3 rows". */
export function plural(key: PluralKey, count: number, params?: Params): string {
  return pluralIn(locale, key, count, params);
}

/** A number with the interface language's grouping, e.g. 12,345 or 12.345. */
export function formatNumber(value: number): string {
  return value.toLocaleString(locale);
}

export function formatDate(value: Date | number | string): string {
  return new Date(value).toLocaleDateString(locale);
}

export function formatTime(value: Date | number | string): string {
  return new Date(value).toLocaleTimeString(locale);
}

export function formatDateTime(value: Date | number | string): string {
  return new Date(value).toLocaleString(locale);
}
