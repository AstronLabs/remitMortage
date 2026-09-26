"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import dynamic from "next/dynamic";
import Link from "next/link";

const Navbar = dynamic(() => import("../../components/Navbar"), { ssr: false });
const OnboardingWizard = dynamic(() => import("../../components/onboarding/OnboardingWizard"), {
  ssr: false,
});

export default function OnboardingPage() {
  return (
    <main className="rm-app-page min-h-screen flex flex-col bg-[#060913] text-slate-100">
      <Navbar />

      {/* ── Header / Hero ─────────────────────────────────────── */}
      <section className="page-with-navbar">
        <div className="relative overflow-hidden border-b border-slate-800/80">
          <div
            aria-hidden="true"
            className="absolute inset-0 bg-[radial-gradient(circle_at_0%_0%,rgba(56,189,248,0.14),transparent_50%),radial-gradient(circle_at_100%_0%,rgba(99,102,241,0.14),transparent_55%)]"
          />
          <div className="relative z-10 max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 pt-8 pb-10 sm:pt-10 sm:pb-12 lg:pt-12 lg:pb-14">
            {/* Breadcrumb */}
            <nav aria-label="Breadcrumb" className="mb-6">
              <ol className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] sm:text-xs text-slate-500">
                <li>
                  <Link
                    href="/"
                    className="inline-flex items-center gap-1.5 hover:text-cyan-400 transition-colors"
                  >
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="w-3.5 h-3.5"
                      aria-hidden="true"
                    >
                      <path d="M3 12l9-9 9 9" />
                      <path d="M5 10v10h14V10" />
                    </svg>
                    Home
                  </Link>
                </li>
                <li aria-hidden="true" className="text-slate-700">
                  /
                </li>
                <li aria-current="page" className="text-cyan-400 font-semibold">
                  Onboarding
                </li>
              </ol>
            </nav>

            {/* Eyebrow badge + stats row */}
            <div className="flex flex-wrap items-start justify-between gap-5 sm:gap-6 mb-6">
              <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-cyan-500/10 border border-cyan-500/20 text-cyan-400 text-[11px] sm:text-xs font-semibold uppercase tracking-wider w-fit">
                <span className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse" />
                4-Step Onboarding Flow
              </div>

              <div className="grid grid-cols-3 gap-2 sm:gap-3 w-full sm:w-auto sm:min-w-[360px] shrink-0">
                <div className="p-3 sm:p-4 rounded-xl bg-slate-900/70 border border-slate-800/80 backdrop-blur flex flex-col items-center text-center">
                  <div className="text-2xl sm:text-3xl font-extrabold text-cyan-400 font-mono tracking-tight leading-none">
                    4
                  </div>
                  <div className="mt-1.5 text-[10px] sm:text-[11px] text-slate-400 uppercase tracking-wider font-medium">
                    Steps
                  </div>
                </div>
                <div className="p-3 sm:p-4 rounded-xl bg-slate-900/70 border border-slate-800/80 backdrop-blur flex flex-col items-center text-center">
                  <div className="text-2xl sm:text-3xl font-extrabold text-indigo-400 font-mono tracking-tight leading-none">
                    100%
                  </div>
                  <div className="mt-1.5 text-[10px] sm:text-[11px] text-slate-400 uppercase tracking-wider font-medium whitespace-nowrap">
                    Non-Custodial
                  </div>
                </div>
                <div className="p-3 sm:p-4 rounded-xl bg-slate-900/70 border border-slate-800/80 backdrop-blur flex flex-col items-center text-center">
                  <div className="text-2xl sm:text-3xl font-extrabold text-emerald-400 font-mono tracking-tight leading-none whitespace-nowrap">
                    3-5s
                  </div>
                  <div className="mt-1.5 text-[10px] sm:text-[11px] text-slate-400 uppercase tracking-wider font-medium">
                    Settlement
                  </div>
                </div>
              </div>
            </div>

            {/* Title + description */}
            <div className="max-w-3xl space-y-3 sm:space-y-4">
              <h1 className="text-2xl sm:text-3xl md:text-4xl lg:text-[2.75rem] font-extrabold tracking-tight text-white leading-tight">
                Onboard to RemitMortgage
              </h1>
              <p className="text-sm sm:text-base md:text-lg text-slate-400 leading-relaxed max-w-2xl">
                Connect your wallet, verify your remittance history on Stellar Horizon, set a
                down-payment goal, and make your first deposit into a non-custodial Soroban escrow.
              </p>
            </div>
          </div>
        </div>

        {/* ── Wizard area ──────────────────────────────────────── */}
        <div className="bg-[#0b0f1d] flex-1">
          <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8 sm:py-10 md:py-12 flex items-start justify-center">
            <OnboardingWizard />
          </div>
        </div>
      </section>
    </main>
  );
}
