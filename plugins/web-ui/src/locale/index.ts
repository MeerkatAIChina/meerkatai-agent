import { getTranslations, i18n as miniLitI18n, setTranslations, type i18nMessages } from "@mariozechner/mini-lit";
import { ZH_CN } from "./zh-cn.ts";

export function i18n(key: string): unknown {
  try {
    return miniLitI18n(key as keyof i18nMessages);
  } catch {
    return key;
  }
}

export function tr(key: string): (...args: unknown[]) => string {
  const v = i18n(key);
  return typeof v === "function" ? (v as (...args: unknown[]) => string) : () => String(v);
}

export function setupLocale(): void {
  try {
    localStorage.setItem("language", "zh");
  } catch (e) {
    console.debug("locale: language preference not persisted", e);
  }
  setTranslations({ ...getTranslations(), zh: ZH_CN as unknown as i18nMessages });
}
