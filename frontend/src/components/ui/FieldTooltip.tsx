"use client";

import React, { useState, useRef, useEffect, useCallback } from "react";
import { Info } from "lucide-react";

interface FieldTooltipProps {
  /** The tooltip content text. */
  content: string;
  /** Optional additional CSS classes for the trigger element. */
  className?: string;
}

/**
 * Accessible inline field-level tooltip triggered by an info icon.
 *
 * Features:
 * - Keyboard accessible (Tab + Escape to close)
 * - Screen-reader announced via aria-describedby
 * - Mouse hover and focus trigger
 * - Closes on outside click or Escape key
 */
export default function FieldTooltip({ content, className }: FieldTooltipProps) {
  const [visible, setVisible] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const tooltipId = useRef(`tooltip-${Math.random().toString(36).slice(2, 9)}`);

  const show = useCallback(() => setVisible(true), []);
  const hide = useCallback(() => setVisible(false), []);

  useEffect(() => {
    if (!visible) return;

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        hide();
        triggerRef.current?.focus();
      }
    }

    function handleClickOutside(e: MouseEvent) {
      if (
        triggerRef.current &&
        !triggerRef.current.contains(e.target as Node)
      ) {
        hide();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [visible, hide]);

  return (
    <span className={`relative inline-flex items-center ${className ?? ""}`}>
      <button
        ref={triggerRef}
        type="button"
        className="inline-flex items-center justify-center rounded-full p-0.5 text-[var(--text-muted)] hover:text-[var(--text-primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 transition-colors"
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        onClick={() => setVisible((v) => !v)}
        aria-describedby={visible ? tooltipId.current : undefined}
        aria-label={`Help: ${content.slice(0, 40)}...`}
      >
        <Info className="h-4 w-4" />
      </button>

      {visible && (
        <span
          id={tooltipId.current}
          role="tooltip"
          className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 z-50 w-64 p-3 text-xs leading-relaxed text-[var(--text-primary)] bg-[var(--bg-card)] border border-[var(--border-color)] rounded-lg shadow-lg pointer-events-none animate-in fade-in"
        >
          {content}
          <span className="absolute top-full left-1/2 -translate-x-1/2 -mt-px border-4 border-transparent border-t-[var(--border-color)]" />
        </span>
      )}
    </span>
  );
}
