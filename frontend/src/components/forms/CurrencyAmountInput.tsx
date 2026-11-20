"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React, { useEffect, useRef, useState } from "react";
import type { Locale } from "@/i18n/locales";
import { fractionDigitsOf, formatLocaleAmount, parseLocaleAmount } from "@/lib/localeAmount";

export interface CurrencyAmountInputProps {
  id: string;
  /** Parsed amount, or `null` while empty or unparseable. */
  value: number | null;
  /**
   * Called with the parsed value (or `null` when the text can't be parsed for
   * the active locale) and the raw text the user entered.
   */
  onChange: (value: number | null, raw: string) => void;
  /** Active locale driving both display formatting and parsing. */
  locale: Locale;
  /** Optional trailing unit rendered inside the field (e.g. "USDC"). */
  currencyLabel?: string;
  /** Wrapper class used when `currencyLabel` is set; defaults to `rm-amount-field`. */
  wrapperClassName?: string;
  className?: string;
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  /** Inclusive lower bound; a value below it is reported invalid on blur. */
  min?: number;
  /** Inclusive upper bound; a value above it is reported invalid on blur. */
  max?: number;
  autoFocus?: boolean;
  /** Render an inline error for input that can't be parsed/validated. */
  showInvalidError?: boolean;
  "aria-describedby"?: string;
  "data-testid"?: string;
}

/** Locale-aware currency amount field: formats on blur, parses on every change. */
export default function CurrencyAmountInput({
  id,
  value,
  onChange,
  locale,
  currencyLabel,
  wrapperClassName,
  className,
  placeholder,
  disabled,
  required,
  min,
  max,
  autoFocus,
  showInvalidError = false,
  "aria-describedby": ariaDescribedBy,
  "data-testid": dataTestId,
}: CurrencyAmountInputProps) {
  const [text, setText] = useState(() =>
    value === null ? "" : formatLocaleAmount(value, locale, 2)
  );
  const [focused, setFocused] = useState(false);
  // Tracks the last value/locale we rendered so an edit in progress isn't
  // clobbered by the parent echoing our own emit back, while a genuine
  // external change (e.g. a suggested amount) or locale switch still reformats.
  const lastRendered = useRef<{ value: number | null; locale: Locale }>({ value, locale });

  useEffect(() => {
    const previous = lastRendered.current;
    if (value !== previous.value || locale !== previous.locale) {
      lastRendered.current = { value, locale };
      setText(value === null ? "" : formatLocaleAmount(value, locale, 2));
    }
  }, [value, locale]);

  const parsed = parseLocaleAmount(text, locale);
  const unparseable = text.trim() !== "" && !parsed.ok;
  const outOfRange =
    parsed.ok &&
    ((min !== undefined && parsed.value < min) || (max !== undefined && parsed.value > max));
  const invalid = unparseable || outOfRange;
  const showError = showInvalidError && invalid && !focused;

  function handleChange(next: string) {
    setText(next);
    const result = parseLocaleAmount(next, locale);
    const nextValue = result.ok ? result.value : null;
    lastRendered.current = { value: nextValue, locale };
    onChange(nextValue, next);
  }

  function handleBlur() {
    setFocused(false);
    const result = parseLocaleAmount(text, locale);
    if (result.ok) {
      setText(formatLocaleAmount(result.value, locale, fractionDigitsOf(text, locale)));
    }
  }

  const errorId = `${id}-error`;
  const describedBy = showError
    ? [ariaDescribedBy, errorId].filter(Boolean).join(" ") || undefined
    : ariaDescribedBy;

  const input = (
    <input
      id={id}
      data-testid={dataTestId}
      type="text"
      inputMode="decimal"
      autoComplete="off"
      spellCheck={false}
      autoFocus={autoFocus}
      disabled={disabled}
      required={required}
      placeholder={placeholder}
      className={className}
      value={text}
      onChange={(event) => handleChange(event.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={handleBlur}
      aria-invalid={showError || undefined}
      aria-describedby={describedBy}
    />
  );

  return (
    <>
      {currencyLabel ? (
        <div className={wrapperClassName ?? "rm-amount-field"}>
          {input}
          <span>{currencyLabel}</span>
        </div>
      ) : (
        input
      )}
      {showError && (
        <p id={errorId} role="alert" className="text-sm text-red-400">
          {unparseable
            ? "Enter a valid number, for example 1,234.56."
            : "Enter an amount within the allowed range."}
        </p>
      )}
    </>
  );
}
