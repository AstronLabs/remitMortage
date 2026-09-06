"use client";

import React, { useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import toast, { Toaster } from "react-hot-toast";
import { useWallet, OptionalWalletProvider } from "../../context/WalletContext";
import { EmptyState } from "../../components/EmptyState";
import { ClipboardList, Hammer, History } from "lucide-react";

const Navbar = dynamic(() => import("../../components/Navbar"), { ssr: false });
import ActiveLoansMapView from "../../components/ActiveLoansMapView";
import AuditLogViewer from "../../components/AuditLogViewer";
import LoanCommentsPanel from "../../components/LoanCommentsPanel";

// The admin wallet authorized to approve loans and milestones. Configured via
// NEXT_PUBLIC_ADMIN_ADDRESS at build time.
const ADMIN_ADDRESS = process.env.NEXT_PUBLIC_ADMIN_ADDRESS ?? "";

// ── Types ────────────────────────────────────────────────────────────────────

interface PendingLoan {
  id: string;
  borrower: string;
  principal: number;
  verificationScore: number;
}

interface MilestoneReview {
  id: string;
  loanId: string;
  contractor: string;
  amount: number;
  evidenceCid: string;
}

interface PoolOverview {
  totalLiquidity: number;
  activeLoans: number;
  totalDisbursed: number;
  totalRepaid: number;
}

type PendingAction =
  | { kind: "approve-loan"; loan: PendingLoan }
  | { kind: "reject-loan"; loan: PendingLoan }
  | { kind: "approve-milestone"; milestone: MilestoneReview };

// ── Helpers ──────────────────────────────────────────────────────────────────

function shortenAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function formatUsdc(amount: number): string {
  return `$${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const IPFS_GATEWAY = "https://ipfs.io/ipfs/";

// ── Page ─────────────────────────────────────────────────────────────────────

export default function AdminPage() {
  return (
    <OptionalWalletProvider>
      <AdminPageInner />
    </OptionalWalletProvider>
  );
}

function AdminPageInner() {
  const { publicKey, isConnected, connect } = useWallet();
  const isAdmin = isConnected && !!publicKey && publicKey === ADMIN_ADDRESS;

  if (!isConnected) {
    return (
      <AdminShell>
        <div className="text-center py-16">
          <p className="text-sm text-[var(--text-secondary)] mb-4">
            Connect the admin wallet to manage loan approvals and milestone disbursements.
          </p>
          <button onClick={() => connect()} className="btn-primary !py-2.5 !px-5">
            Connect Wallet
          </button>
        </div>
      </AdminShell>
    );
  }

  if (!isAdmin) {
    return (
      <AdminShell>
        <div
          role="alert"
          className="max-w-md mx-auto text-center py-16 px-6 rounded-lg border border-red-500/40 bg-red-500/10"
        >
          <p className="text-lg font-bold text-red-400 mb-1">Unauthorized — Admin access only</p>
          <p className="text-sm text-[var(--text-secondary)]">
            The connected wallet is not the configured protocol administrator.
          </p>
        </div>
      </AdminShell>
    );
  }

  return (
    <AdminShell>
      <AdminDashboard />
    </AdminShell>
  );
}

function AdminShell({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <Navbar />
      <Toaster position="top-right" />
      <main className="max-w-5xl mx-auto px-6 py-24">
        <div className="mb-8">
          <h1 className="text-3xl font-bold mb-2">Admin Panel</h1>
          <p className="text-[var(--text-secondary)]">
            Review pending loan requests and milestone disbursements.
          </p>
        </div>
        {children}
      </main>
    </div>
  );
}

// ── Dashboard ────────────────────────────────────────────────────────────────

type Tab = "loans" | "milestones" | "audit";

function AdminDashboard() {
  const [tab, setTab] = useState<Tab>("loans");
  const [loans, setLoans] = useState<PendingLoan[]>([]);
  const [milestones, setMilestones] = useState<MilestoneReview[]>([]);
  const [overview, setOverview] = useState<PoolOverview | null>(null);
  const [loading, setLoading] = useState(false);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      // Placeholder data. Swap for the Soroban query layer once wired:
      //   pool.get_pending_loans(), milestone.get_pending(), pool overview.
      await new Promise((resolve) => setTimeout(resolve, 400));
      setLoans([
        {
          id: "loan-1",
          borrower: "GBORROWER1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          principal: 70000,
          verificationScore: 82,
        },
        {
          id: "loan-2",
          borrower: "GBORROWER2BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
          principal: 45000,
          verificationScore: 67,
        },
      ]);
      setMilestones([
        {
          id: "ms-1",
          loanId: "loan-3",
          contractor: "GCONTRACTOR1CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
          amount: 25000,
          evidenceCid: "QmExampleEvidenceCid1111111111111111111111111111",
        },
      ]);
      setOverview({
        totalLiquidity: 1_250_000,
        activeLoans: 3,
        totalDisbursed: 410_000,
        totalRepaid: 138_400,
      });
    } catch {
      toast.error("Failed to load admin data.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  async function confirmAction() {
    if (!pendingAction) return;
    setSubmitting(true);
    try {
      // TODO: build and submit the matching Soroban transaction via Freighter.
      await new Promise((resolve) => setTimeout(resolve, 900));

      if (pendingAction.kind === "approve-loan") {
        toast.success("Loan approved.");
      } else if (pendingAction.kind === "reject-loan") {
        toast.success("Loan rejected.");
      } else {
        toast.success("Milestone disbursement approved.");
      }

      setPendingAction(null);
      // Real-time refresh once the transaction confirms.
      await loadData();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Transaction failed.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-8">
      <PoolOverviewCard overview={overview} loading={loading} />

      <ActiveLoansMapView />

      <div className="flex gap-2 border-b border-[var(--border-color)]">
        <TabButton active={tab === "loans"} onClick={() => setTab("loans")}>
          Pending Loans
          {loans.length > 0 && <Count value={loans.length} />}
        </TabButton>
        <TabButton active={tab === "milestones"} onClick={() => setTab("milestones")}>
          Milestone Reviews
          {milestones.length > 0 && <Count value={milestones.length} />}
        </TabButton>
        <TabButton active={tab === "audit"} onClick={() => setTab("audit")}>
          <History className="h-3.5 w-3.5 mr-1.5" />
          Audit Log
        </TabButton>
      </div>

      {tab === "loans" ? (
        <PendingLoansTab
          loans={loans}
          loading={loading}
          onApprove={(loan) => setPendingAction({ kind: "approve-loan", loan })}
          onReject={(loan) => setPendingAction({ kind: "reject-loan", loan })}
        />
      ) : tab === "milestones" ? (
        <MilestoneReviewsTab
          milestones={milestones}
          loading={loading}
          onApprove={(milestone) => setPendingAction({ kind: "approve-milestone", milestone })}
        />
      ) : (
        <AuditLogViewer />
      )}

      {pendingAction && (
        <ConfirmationModal
          action={pendingAction}
          submitting={submitting}
          onConfirm={confirmAction}
          onCancel={() => (submitting ? undefined : setPendingAction(null))}
        />
      )}
    </div>
  );
}

function Count({ value }: { value: number }) {
  return (
    <span className="ml-2 inline-flex items-center justify-center min-w-5 h-5 px-1.5 rounded-full bg-[var(--accent-primary)] text-white text-xs">
      {value}
    </span>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-2.5 text-sm font-medium -mb-px border-b-2 transition-colors ${
        active
          ? "border-[var(--accent-primary)] text-[var(--text-primary)]"
          : "border-transparent text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
      }`}
    >
      {children}
    </button>
  );
}

