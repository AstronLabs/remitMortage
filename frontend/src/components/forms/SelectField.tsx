"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React from "react";

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectFieldProps {
  id: string;
  label: string;
  value: string;
  options: readonly SelectOption[];
  onChange: (value: string) => void;
  onBlur?: () => void;
  placeholder?: string;
  helperText?: string;
  error?: string | null;
  disabled?: boolean;
  required?: boolean;
  className?: string;
  "data-testid"?: string;
}

/**
 * Accessible select dropdown field with placeholder, helper text, error alert,
 * and keyboard/disabled state support (#1001).
 */
export default function SelectField({
  id,
  label,
  value,
  options,
  onChange,
  onBlur,
  placeholder,
  helperText,
  error,
  disabled = false,
  required = false,
  className,
  "data-testid": dataTestId,
}: SelectFieldProps) {
  const helperId = helperText ? `${id}-helper` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [helperId, errorId].filter(Boolean).join(" ") || undefined;

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-slate-200">
        {label}
        {required && (
          <span aria-hidden="true" className="ml-1 text-red-400">
            *
          </span>
        )}
      </label>
      <select
        id={id}
        data-testid={dataTestId}
        value={value}
        disabled={disabled}
        required={required}
        aria-invalid={Boolean(error) || undefined}
        aria-describedby={describedBy}
        onChange={(e) => {
          if (!disabled) onChange(e.target.value);
        }}
        onBlur={onBlur}
        className={
          className ??
          "rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white disabled:cursor-not-allowed disabled:opacity-50"
        }
      >
        {placeholder && (
          <option value="" disabled={required}>
            {placeholder}
          </option>
        )}
        {options.map((opt) => (
          <option key={opt.value} value={opt.value} disabled={opt.disabled}>
            {opt.label}
          </option>
        ))}
      </select>
      {helperText && (
        <p id={helperId} className="text-xs text-slate-400">
          {helperText}
        </p>
      )}
      {error && (
        <p id={errorId} role="alert" className="text-sm text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
