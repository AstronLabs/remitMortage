"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/context/AuthContext";

const routes = [
  { href: "/dashboard", label: "Borrower dashboard" },
  { href: "/invest", label: "Investments" },
  { href: "/contractor", label: "Contractor dashboard" },
  { href: "/admin", label: "Admin dashboard" },
  { href: "/application", label: "Start a loan application" },
  { href: "/repay", label: "Make a loan payment" },
  { href: "/history", label: "Transaction history" },
  { href: "/governance", label: "Governance" },
  { href: "/settings", label: "Settings" },
];

export default function CommandPalette() {
  const { role, hasAccess } = useAuth();
  const [query, setQuery] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const matches = routes.filter(({ href, label }) =>
    hasAccess(href) &&
    (href !== "/application" && href !== "/repay" || role === "borrower") &&
    label.toLowerCase().includes(query.trim().toLowerCase()),
  );

  function open() {
    if (!dialog.current || dialog.current.open) return;
    setQuery("");
    dialog.current.showModal();
    input.current?.focus();
  }

  useEffect(() => {
    if (!role) return;
    function onKeyDown(event: KeyboardEvent) {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== "k") return;
      event.preventDefault();
      open();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [role]);

  if (!role) return null;

  return (
    <div className="mx-auto flex max-w-7xl justify-end px-4 pt-2">
      <button type="button" aria-haspopup="dialog" aria-keyshortcuts="Control+K Meta+K" className="btn-ghost text-sm" onClick={open}>
        Quick navigation
      </button>
      <dialog ref={dialog} aria-labelledby="command-palette-heading" className="m-auto w-[min(90vw,32rem)] rounded-xl border border-slate-700 bg-slate-900 p-4 text-slate-100 backdrop:bg-black/60"
        onKeyDown={event => {
          if (event.key === "Escape") {
            event.preventDefault();
            dialog.current?.close();
          }
        }}>
        <div className="flex items-center justify-between gap-2">
          <h2 id="command-palette-heading" className="font-semibold">Quick navigation</h2>
          <button type="button" className="btn-ghost" onClick={() => dialog.current?.close()}>Close</button>
        </div>
        <input ref={input} aria-label="Search commands" value={query} onChange={event => setQuery(event.target.value)} className="my-3 w-full rounded-md border border-slate-600 bg-slate-950 p-2" />
        <p role="status" className="text-sm text-slate-300">{matches.length} {matches.length === 1 ? "command" : "commands"} available</p>
        <ul className="mt-2 max-h-60 overflow-y-auto">
          {matches.map(({ href, label }) => (
            <li key={href}>
              <Link href={href} onClick={() => dialog.current?.close()} className="block rounded-md p-2 hover:bg-slate-800 focus-visible:outline">{label}</Link>
            </li>
          ))}
        </ul>
      </dialog>
    </div>
  );
}
