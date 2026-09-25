"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { useEffect, useRef, useState } from "react";

interface AutosaveOptions {
  key: string;
  debounceMs?: number;
  onSave?: (data: any) => void;
  onRestore?: (data: any) => void;
}

/**
 * Custom hook that automatically saves form state to localStorage
 * and restores it on mount. Provides "Resume Session" banner functionality.
 */
export function useFormAutosave<T extends Record<string, any>>(
  formData: T,
  options: AutosaveOptions
) {
  const { key, debounceMs = 500, onSave, onRestore } = options;
  const [hasDraft, setHasDraft] = useState(false);
  const [draftRestored, setDraftRestored] = useState(false);
  const timeoutRef = useRef<NodeJS.Timeout | undefined>(undefined);
  const initialLoadRef = useRef(false);

  // Check for existing draft on mount
  useEffect(() => {
    if (typeof window === "undefined" || initialLoadRef.current) return;
    initialLoadRef.current = true;

    try {
      const saved = localStorage.getItem(key);
      if (saved) {
        const parsedData = JSON.parse(saved);
        setHasDraft(true);
        onRestore?.(parsedData);
      }
    } catch (error) {
      console.error("Failed to restore autosaved data:", error);
    }
  }, [key, onRestore]);

  // Auto-save form data with debouncing
  useEffect(() => {
    if (typeof window === "undefined" || !initialLoadRef.current) return;

    // Clear previous timeout
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }

    // Debounce the save operation
    timeoutRef.current = setTimeout(() => {
      try {
        // Only save if form has meaningful data. Empty arrays/objects (e.g. a
        // cost-breakdown list with no rows yet) are treated as empty so an
        // untouched form never leaves a stale draft behind.
        const hasData = Object.values(formData).some((value) => {
          if (typeof value === "string") return value.trim().length > 0;
          if (typeof value === "number") return value > 0;
          if (Array.isArray(value)) return value.length > 0;
          if (value && typeof value === "object") {
            return Object.keys(value).length > 0;
          }
          return value != null;
        });

        if (hasData) {
          const dataToSave = {
            ...formData,
            _timestamp: Date.now(),
          };
          localStorage.setItem(key, JSON.stringify(dataToSave));
          onSave?.(dataToSave);
        }
      } catch (error) {
        console.error("Failed to autosave form data:", error);
      }
    }, debounceMs);

    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, [formData, key, debounceMs, onSave]);

  /**
   * Restores draft data from localStorage
   */
  const restoreDraft = (): T | null => {
    try {
      const saved = localStorage.getItem(key);
      if (saved) {
        const parsed = JSON.parse(saved);
        setDraftRestored(true);
        setHasDraft(false);
        return parsed;
      }
    } catch (error) {
      console.error("Failed to restore draft:", error);
    }
    return null;
  };

  /**
   * Clears autosaved data (call on successful form submission)
   */
  const clearDraft = () => {
    try {
      localStorage.removeItem(key);
      setHasDraft(false);
      setDraftRestored(false);
    } catch (error) {
      console.error("Failed to clear draft:", error);
    }
  };

  /**
   * Dismisses the draft without restoring it
   */
  const dismissDraft = () => {
    setHasDraft(false);
  };

  return {
    hasDraft: hasDraft && !draftRestored,
    draftRestored,
    restoreDraft,
    clearDraft,
    dismissDraft,
  };
}
