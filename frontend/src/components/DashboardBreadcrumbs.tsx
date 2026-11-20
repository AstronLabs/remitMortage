"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const sectionLabels: Record<string, string> = {
  repay: "Repayments",
  history: "Transaction history",
  settings: "Settings",
  analytics: "Analytics",
  statements: "Statements",
  contractor: "Contractor",
  explorer: "Explorer",
};

const segmentLabels: Record<string, string> = {
  tx: "Transaction",
  "annual-interest": "Annual interest",
  "payout-history": "Payout history",
  payouts: "Payouts",
  onboarding: "Onboarding",
};

export default function DashboardBreadcrumbs() {
  const pathname = usePathname() ?? "/";
  const segments = pathname.split("/").filter(Boolean);
  const section = segments[0];
  if (!section || (section === "dashboard" && segments.length === 1)) return null;
  if (section !== "dashboard" && !(section in sectionLabels) && section !== "tx") return null;
  if (section === "explorer" && segments[1] !== "tx") return null;

  const trail = [{ href: "/dashboard", label: "Dashboard", link: true }];
  for (let index = section === "dashboard" ? 1 : 0; index < segments.length; index++) {
    const segment = segments[index];
    const parent = segments[index - 1];
    const label = parent === "tx"
      ? "Transaction details"
      : sectionLabels[segment] ?? segmentLabels[segment] ?? segment.replace(/[-_]/g, " ");
    trail.push({
      href: "/" + segments.slice(0, index + 1).join("/"),
      label,
      link: index === 0 && section === "contractor",
    });
  }

  return (
    <nav aria-label="Breadcrumb" className="mx-auto w-full max-w-7xl px-4 py-2 text-sm">
      <ol className="flex flex-wrap items-center gap-2 text-slate-300">
        {trail.map(({ href, label, link }, index) => {
          const current = index === trail.length - 1;
          const middle = index > 0 && !current;
          return (
            <li key={href} className={middle ? "hidden items-center gap-2 sm:flex" : "flex items-center gap-2"}>
              {index > 0 && <span aria-hidden="true">/</span>}
              {current
                ? <span aria-current="page" className="text-white">{label}</span>
                : link
                  ? <Link className="underline hover:text-white" href={href}>{label}</Link>
                  : <span>{label}</span>}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
