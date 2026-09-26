"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React from "react";
import { useRouter } from "next/navigation";

export default function UnauthorizedPage() {
  const router = useRouter();

  return (
    <div className="min-h-screen bg-[#060913] flex items-center justify-center px-6">
      <div className="max-w-md w-full text-center">
        <div className="mb-6 inline-flex items-center justify-center w-20 h-20 rounded-full bg-red-500/10 border border-red-500/20">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="w-10 h-10 text-red-400"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
        </div>

        <h1 className="text-3xl font-extrabold text-white mb-2">Access Denied</h1>
        <p className="text-slate-400 text-sm mb-8">
          You do not have the required permissions to view this page. If you believe this is an
          error, please contact the protocol administrator.
        </p>

        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          <button
            onClick={() => router.push("/")}
            className="btn-cta !py-2.5 !px-6"
          >
            Return Home
          </button>
          <button
            onClick={() => router.back()}
            className="btn-outline !py-2.5 !px-6"
          >
            Go Back
          </button>
        </div>
      </div>
    </div>
  );
}
