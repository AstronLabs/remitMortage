"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React, { useState } from "react";
import { useToast } from "@/context/ToastContext";

export default function DepositForm({ address }: { address: string }) {
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const { toast } = useToast();

  function validate(): boolean {
    setError(null);
    const n = Number(amount);
    if (Number.isNaN(n) || n <= 0) {
      setError("Amount must be a positive number");
      return false;
    }
    return true;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!validate()) return;

    const ok = confirm(`Confirm deposit of ${amount} USDC to ${address}?`);
    if (!ok) return;

    setSubmitting(true);
    try {
      // No backend deposit endpoint implemented; simulate submission
      await new Promise((r) => setTimeout(r, 800));
      toast({
        variant: "success",
        title: "Deposit simulated",
        message: "Integrate Freighter/send tx to token contract for real deposits.",
      });
      setAmount("");
    } catch (e: any) {
      toast({
        variant: "error",
        title: "Deposit failed",
        message: e?.message || "An unexpected error occurred.",
      });
      setError(e?.message || "Deposit failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="p-6 bg-[var(--bg-card)] rounded-md">
      <h3 className="text-lg font-semibold mb-4">Deposit USDC</h3>

      <div className="flex flex-col gap-2">
        <input
          aria-label="amount"
          placeholder="Amount (USDC)"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          className="p-2 rounded border border-[var(--border-color)] bg-[var(--bg-primary)]"
        />
        {error && <div className="text-sm text-red-600">{error}</div>}
        <button disabled={submitting} className="btn-primary mt-2">
          {submitting ? "Submitting…" : "Deposit"}
        </button>
      </div>
    </form>
  );
}
