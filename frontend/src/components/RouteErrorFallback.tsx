"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React, { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { captureRenderError, generateErrorId } from "@/lib/error-report";
import ReportProblemDialog from "./ReportProblemDialog";

interface RouteErrorFallbackProps {
  error: Error & { digest?: string };
  /** Re-render the failed segment (Next's `reset`, or the boundary's own). */
  reset: () => void;
}

/** Friendly fallback for a crashed route, with retry and a Report a problem dialog. */
export default function RouteErrorFallback({ error, reset }: RouteErrorFallbackProps) {
  const pathname = usePathname() ?? "/";
  const [errorId] = useState(generateErrorId);
  const [open, setOpen] = useState(false);
  const eventId = useRef<string>(undefined);
  const reportedError = useRef<Error | null>(null);

  useEffect(() => {
    if (reportedError.current === error) return;
    reportedError.current = error;
    eventId.current = captureRenderError(error, errorId, pathname);
  }, [error, errorId, pathname]);

  return (
    <div role="alert" className="mx-auto flex max-w-lg flex-col items-center gap-4 px-6 py-24 text-center">
      <h1 className="text-2xl font-bold text-white">Something went wrong</h1>
      <p className="text-sm text-slate-400">
        This page hit an unexpected error. Try again, and if it keeps happening let us know.
      </p>
      <p className="text-xs text-slate-500">
        Error ID: <code data-testid="fallback-error-id">{errorId}</code>
      </p>
      <div className="flex gap-3">
        <button type="button" onClick={reset} className="rounded-lg bg-cyan-500 px-4 py-2 text-sm font-bold text-slate-950">
          Try again
        </button>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-200"
        >
          Report a problem
        </button>
      </div>
      {open && (
        <ReportProblemDialog
          errorId={errorId}
          pathname={pathname}
          error={error}
          getEventId={() => eventId.current}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}
