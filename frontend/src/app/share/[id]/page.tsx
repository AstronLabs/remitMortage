// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL ?? "https://remitmortgage.com";

type Props = {
  params: Promise<{ id: string }>;
};

type MilestoneEntry = {
  id: string;
  title: string;
  state: string;
  description?: string;
};

type ShareData = {
  id: string;
  borrowerLabel: string;
  deposited: string;
  target: string;
  progress: number;
  apy: string;
  milestonesCompleted: number;
  milestonesTotal: number;
  milestones: MilestoneEntry[];
  loanStatus: string;
};

async function fetchShareData(id: string): Promise<ShareData | null> {
  try {
    const url = `${BASE_URL}/api/share/${encodeURIComponent(id)}`;
    const res = await fetch(url, { next: { revalidate: 60 } });
    if (!res.ok) return null;
    return (await res.json()) as ShareData;
  } catch {
    return null;
  }
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const data = await fetchShareData(id);
  if (!data) return {};

  const title = `${data.borrowerLabel}'s RemitMortgage — $${Number(data.deposited).toLocaleString()} / $${Number(data.target).toLocaleString()} saved`;
  const description = `${data.milestonesCompleted}/${data.milestonesTotal} milestones completed | ${data.apy}% APY`;

  return {
    title,
    description,
    openGraph: {
      title: `${data.borrowerLabel}'s RemitMortgage — ${data.progress}% funded`,
      description: `${data.milestonesCompleted} of ${data.milestonesTotal} milestones verified | $${Number(data.deposited).toLocaleString()} USDC saved toward $${Number(data.target).toLocaleString()} target`,
      url: `${BASE_URL}/share/${id}`,
      siteName: "RemitMortgage",
      images: [{ url: "/og-image.png", width: 1200, height: 630, alt: title }],
    },
    twitter: {
      card: "summary_large_image",
      title: `${data.borrowerLabel}'s RemitMortgage Progress`,
      description: `${data.milestonesCompleted}/${data.milestonesTotal} milestones ✓ | $${Number(data.deposited).toLocaleString()} USDC saved`,
      images: ["/og-image.png"],
    },
  };
}

function StateBadge({ state }: { state: string }) {
  const colors: Record<string, string> = {
    Disbursed: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
    Approved: "bg-indigo-500/20 text-indigo-400 border-indigo-500/30",
    Voting: "bg-amber-500/20 text-amber-400 border-amber-500/30",
    Proposed: "bg-blue-500/20 text-blue-400 border-blue-500/30",
    Pending: "bg-slate-500/20 text-slate-400 border-slate-500/30",
  };
  const cls = colors[state] ?? colors.Pending;
  return (
    <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold border ${cls}`}>
      {state}
    </span>
  );
}

export default async function SharePage({ params }: Props) {
  const { id } = await params;
  const data = await fetchShareData(id);
  if (!data) notFound();

  const d = Number(data.deposited) || 0;
  const t = Number(data.target) || 0;
  const pct = t > 0 ? Math.min(100, Math.round((d / t) * 100)) : 0;

  return (
    <div className="min-h-screen bg-[#060913] text-slate-100 font-sans antialiased flex items-center justify-center p-4">
      <div className="w-full max-w-lg">
        <div className="rounded-2xl border border-slate-800 bg-slate-950/80 backdrop-blur-sm overflow-hidden">
          {/* Header */}
          <div className="border-b border-slate-800 px-6 py-4 flex items-center justify-between">
            <span className="text-sm font-bold text-white">RemitMortgage</span>
            <span className="text-xs text-slate-500 font-mono">{data.borrowerLabel}</span>
          </div>

          {/* Savings progress */}
          <div className="px-6 pt-6 pb-4">
            <h1 className="text-lg font-bold text-white mb-1">
              Escrow Down-Payment Goal
            </h1>
            <p className="text-xs text-slate-400 mb-5">
              Target 30% contribution required for 70% loan unlock &middot; {data.apy}% APY
            </p>

            <div className="flex items-center gap-5 p-4 rounded-xl bg-slate-900/60 border border-slate-800">
              <div className="relative w-24 h-24 shrink-0 flex items-center justify-center">
                <svg className="w-full h-full transform -rotate-90" viewBox="0 0 36 36">
                  <path className="text-slate-800" strokeWidth="3.5" stroke="currentColor" fill="none" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
                  <path className="text-cyan-400 transition-all duration-1000 ease-out" strokeDasharray={`${pct}, 100`} strokeWidth="3.5" strokeLinecap="round" stroke="currentColor" fill="none" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
                </svg>
                <div className="absolute text-center">
                  <div className="text-lg font-extrabold text-white font-mono">{pct}%</div>
                  <div className="text-[10px] text-slate-400">funded</div>
                </div>
              </div>

              <div className="flex-1 min-w-0">
                <div className="flex justify-between text-xs font-semibold mb-1.5">
                  <span className="text-slate-300">Saved</span>
                  <span className="text-cyan-400 font-mono">
                    ${d.toLocaleString()} / ${t.toLocaleString()} USDC
                  </span>
                </div>
                <div className="w-full h-2 rounded-full bg-slate-900 border border-slate-800 overflow-hidden">
                  <div className="h-full bg-gradient-to-r from-cyan-400 to-emerald-400 rounded-full transition-all" style={{ width: `${pct}%` }} />
                </div>
                <div className="flex justify-between mt-1.5 text-[11px]">
                  <span className="text-slate-500">Loan: {data.loanStatus}</span>
                  <span className="text-emerald-400">{data.apy}% APY</span>
                </div>
              </div>
            </div>
          </div>

          {/* Milestones */}
          <div className="px-6 pb-2">
            <h2 className="text-sm font-bold text-white mb-3">
              Milestones ({data.milestonesCompleted}/{data.milestonesTotal})
            </h2>
            <ul className="space-y-2">
              {data.milestones.map((m) => (
                <li
                  key={m.id}
                  className="flex items-center justify-between gap-3 rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2.5"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-slate-200 truncate">{m.title}</p>
                    {m.description && (
                      <p className="text-[11px] text-slate-500 truncate">{m.description}</p>
                    )}
                  </div>
                  <StateBadge state={m.state} />
                </li>
              ))}
            </ul>
          </div>

          {/* Footer */}
          <div className="px-6 py-4 border-t border-slate-800 mt-4">
            <Link
              href={BASE_URL}
              className="block w-full py-2.5 text-center text-sm font-bold text-white bg-cyan-600 hover:bg-cyan-500 rounded-full transition-colors"
            >
              View on RemitMortgage
            </Link>
            <p className="text-[10px] text-slate-600 text-center mt-2">
              Remittance-backed property financing on Stellar
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
