"use client";

import React, { useEffect, useId, useRef, useState } from "react";
import { useFocusTrap } from "@/hooks/useFocusTrap";

interface ConfirmationDialogProps {
  isOpen: boolean;
  title: string;
  description: React.ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  confirmationText?: string;
  destructive?: boolean;
  children?: React.ReactNode;
  closeOnConfirm?: boolean;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}

export function ConfirmationDialog({
  isOpen,
  title,
  description,
  confirmLabel,
  cancelLabel = "Cancel",
  confirmationText,
  destructive = true,
  children,
  closeOnConfirm = true,
  onConfirm,
  onCancel,
}: ConfirmationDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const confirmationInputRef = useRef<HTMLInputElement>(null);
  const submittingRef = useRef(false);
  const [confirmationValue, setConfirmationValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();

  function handleCancel() {
    if (submittingRef.current) return;
    setConfirmationValue("");
    setError(null);
    onCancel();
  }

  const initialFocusRef = confirmationText ? confirmationInputRef : cancelButtonRef;
  useFocusTrap(dialogRef, isOpen, {
    onEscape: handleCancel,
    initialFocusRef,
  });

  useEffect(() => {
    if (!isOpen) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isOpen]);

  const confirmationMatches =
    confirmationText === undefined || confirmationValue === confirmationText;

  async function handleConfirm() {
    if (submittingRef.current || !confirmationMatches) return;

    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    try {
      await onConfirm();
      if (closeOnConfirm) {
        setConfirmationValue("");
        setError(null);
        onCancel();
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The action could not be completed.");
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 px-4 py-6"
      data-testid="confirmation-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !submitting) handleCancel();
      }}
    >
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-description`}
        tabIndex={-1}
        className="w-full max-w-lg rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)] p-6 shadow-2xl"
      >
        <h2 id={`${id}-title`} className="text-lg font-bold text-[var(--text-primary)]">
          {title}
        </h2>
        <div id={`${id}-description`} className="mt-2 text-sm text-[var(--text-secondary)]">
          {description}
        </div>

        {children}

        {confirmationText !== undefined && (
          <div className="mt-5">
            <label
              htmlFor={`${id}-confirmation`}
              className="mb-1.5 block text-sm font-medium text-[var(--text-primary)]"
            >
              Type <span className="font-mono font-bold">{confirmationText}</span> to continue
            </label>
            <input
              ref={confirmationInputRef}
              id={`${id}-confirmation`}
              value={confirmationValue}
              onChange={(event) => setConfirmationValue(event.target.value)}
              autoComplete="off"
              className="w-full rounded-lg border border-[var(--border-color)] bg-[var(--bg-primary)] px-3 py-2 text-[var(--text-primary)] outline-none focus:border-[var(--accent-primary)]"
            />
          </div>
        )}

        {error && (
          <p role="alert" aria-live="assertive" className="mt-4 text-sm text-red-400">
            {error}
          </p>
        )}

        <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <button
            ref={cancelButtonRef}
            type="button"
            onClick={handleCancel}
            disabled={submitting}
            className="rounded-lg border border-[var(--border-color)] px-4 py-2.5 text-sm font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-card)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={() => void handleConfirm()}
            disabled={!confirmationMatches || submitting}
            aria-busy={submitting}
            className={`rounded-lg px-4 py-2.5 text-sm font-semibold text-white transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
              destructive
                ? "bg-red-600 hover:bg-red-500"
                : "bg-[var(--accent-primary)] hover:opacity-90"
            }`}
          >
            <span aria-live="polite" aria-atomic="true">
              {submitting ? "Processing…" : confirmLabel}
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}

export default ConfirmationDialog;
