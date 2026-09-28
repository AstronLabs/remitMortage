"use client";

import { useEffect, useRef } from "react";
import type { FieldErrors, FieldValues } from "react-hook-form";

type ErrorSummaryProps<T extends FieldValues> = {
  errors: FieldErrors<T>;
  labels: Partial<Record<keyof T, string>>;
  announcementKey: number;
  onFieldSelect: (name: keyof T & string) => void;
};

export default function ErrorSummary<T extends FieldValues>({
  errors,
  labels,
  announcementKey,
  onFieldSelect,
}: ErrorSummaryProps<T>) {
  const announcementRef = useRef<HTMLDivElement>(null);
  const previousCount = useRef(0);
  const previousAnnouncementKey = useRef(announcementKey);
  const items = Object.entries(errors).flatMap(([name, error]) => {
    if (
      !error ||
      typeof error !== "object" ||
      !("message" in error) ||
      typeof error.message !== "string"
    ) {
      return [];
    }

    return [
      {
        name: name as keyof T & string,
        label: labels[name as keyof T] ?? name,
        message: error.message,
      },
    ];
  });

  useEffect(() => {
    const shouldAnnounce =
      items.length > 0 &&
      (previousCount.current === 0 || previousAnnouncementKey.current !== announcementKey);

    if (shouldAnnounce) {
      const heading = `Found ${items.length} ${items.length === 1 ? "error" : "errors"}.`;
      const details = items.map(({ label, message }) => `${label}: ${message}`).join(". ");
      if (announcementRef.current) announcementRef.current.textContent = `${heading} ${details}`;
    } else if (items.length === 0) {
      if (announcementRef.current) announcementRef.current.textContent = "";
    }

    previousCount.current = items.length;
    previousAnnouncementKey.current = announcementKey;
  }, [announcementKey, items]);

  return (
    <>
      <div
        ref={announcementRef}
        className="sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      />
      {items.length > 0 && (
        <section
          className="mb-5 rounded-lg border border-red-400/40 bg-red-500/10 p-4 text-red-100"
          role="region"
          aria-labelledby="form-error-summary-title"
        >
          <h2 id="form-error-summary-title" className="mb-2 text-sm font-semibold">
            Please correct the following errors
          </h2>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {items.map(({ name, label, message }) => (
              <li key={name}>
                <a
                  className="underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                  href={`#${name}`}
                  onClick={(event) => {
                    event.preventDefault();
                    onFieldSelect(name);
                  }}
                >
                  {label}: {message}
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
