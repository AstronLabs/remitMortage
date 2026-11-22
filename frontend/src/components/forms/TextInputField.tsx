"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React from "react";

export interface TextInputFieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  type?: "text" | "email" | "tel" | "url";
  placeholder?: string;
  helperText?: string;
  error?: string | null;
  disabled?: boolean;
  required?: boolean;
  className?: string;
  "data-testid"?: string;
}

/**
 * Accessible text input field with label, helper text, error alert, and
 * keyboard/disabled state support (#1001).
 */
export default function TextInputField({
  id,
  label,
  value,
  onChange,
  onBlur,
  type = "text",
  placeholder,
  helperText,
  error,
  disabled = false,
  required = false,
  className,
  "data-testid": dataTestId,
}: TextInputFieldProps) {
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
      <input
        id={id}
        data-testid={dataTestId}
        type={type}
        value={value}
        placeholder={placeholder}
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
      />
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
