"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { useLocale } from "next-intl";
import { ArrowRight, CheckCircle2, FileText, Landmark, WalletCards } from "lucide-react";
import { useWallet, OptionalWalletProvider } from "@/context/WalletContext";
import { EmptyState } from "@/components/EmptyState";
import HelpLink from "@/components/help/HelpLink";
import CurrencyAmountInput from "@/components/forms/CurrencyAmountInput";
import type { Locale } from "@/i18n/locales";
import { track } from "@/lib/analytics";
import { announce } from "@/lib/announcer";
import { useUnsavedChangesGuard } from "@/hooks/useUnsavedChangesGuard";
import UnsavedChangesDialog from "@/components/forms/UnsavedChangesDialog";

const Navbar = dynamic(() => import("@/components/Navbar"), { ssr: false });

type Application = {
  id: string;
  amount: string;
  status: string;
  createdAt?: string;
  reason?: string;
};

function ApplicationPageInner() {
  const { publicKey, isConnected, connect } = useWallet();
  const locale = useLocale() as Locale;
  const [amount, setAmount] = useState<number | null>(null);
  const [applications, setApplications] = useState<Application[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // A typed-but-unsubmitted amount is lost on navigation; submitting clears it.
  const { dialogProps: unsavedChangesDialog } = useUnsavedChangesGuard({
    isDirty: amount !== null,
  });

  useEffect(() => {
    if (!publicKey) return;
    fetch(`/api/loan/applications?address=${encodeURIComponent(publicKey)}`)
      .then(async (response) => (response.ok ? response.json() : []))
      .then((data) => setApplications(Array.isArray(data) ? data : []))
      .catch(() => setApplications([]));
  }, [publicKey]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!publicKey || amount === null) return;
    setLoading(true);
    setMessage(null);
    track("loan_application_started");
    try {
      const response = await fetch("/api/loan/applications", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ borrowerAddress: publicKey, amount: String(amount) }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || data.error || "Application failed");
      setApplications((current) => [data, ...current]);
      setAmount(null);
      setMessage("Application submitted for underwriting review.");
      announce("Loan application submitted for underwriting review.");
      track("loan_application_submitted");
    } catch (error) {
      const failure = error instanceof Error ? error.message : "Application failed";
      setMessage(failure);
      announce(`Loan application failed. ${failure}`, { priority: "assertive" });
    } finally {
      setLoading(false);
    }
  }

  return (
    <main data-testid="loan-application-page" className="rm-app-page rm-workflow-page min-h-screen">
      <Navbar />
      <UnsavedChangesDialog {...unsavedChangesDialog} />
      <div className="rm-workflow-shell">
        <header className="rm-workflow-header">
          <span>Borrower financing</span>
          <h1>Loan application</h1>
          <p>
            Request the lending-pool portion of your property financing after your escrow target and
            verification requirements are complete.
          </p>
        </header>
        <div className="rm-workflow-grid">
          <section className="rm-workflow-panel">
            <div className="rm-panel-heading">
              <Landmark size={20} />
              <div>
                <h2>New financing request</h2>
                <p>
                  The backend validates wallet identity and escrow eligibility before creating the
                  application.
                </p>
              </div>
            </div>
            {!isConnected ? (
              <button className="rm-action-button" onClick={() => connect()}>
                <WalletCards size={17} /> Connect wallet
              </button>
            ) : (
              <form onSubmit={submit} className="rm-form-stack">
                <label htmlFor="loan-amount">Requested principal</label>
                <CurrencyAmountInput
                  id="loan-amount"
                  data-testid="loan-amount"
                  locale={locale}
                  value={amount}
                  onChange={setAmount}
                  min={1}
                  placeholder="70,000"
                  currencyLabel="USDC"
                  showInvalidError
                />
                <p>
                  Connected borrower: {publicKey?.slice(0, 8)}…{publicKey?.slice(-6)}
                </p>
                <button
                  data-testid="loan-submit"
                  className="rm-action-button"
                  disabled={loading || amount === null}
                >
                  {loading ? "Submitting…" : "Submit application"}
                  <ArrowRight size={17} />
                </button>
              </form>
            )}
            {message && (
              <div data-testid="loan-submit-status" className="rm-inline-message">
                {message}
              </div>
            )}
            <div className="mt-3">
              <HelpLink context="loan-application" />
            </div>
          </section>
          <aside className="rm-requirements">
            <h2>Application requirements</h2>
            {[
              { icon: CheckCircle2, text: "Verified remittance history" },
              { icon: WalletCards, text: "Escrow target reached" },
              { icon: FileText, text: "Identity and KYC complete" },
            ].map(({ icon: Icon, text }) => (
              <div key={text}>
                <Icon size={17} />
                <span>{text}</span>
              </div>
            ))}
          </aside>
        </div>
        <section className="rm-list-section">
          <div className="rm-section-row">
            <div>
              <span>Application history</span>
              <h2>Your financing requests</h2>
            </div>
            <strong>{applications.length}</strong>
          </div>
          {applications.length === 0 ? (
            <EmptyState
              icon={<FileText className="h-5 w-5" />}
              title="No applications yet"
              message="Submit a financing request above to see it tracked here."
              action={{
                label: "Start an application",
                onClick: () => document.getElementById("loan-amount")?.focus(),
              }}
            />
          ) : (
            applications.map((application) => (
              <article className="rm-record-row" key={application.id}>
                <div>
                  <FileText size={17} />
                  <span>
                    <strong>{Number(application.amount).toLocaleString()} USDC</strong>
                    <small>{application.id}</small>
                  </span>
                </div>
                <em data-status={application.status.toLowerCase()}>{application.status}</em>
              </article>
            ))
          )}
        </section>
      </div>
    </main>
  );
}

export default function ApplicationPage() {
  return (
    <OptionalWalletProvider>
      <ApplicationPageInner />
    </OptionalWalletProvider>
  );
}
