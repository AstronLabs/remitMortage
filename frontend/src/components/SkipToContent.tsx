"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React from "react";

/**
 * Accessible skip navigation link for keyboard and screen-reader users.
 * Positioned off-screen until focused, then rendered visibly at the top-start of viewport.
 */
export function SkipToContent() {
  return (
    <a
      href="#main-content"
      className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:start-4 focus:z-[9999] focus:px-4 focus:py-2.5 focus:bg-cyan-500 focus:text-slate-950 focus:font-semibold focus:rounded-lg focus:shadow-2xl focus:ring-2 focus:ring-white focus:outline-none transition-all duration-150"
    >
      Skip to main content
    </a>
  );
}

export default SkipToContent;
