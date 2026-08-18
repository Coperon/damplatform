"use client";

import { useEffect, useState } from "react";
import { COUNTRIES, DEFAULT_COUNTRY_CODE, findCountry } from "@/lib/countries";
import Select from "@/components/Select";
import { useTranslation } from "@/lib/i18n";

export interface PhoneParts {
  countryCode: string;
  dial: string;
  number: string;
}

interface PhoneInputProps {
  id: string;
  required?: boolean;
  disabled?: boolean;
  defaultCountryCode?: string;
  onChange: (composed: string, parts: PhoneParts) => void;
}

// Allows digits, spaces, and dashes as the user types (readability — "70 123
// 456" or "70-123-456" both read fine); anything else (letters, symbols) is
// dropped on every keystroke rather than merely rejected on submit.
function sanitizeNumberInput(raw: string): string {
  return raw.replace(/[^\d\s-]/g, "");
}

// The composed/stored/emitted value is digits-only after the dial code —
// spaces and dashes are for on-screen readability only, stripped here so
// "70 123-456" and "70123456" produce the identical stored string.
function compose(dial: string, numberRaw: string): string {
  const digits = numberRaw.replace(/[^\d]/g, "");
  return digits ? `${dial} ${digits}` : "";
}

// One reusable control for both phone fields on the invite redemption page
// (the person's own phone and, for a first-admin invite, the tenant's) —
// a country <select> (flag + name + dial code) beside a plain number input.
// Self-contained state; the parent only ever receives the already-composed
// "+<dial> <number>" string via onChange, never has to reassemble it.
export default function PhoneInput({
  id,
  required,
  disabled,
  defaultCountryCode = DEFAULT_COUNTRY_CODE,
  onChange,
}: PhoneInputProps) {
  const { t } = useTranslation();
  const [countryCode, setCountryCode] = useState(defaultCountryCode);
  const [numberRaw, setNumberRaw] = useState("");

  const country = findCountry(countryCode) ?? COUNTRIES[0];

  useEffect(() => {
    onChange(compose(country.dial, numberRaw), {
      countryCode,
      dial: country.dial,
      number: numberRaw.replace(/[^\d]/g, ""),
    });
    // Deliberately keyed on the two pieces of state only — onChange is a
    // fresh closure every parent render, and depending on it would refire
    // this on every keystroke of unrelated fields, not just this one's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [countryCode, numberRaw]);

  return (
    <div className="flex gap-2">
      {/* Stage 112: swapped from a native <select> to the shared Select
          component — the option-text-in-OS-font issue this stage fixes
          applies just as much to a 230-entry country list as anywhere else;
          the flag+dial-code labels are plain strings, no portal-vs-native
          distinction left to justify keeping this one native. Typeahead
          (built into Select) is what makes a flat 230-entry list still fast
          to navigate by keyboard. */}
      <Select
        id={`${id}-country`}
        ariaLabel={t("common.countryCode")}
        value={countryCode}
        disabled={disabled}
        onChange={setCountryCode}
        options={COUNTRIES.map((c) => ({ value: c.code, label: `${c.flag} ${c.dial}` }))}
        className="flex h-[46px] w-[132px] shrink-0 cursor-pointer items-center justify-between gap-1 rounded-[10px] border border-line bg-card dark:bg-card px-2.5 text-[14px] text-ink outline-none transition-shadow focus:border-brand focus:ring-[3px] focus:ring-brand/15 disabled:cursor-not-allowed disabled:opacity-60"
      />

      <input
        id={id}
        type="tel"
        inputMode="numeric"
        required={required}
        disabled={disabled}
        maxLength={20}
        value={numberRaw}
        onChange={(e) => setNumberRaw(sanitizeNumberInput(e.target.value))}
        placeholder="70 123 456"
        className="h-[46px] w-full min-w-0 flex-1 rounded-[10px] border border-line bg-card px-3.5 text-[15px] text-ink outline-none transition-shadow focus:border-brand focus:ring-[3px] focus:ring-brand/15 disabled:cursor-not-allowed disabled:opacity-60"
      />
    </div>
  );
}
