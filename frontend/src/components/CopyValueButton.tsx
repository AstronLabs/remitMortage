"use client";

import { useEffect, useRef, useState } from "react";
import { Copy } from "lucide-react";

export default function CopyValueButton({ value, label }: { value: string; label: string }) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");
  const fallback = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (status === "failed") {
      fallback.current?.focus();
      fallback.current?.select();
    }
    if (status === "copied") {
      const timer = window.setTimeout(() => setStatus("idle"), 2000);
      return () => window.clearTimeout(timer);
    }
  }, [status]);

  async function copyValue() {
    try {
      await navigator.clipboard.writeText(value);
      setStatus("copied");
    } catch {
      setStatus("failed");
    }
  }

  return (
    <span className="inline-flex shrink-0 flex-wrap items-center gap-1">
      <button type="button" onClick={copyValue} aria-label={`Copy ${label}`} className="rounded p-2 hover:bg-slate-700 focus-visible:outline">
        <Copy aria-hidden="true" size={14} />
      </button>
      <span role="status" className="text-xs">
        {status === "copied" && "Copied"}
        {status === "failed" && "Could not copy. Copy the selected value manually."}
      </span>
      {status === "failed" && (
        <input ref={fallback} aria-label={`Full ${label}`} value={value} readOnly className="max-w-full rounded border bg-slate-900 px-2 py-1" />
      )}
    </span>
  );
}
