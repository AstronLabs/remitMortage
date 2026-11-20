// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import type { MetadataRoute } from "next";

/**
 * Web app manifest. Next.js serves this at `/manifest.webmanifest` and injects
 * the `<link rel="manifest">` tag automatically, so no page-level wiring is
 * needed. `display: "standalone"` plus the 512px-capable icons make the app
 * installable; `id` pins the app identity so future `start_url` changes are
 * treated as an update rather than a brand-new install.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "RemitMortgage — Remittance-Backed Property Financing on Stellar",
    short_name: "RemitMortgage",
    description:
      "Turn your verified remittance history into a pathway to homeownership. Save, borrow, and build — all settled in USDC on the Stellar network.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#060913",
    theme_color: "#060913",
    categories: ["finance", "productivity"],
    icons: [
      {
        src: "/icons/icon.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "any",
      },
      {
        src: "/icons/icon-maskable.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "maskable",
      },
      {
        src: "/favicon.ico",
        sizes: "48x48",
        type: "image/x-icon",
      },
    ],
  };
}
