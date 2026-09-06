"use client";

import { useCallback, useEffect, useState } from "react";
import { Copy, Link2, Users } from "lucide-react";
import { fetchReferralCode, fetchReferralStats } from "@/lib/referralApi";

type ReferralInvitePanelProps = {
  ownerAddress: string;
};

export default function ReferralInvitePanel({ ownerAddress }: ReferralInvitePanelProps) {
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [invitesSent, setInvitesSent] = useState(0);
  const [conversions, setConversions] = useState(0);
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(false);

  const loadReferral = useCallback(async () => {
    if (!ownerAddress) return;
    setLoading(true);
    setStatus("");
    try {
      const [codeRes, statsRes] = await Promise.all([
        fetchReferralCode(ownerAddress),
        fetchReferralStats(ownerAddress),
      ]);
      setCode(codeRes.code);
      setInviteLink(codeRes.inviteLink);
      setInvitesSent(statsRes.invitesSent);
      setConversions(statsRes.conversions);
    } catch {
      setStatus("Unable to load referral link. Ensure the API server is running.");
    } finally {
      setLoading(false);
    }
  }, [ownerAddress]);

  useEffect(() => {
    void loadReferral();
  }, [loadReferral]);

  async function copyInviteLink() {
    if (!inviteLink) return;
    await navigator.clipboard.writeText(inviteLink);
    setStatus("Invite link copied to clipboard.");
  }

  return (
    <section className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-white">Referral Invite Links</h2>
        <p className="text-slate-400 text-sm mt-1">
          Share your personal invite link to grow the borrower community and track conversions.
        </p>
      </div>

      <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-5 space-y-4">
        <div className="flex items-center gap-2 text-cyan-400 text-xs font-semibold uppercase tracking-wider">
          <Link2 size={14} />
          Your referral link
        </div>

        <div className="flex flex-col md:flex-row gap-3">
          <input
            readOnly
            value={inviteLink ?? (loading ? "Generating link..." : "Connect wallet to generate link")}
            className="flex-1 p-3.5 rounded-xl border border-slate-700 bg-slate-950/70 text-white font-mono text-xs"
          />
          <button
            type="button"
            onClick={copyInviteLink}
            disabled={!inviteLink}
            className="btn-primary !py-2.5 !px-5 text-xs inline-flex items-center justify-center gap-2 disabled:opacity-50"
          >
            <Copy size={14} />
            Copy link
          </button>
        </div>

        {code && (
          <p className="text-xs text-slate-400">
            Referral code: <span className="font-mono text-cyan-300">{code}</span>
          </p>
        )}
        {status && <p className="text-xs text-cyan-300">{status}</p>}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <article className="rounded-xl border border-slate-800 bg-slate-950/60 p-5">
          <div className="flex items-center gap-2 text-slate-400 text-xs font-semibold uppercase">
            <Users size={14} />
            Invites sent
          </div>
          <p className="text-3xl font-extrabold text-white mt-2 font-mono">{invitesSent}</p>
        </article>
        <article className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-5">
          <div className="text-xs font-semibold uppercase text-emerald-300">Conversions</div>
          <p className="text-3xl font-extrabold text-white mt-2 font-mono">{conversions}</p>
          <p className="text-[11px] text-emerald-200/80 mt-1">Eligible sign-ups attributed to your code</p>
        </article>
      </div>
    </section>
  );
}
