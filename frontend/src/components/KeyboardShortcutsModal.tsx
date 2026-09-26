"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React, { useEffect } from "react";
import { SHORTCUT_LIST, ShortcutItem } from "@/context/KeyboardShortcutsContext";

type KeyboardShortcutsModalProps = {
  isOpen: boolean;
  onClose: () => void;
};

export default function KeyboardShortcutsModal({ isOpen, onClose }: KeyboardShortcutsModalProps) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isOpen) {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const categories: Array<ShortcutItem["category"]> = ["Navigation", "Actions", "General"];

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-md animate-fade-in">
      {/* Backdrop click to close */}
      <div className="absolute inset-0" onClick={onClose} />

      <div
        className="relative w-full max-w-2xl bg-slate-900/95 border border-slate-800/80 rounded-2xl shadow-2xl overflow-hidden p-6 sm:p-8 text-slate-100 z-10"
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcut-modal-title"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-800 pb-4 mb-6">
          <div className="flex items-center space-x-3">
            <div className="p-2.5 bg-emerald-500/10 border border-emerald-500/20 rounded-xl text-emerald-400">
              <svg
                className="w-6 h-6"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4"
                />
              </svg>
            </div>
            <div>
              <h2 id="shortcut-modal-title" className="text-xl font-bold text-slate-100 tracking-tight">
                Keyboard Shortcuts
              </h2>
              <p className="text-xs text-slate-400">
                Speed up dashboard navigation & actions with quick hotkeys
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-slate-400 hover:text-slate-100 hover:bg-slate-800 rounded-lg transition-colors"
            aria-label="Close keyboard shortcuts modal"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Shortcut Groups */}
        <div className="space-y-6 max-h-[60vh] overflow-y-auto pr-2 custom-scrollbar">
          {categories.map((cat) => {
            const items = SHORTCUT_LIST.filter((item) => item.category === cat);
            if (items.length === 0) return null;

            return (
              <div key={cat} className="space-y-3">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-emerald-400/90 pl-1">
                  {cat}
                </h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  {items.map((item, idx) => (
                    <div
                      key={idx}
                      className="flex items-center justify-between p-3 bg-slate-800/50 hover:bg-slate-800/80 border border-slate-700/50 rounded-xl transition-all duration-150"
                    >
                      <span className="text-sm text-slate-300 font-medium">{item.description}</span>
                      <div className="flex items-center space-x-1.5 ml-3">
                        {item.keys.map((k, keyIdx) => (
                          <React.Fragment key={keyIdx}>
                            <kbd className="px-2 py-1 bg-slate-900 border border-slate-700 rounded-md text-xs font-mono font-semibold text-emerald-400 shadow-sm min-w-[24px] text-center">
                              {k}
                            </kbd>
                            {keyIdx < item.keys.length - 1 && (
                              <span className="text-xs text-slate-500">+</span>
                            )}
                          </React.Fragment>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>

        {/* Footer info */}
        <div className="mt-6 pt-4 border-t border-slate-800 flex items-center justify-between text-xs text-slate-400">
          <span>Shortcuts disabled while typing in text input fields</span>
          <button
            onClick={onClose}
            className="px-4 py-2 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 font-medium rounded-xl transition-all text-xs"
          >
            Got it (Esc)
          </button>
        </div>
      </div>
    </div>
  );
}
