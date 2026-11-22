"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React, { useRef, useState } from "react";

export interface FileUploadFieldProps {
  id: string;
  label: string;
  onFileSelect: (file: File | null) => void;
  /** Comma-separated accepted MIME types or extensions (e.g. "application/pdf,image/png"). */
  accept?: string;
  /** Maximum file size in bytes (e.g. 5 * 1024 * 1024). */
  maxSizeBytes?: number;
  selectedFileName?: string | null;
  helperText?: string;
  error?: string | null;
  disabled?: boolean;
  required?: boolean;
  "data-testid"?: string;
}

function matchesAcceptedType(file: File, accept?: string): boolean {
  if (!accept) return true;
  const tokens = accept
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  if (tokens.length === 0) return true;

  const fileMime = (file.type || "").toLowerCase();
  const fileName = (file.name || "").toLowerCase();

  return tokens.some((token) => {
    if (token.startsWith(".")) {
      return fileName.endsWith(token);
    }
    if (token.endsWith("/*")) {
      const prefix = token.slice(0, -1);
      return fileMime.startsWith(prefix);
    }
    return fileMime === token;
  });
}

/**
 * Accessible file upload field with MIME/size validation, keyboard-accessible
 * trigger button, error alert state, and disabled state support (#1001).
 */
export default function FileUploadField({
  id,
  label,
  onFileSelect,
  accept,
  maxSizeBytes,
  selectedFileName,
  helperText,
  error: externalError,
  disabled = false,
  required = false,
  "data-testid": dataTestId,
}: FileUploadFieldProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [internalFileName, setInternalFileName] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);

  const displayedFileName =
    selectedFileName !== undefined ? selectedFileName : internalFileName;
  const activeError = externalError ?? validationError;
  const helperId = helperText ? `${id}-helper` : undefined;
  const errorId = activeError ? `${id}-error` : undefined;
  const describedBy = [helperId, errorId].filter(Boolean).join(" ") || undefined;

  function handleFiles(files: FileList | null) {
    if (disabled) return;
    const file = files?.[0] ?? null;
    if (!file) {
      setValidationError(null);
      setInternalFileName(null);
      onFileSelect(null);
      return;
    }

    if (!matchesAcceptedType(file, accept)) {
      setValidationError(`Unsupported file type. Allowed: ${accept}.`);
      setInternalFileName(null);
      onFileSelect(null);
      return;
    }

    if (maxSizeBytes !== undefined && file.size > maxSizeBytes) {
      const maxMb = (maxSizeBytes / (1024 * 1024)).toFixed(1);
      setValidationError(`File exceeds the maximum size of ${maxMb} MB.`);
      setInternalFileName(null);
      onFileSelect(null);
      return;
    }

    setValidationError(null);
    setInternalFileName(file.name);
    onFileSelect(file);
  }

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

      <div className="flex items-center gap-3">
        <input
          ref={inputRef}
          id={id}
          data-testid={dataTestId}
          type="file"
          accept={accept}
          disabled={disabled}
          required={required}
          aria-invalid={Boolean(activeError) || undefined}
          aria-describedby={describedBy}
          onChange={(e) => handleFiles(e.target.files)}
          className="sr-only"
        />
        <button
          type="button"
          disabled={disabled}
          aria-controls={id}
          aria-describedby={describedBy}
          onClick={() => {
            if (!disabled) inputRef.current?.click();
          }}
          className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Choose file
        </button>
        <span className="text-xs text-slate-300" data-testid={`${id}-filename`}>
          {displayedFileName ?? "No file chosen"}
        </span>
      </div>

      {helperText && (
        <p id={helperId} className="text-xs text-slate-400">
          {helperText}
        </p>
      )}
      {activeError && (
        <p id={errorId} role="alert" className="text-sm text-red-400">
          {activeError}
        </p>
      )}
    </div>
  );
}
