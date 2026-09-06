"use client";

import { useEffect, useState } from "react";
import { fetchReferralStats } from "@/lib/referralApi";

type ReferralStatsCardProps = {
  ownerAddress: string;
};

export default function ReferralStatsCard({ ownerAddress }: ReferralStatsCardProps) {
  const [invitesSent, setInvitesSent] = useState(0);
  const [conversions, setConversions] = useState(0);
  const [inviteLink, setInviteLink] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const stats = await fetchReferralStats(ownerAddress);
        if (cancelled) return;
        setInvitesSent(stats.invitesSent);
        setConversions(stats.conversions);
        setInviteLink(stats.inviteLink);
      } catch {
        // Dashboard should remain usable if referral API is unavailable.
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [ownerAddress]);

  return (
    <div className="bg-slate-900/80 border border-slate-800 rounded-2xl p-6 shadow-xl backdrop-blur-xl">
      <div className="flex items-center justify-between gap-4 mb-4">
        <div>
          <h2 className="text-lg font-bold text-white">Referral Performance</h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Track invites sent and eligible borrower conversions from your link.
          </p>
        </div>
        <a href="/settings" className="text-xs font-semibold text-cyan-400 hover:underline whitespace-nowrap">
          Manage link →
        </a>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="p-4 rounded-xl bg-slate-950/60 border border-slate-800">
          <p className="text-[10px] uppercase tracking-wider text-slate-400 font-bold">Invites sent</p>
          <p className="text-2xl font-extrabold text-white mt-1 font-mono">{invitesSent}</p>
        </div>
        <div className="p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/20">
          <p className="text-[10px] uppercase tracking-wider text-emerald-300 font-bold">Conversions</p>
          <p className="text-2xl font-extrabold text-white mt-1 font-mono">{conversions}</p>
        </div>
      </div>

      {inviteLink && (
        <p className="text-[11px] text-slate-500 mt-4 truncate font-mono" title={inviteLink}>
          {inviteLink}
        </p>
      )}
    </div>
  );
}
