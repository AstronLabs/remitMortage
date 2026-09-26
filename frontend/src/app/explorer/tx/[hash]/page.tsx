// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { notFound } from "next/navigation";
import Navbar from "@/components/Navbar";
import ExplorerTransactionDetails from "@/components/explorer/ExplorerTransactionDetails";
import { fetchTransaction } from "@/lib/explorerTransactions";

// ISR: this route is statically rendered and cached, then regenerated in
// the background at most once every 60 seconds — Horizon updates (e.g. a
// transaction's ledger being confirmed) show up on the next regeneration
// without a client-side round trip on every visit.
export const revalidate = 60;

// No fixed hash list is known at build time; pages are generated on first
// request (on-demand ISR) and cached/revalidated per `revalidate` above.
export async function generateStaticParams() {
  return [];
}

export default async function ExplorerTransactionPage({
  params,
}: {
  params: Promise<{ hash: string }>;
}) {
  const { hash } = await params;
  const transaction = await fetchTransaction(hash);

  if (!transaction) {
    notFound();
  }

  return (
    <div className="min-h-screen bg-[var(--bg-primary)]">
      <Navbar />
      <main className="max-w-3xl mx-auto px-6 py-24">
        <ExplorerTransactionDetails transaction={transaction} />
      </main>
    </div>
  );
}
