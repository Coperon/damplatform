"use client";

import { createContext, useContext, useEffect, useMemo, useState, Fragment, type ReactNode } from "react";
import en from "@/locales/en.json";
import it from "@/locales/it.json";

export type Dictionary = Record<string, string>;

// Adding a language: create locales/<code>.json with the same flat key set
// as locales/en.json, then add one entry here. Nothing else in the app
// needs to change — useTranslation() and the account-menu language
// selector both read this list, and the pre-paint script in app/layout.tsx
// doesn't hardcode locale codes at all (it just mirrors whatever's in
// localStorage onto <html>).
export const LOCALES = [
  { code: "en", name: "English", dict: en as Dictionary },
  { code: "it", name: "Italiano", dict: it as Dictionary },
] as const;

export type Locale = (typeof LOCALES)[number]["code"];

export const LOCALE_KEY = "dam:locale";
const DEFAULT_LOCALE: Locale = "en";
const DEFAULT_DICT = en as Dictionary;

function isLocale(value: string | null | undefined): value is Locale {
  return LOCALES.some((l) => l.code === value);
}

type TranslateParams = Record<string, string | number>;

function interpolate(template: string, params?: TranslateParams): string {
  if (!params) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (match, name) =>
    name in params ? String(params[name]) : match,
  );
}

interface TranslationContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: string, params?: TranslateParams) => string;
}

const TranslationContext = createContext<TranslationContextValue | null>(null);

export function TranslationProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(DEFAULT_LOCALE);

  // The blocking <head> script in app/layout.tsx already applied the stored
  // locale to <html> (lang + data-locale) before first paint — read it back
  // from the DOM (the source of truth), mirroring AppShell's own dark-mode
  // sync, so the two can never disagree. Every consumer of t() lives behind
  // a page's own "render nothing until authorized" gate (see AppShell and
  // app/admin/media/page.tsx), so this effect always settles — together
  // with the auth effect, in the same pre-paint batch — before any
  // translated text is actually visible; there's no separate flash to fix
  // here the way the dark-mode background needed its own blocking script.
  useEffect(() => {
    const domLocale = document.documentElement.dataset.locale;
    if (isLocale(domLocale)) setLocaleState(domLocale);
  }, []);

  function setLocale(next: Locale) {
    setLocaleState(next);
    document.documentElement.lang = next;
    document.documentElement.dataset.locale = next;
    try {
      localStorage.setItem(LOCALE_KEY, next);
    } catch {
      // ignore persistence failures (e.g. private browsing)
    }
  }

  const t = useMemo(() => {
    const dict = LOCALES.find((l) => l.code === locale)?.dict ?? DEFAULT_DICT;

    return (key: string, params?: TranslateParams): string => {
      // Pluralization convention: a key used with a numeric `count` param
      // first looks for `${key}.one` (count === 1) or `${key}.other`
      // (everything else, including 0 — matches English/Italian, both
      // two-form CLDR plural systems) before falling back to the bare key.
      let lookupKey = key;
      if (params && typeof params.count === "number") {
        const variant = `${key}.${params.count === 1 ? "one" : "other"}`;
        if (dict[variant] !== undefined || DEFAULT_DICT[variant] !== undefined) {
          lookupKey = variant;
        }
      }

      // A key missing only from the active (non-English) locale falls back
      // to English rather than showing a raw key — useful once Stage B adds
      // languages/keys incrementally. A key missing everywhere (typo, or
      // simply never added to any dictionary) renders the key itself and
      // warns in dev, per the "never blank" requirement.
      const template = dict[lookupKey] ?? DEFAULT_DICT[lookupKey];
      if (template === undefined) {
        if (process.env.NODE_ENV !== "production") {
          console.warn(`[i18n] Missing translation key: "${lookupKey}"`);
        }
        return key;
      }
      return interpolate(template, params);
    };
  }, [locale]);

  return (
    <TranslationContext.Provider value={{ locale, setLocale, t }}>
      {children}
    </TranslationContext.Provider>
  );
}

export function useTranslation() {
  const ctx = useContext(TranslationContext);
  if (!ctx) {
    throw new Error("useTranslation must be used within a TranslationProvider");
  }
  return ctx;
}

// Substitutes {{param}} placeholders in an already-localized template with
// real JSX (e.g. a bolded name/value) at whatever position the translation
// puts them — never built by concatenating separately-translated fragments.
// First introduced locally in app/admin/activity/page.tsx (Stage 117);
// promoted here so any page needing the same pattern (e.g. a sentence naming
// a tenant + role) can share one implementation.
export function interpolateJSX(
  template: string,
  params: Record<string, ReactNode>,
): ReactNode[] {
  return template.split(/(\{\{\w+\}\})/g).map((part, i) => {
    const match = part.match(/^\{\{(\w+)\}\}$/);
    if (match && match[1] in params) {
      return <Fragment key={i}>{params[match[1]]}</Fragment>;
    }
    return part;
  });
}
