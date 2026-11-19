"use client";

import React, { useEffect, useState } from "react";
import { X, ZoomIn } from "lucide-react";

export function qrCodeUrl(value: string, size = 240): string {
  return `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&data=${encodeURIComponent(value)}`;
}

type Props = {
  value: string;
  label: string;
  testId?: string;
};

/** A dependency-free QR image with an accessible enlarged view. */
export default function QrCodeDisplay({ value, label, testId = "qr-code" }: Props) {
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [isOpen]);

  return (
    <>
      <button
        type="button"
        className="group relative block rounded-lg bg-white p-2 focus:outline-none focus:ring-2 focus:ring-cyan-400"
        onClick={() => setIsOpen(true)}
        aria-label={`Enlarge QR code for ${label}`}
        data-testid={testId}
      >
        <img
          src={qrCodeUrl(value)}
          alt={`QR code for ${label}`}
          width={112}
          height={112}
          className="block h-28 w-28"
        />
        <span className="absolute inset-0 flex items-center justify-center bg-slate-950/0 text-white opacity-0 transition group-hover:bg-slate-950/45 group-hover:opacity-100">
          <ZoomIn className="h-5 w-5" aria-hidden="true" />
        </span>
      </button>

      {isOpen && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/80 p-4"
          role="dialog"
          aria-modal="true"
          aria-label={`QR code for ${label}`}
          onClick={() => setIsOpen(false)}
        >
          <div className="relative rounded-2xl bg-white p-5 shadow-2xl" onClick={(event) => event.stopPropagation()}>
            <button
              type="button"
              onClick={() => setIsOpen(false)}
              className="absolute -right-3 -top-3 rounded-full bg-slate-900 p-2 text-white"
              aria-label="Close enlarged QR code"
            >
              <X className="h-5 w-5" aria-hidden="true" />
            </button>
            <img src={qrCodeUrl(value, 560)} alt={`QR code for ${label}`} width={560} height={560} className="max-h-[80vh] max-w-[80vw]" />
            <p className="mt-3 max-w-[560px] break-all text-center font-mono text-xs text-slate-600">{value}</p>
          </div>
        </div>
      )}
    </>
  );
}
