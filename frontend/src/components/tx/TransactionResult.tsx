"use client";

import { getTransactionExplorerLinks } from "../../lib/transaction-status";

interface TransactionResultProps {
  hash: string;
  success: boolean;
  contractError?: string | null;
  onReturnToDashboard?: () => void;
}

export default function TransactionResult({
  hash,
  success,
  contractError,
  onReturnToDashboard,
}: TransactionResultProps) {
  return (
    <div
      className={`rounded-xl border p-8 text-center animate-fade-in-up ${
        success
          ? "bg-emerald-500/5 border-emerald-500/30"
          : "bg-red-500/5 border-red-500/30"
      }`}
    >
      <div className="flex justify-center mb-5">
        {success ? (
          <div className="w-20 h-20 rounded-full bg-emerald-500/15 flex items-center justify-center">
            <svg
              className="w-10 h-10 text-emerald-400 tx-checkmark"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2.5}
            >
              <path
                className="tx-checkmark-path"
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M5 13l4 4L19 7"
              />
            </svg>
          </div>
        ) : (
          <div className="w-20 h-20 rounded-full bg-red-500/15 flex items-center justify-center tx-cross-animate">
            <svg
              className="w-10 h-10 text-red-400"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2.5}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </div>
        )}
      </div>

      <h2 className={`text-2xl font-bold mb-2 ${success ? "text-emerald-400" : "text-red-400"}`}>
        {success ? "Transaction Confirmed" : "Transaction Failed"}
      </h2>

      <p className="text-[var(--text-secondary)] text-sm mb-4 max-w-md mx-auto">
        {success
          ? "Your transaction has been confirmed on the Stellar network."
          : "The transaction was reverted by the smart contract."}
      </p>

      {!success && contractError && (
        <div
          role="alert"
          className="mb-5 mx-auto max-w-lg text-left bg-red-500/10 border border-red-500/25 rounded-lg px-4 py-3"
        >
          <p className="text-xs font-semibold uppercase tracking-wider text-red-400/80 mb-1">
            Contract Error
          </p>
          <p className="text-sm text-red-300 font-mono break-words">{contractError}</p>
        </div>
      )}

      <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
        {getTransactionExplorerLinks(hash).map((link) => (
          <a
            key={link.label}
            href={link.href}
            target="_blank"
            rel="noopener noreferrer"
            className="btn-outline !py-2.5 !px-5 !text-sm"
          >
            {link.label}
          </a>
        ))}
        {success && onReturnToDashboard && (
          <button onClick={onReturnToDashboard} className="btn-primary !py-2.5 !px-5 !text-sm">
            Return to Dashboard
          </button>
        )}
      </div>
    </div>
  );
}