// ── Pool Overview ────────────────────────────────────────────────────────────

function PoolOverviewCard({
  overview,
  loading,
}: {
  overview: PoolOverview | null;
  loading: boolean;
}) {
  const cards = [
    { label: "Total Liquidity", value: overview ? formatUsdc(overview.totalLiquidity) : "—" },
    { label: "Active Loans", value: overview ? String(overview.activeLoans) : "—" },
    { label: "Total Disbursed", value: overview ? formatUsdc(overview.totalDisbursed) : "—" },
    { label: "Total Repaid", value: overview ? formatUsdc(overview.totalRepaid) : "—" },
  ];
  return (
    <section aria-label="Pool overview" className="grid grid-cols-2 md:grid-cols-4 gap-4">
      {cards.map((card) => (
        <div
          key={card.label}
          className={`p-5 bg-[var(--bg-card)] rounded-lg border border-[var(--border-color)] ${
            loading ? "animate-pulse" : ""
          }`}
        >
          <p className="text-xs text-[var(--text-muted)] mb-1">{card.label}</p>
          <p className="text-2xl font-bold">{card.value}</p>
        </div>
      ))}
    </section>
  );
}

// ── Pending Loans ────────────────────────────────────────────────────────────

function PendingLoansTab({
  loans,
  loading,
  onApprove,
  onReject,
}: {
  loans: PendingLoan[];
  loading: boolean;
  onApprove: (loan: PendingLoan) => void;
  onReject: (loan: PendingLoan) => void;
}) {
  const { publicKey } = useWallet();
  const [expandedLoanId, setExpandedLoanId] = useState<string | null>(null);
  if (loading) return <EmptyRow text="Loading pending loans…" />;
  if (loans.length === 0) {
    return (
      <EmptyState
        icon={<ClipboardList className="h-5 w-5" />}
        title="No loan requests awaiting review"
        message="New borrower applications will appear here once submitted."
        action={{ label: "View pool overview", href: "/stats" }}
      />
    );
  }

  return (
    <div className="space-y-3">
      {loans.map((loan) => (
        <div
          key={loan.id}
          className="p-4 bg-[var(--bg-card)] rounded-lg border border-[var(--border-color)]"
        >
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-1">
              <div>
                <p className="text-xs text-[var(--text-muted)]">Borrower</p>
                <p className="text-sm font-mono">{shortenAddress(loan.borrower)}</p>
              </div>
              <div>
                <p className="text-xs text-[var(--text-muted)]">Principal</p>
                <p className="text-sm font-semibold">{formatUsdc(loan.principal)}</p>
              </div>
              <div>
                <p className="text-xs text-[var(--text-muted)]">Verification Score</p>
                <p className="text-sm font-semibold">
                  <ScoreBadge score={loan.verificationScore} />
                </p>
              </div>
            </div>
            <div className="flex gap-2 shrink-0">
              <button
                onClick={() => setExpandedLoanId(expandedLoanId === loan.id ? null : loan.id)}
                className="px-3 py-2 rounded-lg text-sm font-medium bg-sky-500/10 text-sky-400 border border-sky-500/30 hover:bg-sky-500/20 transition-colors"
              >
                {expandedLoanId === loan.id ? "Hide Discussion" : "Discuss"}
              </button>
              <button
                onClick={() => onApprove(loan)}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 hover:bg-emerald-500/25 transition-colors"
              >
                Approve
              </button>
              <button
                onClick={() => onReject(loan)}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-red-500/10 text-red-400 border border-red-500/30 hover:bg-red-500/20 transition-colors"
              >
                Reject
              </button>
            </div>
          </div>
          {expandedLoanId === loan.id && publicKey && (
            <LoanCommentsPanel loanApplicationId={loan.id} currentUserAddress={publicKey} />
          )}
        </div>
      ))}
    </div>
  );
}

