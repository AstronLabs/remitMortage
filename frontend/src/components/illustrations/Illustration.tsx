// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React from "react";
import type { Theme } from "@/app/lib/theme";

/**
 * Theme-aware illustrations for empty states and onboarding.
 *
 * Every illustration ships a light and a dark variant. The light variants are
 * drawn for light surfaces; the dark variants deliberately avoid white/opaque
 * fills so they never leave "harsh white boxes" on the dark theme.
 *
 * Variants switch automatically through the `[data-theme]` attribute on the
 * document root (see the `.rm-illustration` rules in `app/globals.css`). The
 * `theme` prop is exposed so tests and Storybook can render one variant
 * deterministically without touching the DOM attribute.
 */

export const ILLUSTRATION_NAMES = [
  "empty-states",
  "onboarding-welcome",
  "onboarding-connect-wallet",
  "onboarding-documents",
] as const;

export type IllustrationName = (typeof ILLUSTRATION_NAMES)[number];

interface Palette {
  /** Large opaque surface (cards, panels). */
  panel: string;
  /** Secondary/recessed surface. */
  panelAlt: string;
  /** Hairline outlines. */
  stroke: string;
  /** Low-emphasis fills. */
  muted: string;
  /** Brand accent used sparingly for emphasis. */
  accent: string;
  /** Tinted accent wash behind icons. */
  accentSoft: string;
}

const LIGHT: Palette = {
  panel: "#ffffff",
  panelAlt: "#eef2f7",
  stroke: "#cbd5e1",
  muted: "#94a3b8",
  accent: "#0369a1",
  accentSoft: "#dbeafe",
};

// No `ffffff`/white fills: dark surfaces only, so the art never punches a
// bright rectangle out of a dark background.
const DARK: Palette = {
  panel: "#0f172a",
  panelAlt: "#1e293b",
  stroke: "#334155",
  muted: "#475569",
  accent: "#38bdf8",
  accentSoft: "#0b2a3f",
};

const PALETTES: Record<Theme, Palette> = { light: LIGHT, dark: DARK };

type Renderer = (p: Palette) => React.ReactNode;

