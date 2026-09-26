"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React, { createContext, useContext, useEffect, useState, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import KeyboardShortcutsModal from "@/components/KeyboardShortcutsModal";

export type ShortcutItem = {
  keys: string[];
  description: string;
  category: "Navigation" | "Actions" | "General";
};

export const SHORTCUT_LIST: ShortcutItem[] = [
  { keys: ["g", "d"], description: "Go to Dashboard", category: "Navigation" },
  { keys: ["g", "a"], description: "Go to Admin Panel", category: "Navigation" },
  { keys: ["g", "i"], description: "Go to Investment Vaults", category: "Navigation" },
  { keys: ["g", "g"], description: "Go to Governance", category: "Navigation" },
  { keys: ["g", "h"], description: "Go to Repayment History", category: "Navigation" },
  { keys: ["g", "s"], description: "Go to Settings", category: "Navigation" },
  { keys: ["g", "c"], description: "Go to Contractor Workspace", category: "Navigation" },
  { keys: ["g", "l"], description: "Go to Loan Applications", category: "Navigation" },
  { keys: ["c"], description: "Open Comparison / Application Tool", category: "Actions" },
  { keys: ["n"], description: "Open Notifications", category: "Actions" },
  { keys: ["?"], description: "Show Keyboard Shortcuts Cheat-Sheet", category: "General" },
  { keys: ["Esc"], description: "Close Modal / Dismiss Overlay", category: "General" },
];

type KeyboardShortcutsContextType = {
  isCheatSheetOpen: boolean;
  openCheatSheet: () => void;
  closeCheatSheet: () => void;
  toggleCheatSheet: () => void;
  isPrefixActive: boolean;
};

const KeyboardShortcutsContext = createContext<KeyboardShortcutsContextType | undefined>(undefined);

const isInputElement = (el: Element | null): boolean => {
  if (!el) return false;
  const tagName = el.tagName.toLowerCase();
  if (
    tagName === "input" ||
    tagName === "textarea" ||
    tagName === "select" ||
    el.getAttribute("contenteditable") === "true" ||
    el.getAttribute("role") === "textbox"
  ) {
    return true;
  }
  return false;
};

export function KeyboardShortcutsProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [isCheatSheetOpen, setIsCheatSheetOpen] = useState(false);
  const [isPrefixActive, setIsPrefixActive] = useState(false);
  const prefixTimerRef = useRef<NodeJS.Timeout | null>(null);

  const openCheatSheet = useCallback(() => setIsCheatSheetOpen(true), []);
  const closeCheatSheet = useCallback(() => setIsCheatSheetOpen(false), []);
  const toggleCheatSheet = useCallback(() => setIsCheatSheetOpen((prev) => !prev), []);

  const clearPrefixTimer = useCallback(() => {
    if (prefixTimerRef.current) {
      clearTimeout(prefixTimerRef.current);
      prefixTimerRef.current = null;
    }
  }, []);

  const setPrefixActiveWithTimeout = useCallback(() => {
    clearPrefixTimer();
    setIsPrefixActive(true);
    prefixTimerRef.current = setTimeout(() => {
      setIsPrefixActive(false);
    }, 1200); // 1.2s window for second key in chord
  }, [clearPrefixTimer]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // 1. Ignore if typing in form inputs / textareas / editable fields
      if (isInputElement(document.activeElement)) {
        return;
      }

      // 2. Ignore modifier keys alone or combinations with Ctrl/Meta/Alt
      if (e.ctrlKey || e.metaKey || e.altKey) {
        return;
      }

      const key = e.key;

      // Handle Escape
      if (key === "Escape") {
        if (isCheatSheetOpen) {
          e.preventDefault();
          setIsCheatSheetOpen(false);
          return;
        }
        if (isPrefixActive) {
          clearPrefixTimer();
          setIsPrefixActive(false);
          return;
        }
      }

      // Handle Cheat Sheet Toggle (?)
      if (key === "?" || (e.shiftKey && key === "/")) {
        e.preventDefault();
        toggleCheatSheet();
        return;
      }

      // 3. Handle 2-Key Chords starting with 'g'
      if (isPrefixActive) {
        clearPrefixTimer();
        setIsPrefixActive(false);
        e.preventDefault();

        switch (key.toLowerCase()) {
          case "d":
            router.push("/dashboard");
            break;
          case "a":
            router.push("/admin");
            break;
          case "i":
            router.push("/invest");
            break;
          case "g":
            router.push("/governance");
            break;
          case "h":
            router.push("/history");
            break;
          case "s":
            router.push("/settings");
            break;
          case "c":
            router.push("/contractor");
            break;
          case "l":
          case "p":
            router.push("/application");
            break;
          default:
            break;
        }
        return;
      }

      // 4. Initial Key Press Checks
      if (key.toLowerCase() === "g") {
        e.preventDefault();
        setPrefixActiveWithTimeout();
        return;
      }

      // 5. Single-Key Action Shortcuts
      if (key.toLowerCase() === "c") {
        e.preventDefault();
        router.push("/application");
        return;
      }

      if (key.toLowerCase() === "n") {
        e.preventDefault();
        // Dispatch custom event to trigger notification drawer
        window.dispatchEvent(new CustomEvent("toggle-notification-drawer"));
        return;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      clearPrefixTimer();
    };
  }, [
    isPrefixActive,
    isCheatSheetOpen,
    router,
    toggleCheatSheet,
    clearPrefixTimer,
    setPrefixActiveWithTimeout,
  ]);

  return (
    <KeyboardShortcutsContext.Provider
      value={{
        isCheatSheetOpen,
        openCheatSheet,
        closeCheatSheet,
        toggleCheatSheet,
        isPrefixActive,
      }}
    >
      {children}
      <KeyboardShortcutsModal isOpen={isCheatSheetOpen} onClose={closeCheatSheet} />
    </KeyboardShortcutsContext.Provider>
  );
}

export function useKeyboardShortcuts() {
  const context = useContext(KeyboardShortcutsContext);
  if (!context) {
    throw new Error("useKeyboardShortcuts must be used within KeyboardShortcutsProvider");
  }
  return context;
}