function ScoreBadge({ score }: { score: number }) {
  const color = score >= 75 ? "text-emerald-400" : score >= 50 ? "text-amber-400" : "text-red-400";
  return <span className={color}>{score}/100</span>;
}

// ── Milestone Reviews ────────────────────────────────────────────────────────

function MilestoneReviewsTab({
  milestones,
  loading,
  onApprove,
}: {
  milestones: MilestoneReview[];
  loading: boolean;
  onApprove: (milestone: MilestoneReview) => void;
}) {
  if (loading) return <EmptyRow text="Loading milestone reviews…" />;
  if (milestones.length === 0) {
    return (
      <EmptyState
        icon={<Hammer className="h-5 w-5" />}
        title="No milestones awaiting disbursement"
        message="Contractor milestone submissions will appear here once evidence is uploaded."
        action={{ label: "View pool overview", href: "/stats" }}
      />
    );
  }

  return (
    <div className="space-y-3">
      {milestones.map((milestone) => (
        <div
          key={milestone.id}
          className="flex flex-col md:flex-row md:items-center justify-between gap-4 p-4 bg-[var(--bg-card)] rounded-lg border border-[var(--border-color)]"
        >
          <div className="flex flex-wrap items-center gap-x-6 gap-y-1">
            <div>
              <p className="text-xs text-[var(--text-muted)]">Contractor</p>
              <p className="text-sm font-mono">{shortenAddress(milestone.contractor)}</p>
            </div>
            <div>
              <p className="text-xs text-[var(--text-muted)]">Requested</p>
              <p className="text-sm font-semibold">{formatUsdc(milestone.amount)}</p>
            </div>
            <div>
              <p className="text-xs text-[var(--text-muted)]">Evidence</p>
              <a
                href={`${IPFS_GATEWAY}${milestone.evidenceCid}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-[var(--accent-primary-light)] hover:underline"
              >
                View on IPFS ↗
              </a>
            </div>
          </div>
          <div className="shrink-0">
            <button
              onClick={() => onApprove(milestone)}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 hover:bg-emerald-500/25 transition-colors"
            >
              Approve Disbursement
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyRow({ text }: { text: string }) {
  return (
    <div className="p-8 text-center text-sm text-[var(--text-muted)] bg-[var(--bg-card)] rounded-lg border border-[var(--border-color)]">
      {text}
    </div>
  );
}

// ── Confirmation Modal ───────────────────────────────────────────────────────

function ConfirmationModal({
  action,
  submitting,
  onConfirm,
  onCancel,
}: {
  action: PendingAction;
  submitting: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const details = describeAction(action);
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4"
      role="dialog"
      aria-modal="true"
      aria-label="Confirm transaction"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-md rounded-xl bg-[var(--bg-secondary)] border border-[var(--border-color)] p-6"
        style={{ animation: "modal-pop 0.2s ease-out" }}
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="text-lg font-bold mb-1">{details.title}</h2>
        <p className="text-sm text-[var(--text-secondary)] mb-4">{details.summary}</p>

        <dl className="space-y-2 mb-6 text-sm">
          {details.rows.map((row) => (
            <div key={row.label} className="flex justify-between gap-4">
              <dt className="text-[var(--text-muted)]">{row.label}</dt>
              <dd className="font-medium text-right break-all">{row.value}</dd>
            </div>
          ))}
        </dl>

        <div className="flex gap-3">
          <button
            onClick={onCancel}
            disabled={submitting}
            className="flex-1 py-2.5 rounded-lg border border-[var(--border-color)] text-sm font-medium hover:bg-[var(--bg-card)] transition-colors disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={submitting}
            className="btn-primary flex-1 !py-2.5"
            aria-busy={submitting}
          >
            {submitting ? "Signing…" : "Sign with Freighter"}
          </button>
        </div>
      </div>
    </div>
  );
}

function describeAction(action: PendingAction): {
  title: string;
  summary: string;
  rows: { label: string; value: string }[];
} {
  if (action.kind === "approve-milestone") {
    const { milestone } = action;
    return {
      title: "Approve Milestone Disbursement",
      summary: "Release the requested funds to the whitelisted contractor.",
      rows: [
        { label: "Loan", value: milestone.loanId },
        { label: "Contractor", value: shortenAddress(milestone.contractor) },
        { label: "Amount", value: formatUsdc(milestone.amount) },
      ],
    };
  }

  const { loan, kind } = action;
  const approving = kind === "approve-loan";
  return {
    title: approving ? "Approve Loan Request" : "Reject Loan Request",
    summary: approving
      ? "Commit pool liquidity and move this loan to Approved."
      : "Decline this loan request. No funds will be committed.",
    rows: [
      { label: "Borrower", value: shortenAddress(loan.borrower) },
      { label: "Principal", value: formatUsdc(loan.principal) },
      { label: "Verification", value: `${loan.verificationScore}/100` },
    ],
  };
}