const RENDERERS: Record<IllustrationName, Renderer> = {
  "empty-states": (p) => (
    <>
      <rect x="70" y="18" width="44" height="30" rx="6" fill={p.panel} stroke={p.stroke} strokeWidth="2" />
      <rect x="126" y="10" width="44" height="30" rx="6" fill={p.panelAlt} stroke={p.stroke} strokeWidth="2" />
      <rect x="80" y="29" width="24" height="4" rx="2" fill={p.muted} />
      <rect x="136" y="21" width="24" height="4" rx="2" fill={p.muted} />
      <path d="M52 92h136v30a12 12 0 0 1-12 12H64a12 12 0 0 1-12-12z" fill={p.panel} stroke={p.stroke} strokeWidth="2" />
      <path d="M52 92l16-24h104l16 24z" fill={p.panelAlt} stroke={p.stroke} strokeWidth="2" strokeLinejoin="round" />
      <rect x="100" y="104" width="40" height="8" rx="4" fill={p.muted} />
      <circle cx="196" cy="44" r="4" fill={p.accent} />
      <circle cx="40" cy="60" r="3" fill={p.accent} />
      <path d="M198 74v10M193 79h10" stroke={p.accent} strokeWidth="2" strokeLinecap="round" />
    </>
  ),
  "onboarding-welcome": (p) => (
    <>
      <circle cx="196" cy="40" r="16" fill={p.accentSoft} stroke={p.accent} strokeWidth="2" />
      <path d="M120 30l64 46H56z" fill={p.accentSoft} stroke={p.accent} strokeWidth="2" strokeLinejoin="round" />
      <rect x="74" y="76" width="92" height="56" rx="6" fill={p.panel} stroke={p.stroke} strokeWidth="2" />
      <rect x="110" y="100" width="22" height="32" rx="4" fill={p.panelAlt} stroke={p.stroke} strokeWidth="2" />
      <circle cx="126" cy="118" r="2.5" fill={p.accent} />
      <rect x="86" y="90" width="14" height="14" rx="3" fill={p.panelAlt} stroke={p.stroke} strokeWidth="2" />
      <rect x="140" y="90" width="14" height="14" rx="3" fill={p.panelAlt} stroke={p.stroke} strokeWidth="2" />
      <path d="M36 150h168" stroke={p.stroke} strokeWidth="3" strokeLinecap="round" />
      <circle cx="40" cy="52" r="3" fill={p.accent} />
    </>
  ),
  "onboarding-connect-wallet": (p) => (
    <>
      <rect x="54" y="56" width="132" height="76" rx="14" fill={p.panel} stroke={p.stroke} strokeWidth="2" />
      <path d="M54 74h132" stroke={p.stroke} strokeWidth="2" />
      <rect x="150" y="82" width="30" height="24" rx="8" fill={p.panelAlt} stroke={p.stroke} strokeWidth="2" />
      <circle cx="165" cy="94" r="4" fill={p.accent} />
      <circle cx="96" cy="102" r="18" fill={p.accentSoft} stroke={p.accent} strokeWidth="2" />
      <path d="M96 92v20M90 97h12M90 107h12" stroke={p.accent} strokeWidth="2.5" strokeLinecap="round" />
      <circle cx="200" cy="44" r="4" fill={p.accent} />
    </>
  ),
  "onboarding-documents": (p) => (
    <>
      <rect
        x="78"
        y="34"
        width="84"
        height="104"
        rx="8"
        fill={p.panelAlt}
        stroke={p.stroke}
        strokeWidth="2"
        transform="rotate(-6 120 86)"
      />
      <rect x="72" y="30" width="84" height="104" rx="8" fill={p.panel} stroke={p.stroke} strokeWidth="2" />
      <rect x="88" y="52" width="52" height="6" rx="3" fill={p.muted} />
      <rect x="88" y="68" width="52" height="6" rx="3" fill={p.muted} />
      <rect x="88" y="84" width="34" height="6" rx="3" fill={p.muted} />
      <circle cx="170" cy="120" r="20" fill={p.accentSoft} stroke={p.accent} strokeWidth="2" />
      <path
        d="M161 120l7 7 14-15"
        fill="none"
        stroke={p.accent}
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
};

export interface IllustrationProps {
  name: IllustrationName;
  /** Force a single variant. Omit to let the active theme choose automatically. */
  theme?: Theme;
  className?: string;
  /** Accessible name. The illustration is treated as decorative when omitted. */
  title?: string;
  width?: number;
  height?: number;
}

function Svg({
  children,
  width,
  height,
}: {
  children: React.ReactNode;
  width: number;
  height: number;
}) {
  return (
    <svg
      viewBox="0 0 240 160"
      width={width}
      height={height}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export function Illustration({
  name,
  theme,
  className = "",
  title,
  width = 240,
  height = 160,
}: IllustrationProps) {
  const render = RENDERERS[name];
  const wrapperClass = `rm-illustration ${className}`.trim();

  // Forced variant (tests / Storybook): render the one requested variant.
  if (theme) {
    return (
      <span
        className={wrapperClass}
        data-illustration={name}
        data-variant={theme}
        role={title ? "img" : undefined}
        aria-label={title}
      >
        <Svg width={width} height={height}>{render(PALETTES[theme])}</Svg>
      </span>
    );
  }

  // Automatic: render both variants; `[data-theme]` CSS reveals exactly one.
  return (
    <span
      className={wrapperClass}
      data-illustration={name}
      role={title ? "img" : undefined}
      aria-label={title}
    >
      <span className="rm-illustration__variant" data-variant="light">
        <Svg width={width} height={height}>{render(LIGHT)}</Svg>
      </span>
      <span className="rm-illustration__variant" data-variant="dark">
        <Svg width={width} height={height}>{render(DARK)}</Svg>
      </span>
    </span>
  );
}

export default Illustration;
