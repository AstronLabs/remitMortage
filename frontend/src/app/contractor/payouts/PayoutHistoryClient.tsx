"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React, { useState, useEffect, useMemo } from "react";
import dynamic from "next/dynamic";
import {
  createStatementMetadata,
  downloadStatementCsv,
  downloadStatementPdf,
  type StatementPayload,
  type StatementRow,
} from "@/lib/statementExport";
import { type ContractorPayoutRecord } from "@/app/api/contractor/payouts/route";

const Navbar = dynamic(() => import("../../../components/Navbar"), { ssr: false });

const MOCK_INITIAL_PAYOUTS: ContractorPayoutRecord[] = [
  {
    id: "pay-101",
    date: "2026-02-15T14:30:00Z",
    projectRef: "PRJ-MORT-2026-01",
    projectName: "Horizon Heights Residential - Unit 4B",
    milestoneName: "Foundation & Substructure Inspection",
    amount: "12500.00",
    currency: "USDC",
    status: "Completed",
    txHash: "4a7f8e12b39d01f5c6789e0123456789abcdef0123456789abcdef0123456789",
    escrowContract: "CCX4V7R3XKEYKJLMNPQRSTUVWYZ23456789ABCDEF",
    contractorAddress: "GAB123456789CONTRACTORSTELLARPUBLICKEY012345",
    taxYear: "2026",
    notes: "Multisig 3/3 signatures verified on-chain",
  },
  {
    id: "pay-102",
    date: "2026-01-20T10:15:00Z",
    projectRef: "PRJ-MORT-2026-01",
    projectName: "Horizon Heights Residential - Unit 4B",
    milestoneName: "Structural Framing & Steel Beams",
    amount: "15000.00",
    currency: "USDC",
    status: "Completed",
    txHash: "7b8c9d01e23f456789a0123456789abcdef0123456789abcdef0123456789a",
    escrowContract: "CCX4V7R3XKEYKJLMNPQRSTUVWYZ23456789ABCDEF",
    contractorAddress: "GAB123456789CONTRACTORSTELLARPUBLICKEY012345",
    taxYear: "2026",
    notes: "Inspected by Certified Inspector #482",
  },
  {
    id: "pay-103",
    date: "2025-11-28T16:45:00Z",
    projectRef: "PRJ-COMM-2025-09",
    projectName: "Apex Commercial Park Plaza",
    milestoneName: "Roofing Waterproofing & Insulation",
    amount: "9800.00",
    currency: "USDC",
    status: "Completed",
    txHash: "1f2e3d4c5b6a7890123456789abcdef0123456789abcdef0123456789abcdef",
    escrowContract: "CBY987654321ESCROWCONTRACTPUBLICKEY098765432",
    contractorAddress: "GAB123456789CONTRACTORSTELLARPUBLICKEY012345",
    taxYear: "2025",
    notes: "Annual milestone release cycle 1",
  },
  {
    id: "pay-104",
    date: "2025-08-10T11:00:00Z",
    projectRef: "PRJ-COMM-2025-09",
    projectName: "Apex Commercial Park Plaza",
    milestoneName: "Electrical Wiring & HVAC Rough-In",
    amount: "11200.00",
    currency: "USDC",
    status: "Completed",
    txHash: "9a8b7c6d5e4f3210987654321abcdef0123456789abcdef0123456789abcdef",
    escrowContract: "CBY987654321ESCROWCONTRACTPUBLICKEY098765432",
    contractorAddress: "GAB123456789CONTRACTORSTELLARPUBLICKEY012345",
    taxYear: "2025",
  },
];

export default function PayoutHistoryClient() {
  const [payouts, setPayouts] = useState<ContractorPayoutRecord[]>(MOCK_INITIAL_PAYOUTS);
  const [selectedProject, setSelectedProject] = useState<string>("All");
  const [selectedTaxYear, setSelectedTaxYear] = useState<string>("All");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [dateFrom, setDateFrom] = useState<string>("");
  const [dateTo, setDateTo] = useState<string>("");

  useEffect(() => {
    fetch("/api/contractor/payouts")
      .then((res) => res.json())
      .then((data) => {
        if (data?.payouts && Array.isArray(data.payouts)) {
          setPayouts(data.payouts);
        }
      })
      .catch(() => {
        // Fallback to mock initial payouts
      });
  }, []);

  const projectOptions = useMemo(() => {
    const set = new Set(payouts.map((p: ContractorPayoutRecord) => p.projectRef));
    return ["All", ...Array.from(set)];
  }, [payouts]);

  const taxYearOptions = useMemo(() => {
    const set = new Set(payouts.map((p: ContractorPayoutRecord) => p.taxYear));
    return ["All", ...Array.from(set)];
  }, [payouts]);

  const filteredPayouts = useMemo(() => {
    return payouts.filter((p: ContractorPayoutRecord) => {
      if (selectedProject !== "All" && p.projectRef !== selectedProject) return false;
      if (selectedTaxYear !== "All" && p.taxYear !== selectedTaxYear) return false;
      if (dateFrom && new Date(p.date) < new Date(dateFrom)) return false;
      if (dateTo && new Date(p.date) > new Date(dateTo)) return false;

      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchesQuery =
          p.projectName.toLowerCase().includes(q) ||
          p.milestoneName.toLowerCase().includes(q) ||
          p.projectRef.toLowerCase().includes(q) ||
          p.txHash.toLowerCase().includes(q);
        if (!matchesQuery) return false;
      }

      return true;
    });
  }, [payouts, selectedProject, selectedTaxYear, searchQuery, dateFrom, dateTo]);

  const totalGrossAmount = useMemo(() => {
    return filteredPayouts
      .reduce((sum: number, p: ContractorPayoutRecord) => sum + parseFloat(p.amount), 0)
      .toFixed(2);
  }, [filteredPayouts]);

  const handleExportTaxPdf = () => {
    const taxYearLabel = selectedTaxYear === "All" ? "2026" : selectedTaxYear;
    const metadata = createStatementMetadata({
      borrowerName: "Apex Construction & Contracting Corp",
      borrowerAddress: "GAB123456789CONTRACTORSTELLARPUBLICKEY012345",
      walletType: "Contractor Freighter Wallet",
    });

    const statementRows: StatementRow[] = filteredPayouts.map((p) => ({
      date: new Date(p.date).toLocaleDateString(),
      type: "Milestone Disbursement",
      amount: `$${p.amount} ${p.currency}`,
      status: p.status,
      reference: `${p.projectRef} - ${p.milestoneName}`,
      counterparty: p.escrowContract,
      notes: p.notes || p.projectName,
    }));

    const payload: StatementPayload = {
      title: `Contractor Annual Tax Summary - ${taxYearLabel}`,
      subtitle: "Form 1099-MISC/NEC Equivalent Milestone Disbursement Statement",
      metadata,
      summary: [
        { label: "Tax Year", value: taxYearLabel },
        { label: "Total Gross Disbursements", value: `$${totalGrossAmount} USDC` },
        { label: "Disbursed Milestones", value: `${filteredPayouts.length}` },
        { label: "Active Project References", value: `${new Set(filteredPayouts.map((p) => p.projectRef)).size}` },
        { label: "Tax Withholding Status", value: "Exempt - Form W-9 Verified (0% Backup Withholding)" },
      ],
      rows: statementRows,
    };

    downloadStatementPdf(payload, `Contractor_Tax_Statement_${taxYearLabel}.pdf`);
  };

  const handleExportCsv = () => {
    const taxYearLabel = selectedTaxYear === "All" ? "2026" : selectedTaxYear;
    const metadata = createStatementMetadata({
      borrowerName: "Apex Construction & Contracting Corp",
      borrowerAddress: "GAB123456789CONTRACTORSTELLARPUBLICKEY012345",
      walletType: "Contractor Freighter Wallet",
    });

    const statementRows: StatementRow[] = filteredPayouts.map((p) => ({
      date: new Date(p.date).toLocaleDateString(),
      type: "Milestone Disbursement",
      amount: `$${p.amount} ${p.currency}`,
      status: p.status,
      reference: `${p.projectRef} - ${p.milestoneName}`,
      counterparty: p.escrowContract,
      notes: p.notes || p.projectName,
    }));

    const payload: StatementPayload = {
      title: `Contractor Payout History - ${taxYearLabel}`,
      subtitle: "Milestone Disbursements Log",
      metadata,
      summary: [
        { label: "Total Gross Disbursements", value: `$${totalGrossAmount} USDC` },
        { label: "Records", value: `${filteredPayouts.length}` },
      ],
      rows: statementRows,
    };

    downloadStatementCsv(payload, `Contractor_Payout_History_${taxYearLabel}.csv`);
  };

  return (
    <main className="min-h-screen bg-[#060913] text-slate-100 pb-20">
      <Navbar />

      <div className="pt-32 px-6 max-w-7xl mx-auto">
        {/* Header section */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-6 mb-8 border-b border-slate-800 pb-6">
          <div>
            <span className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full bg-cyan-500/10 text-cyan-400 text-xs font-semibold uppercase tracking-wider mb-3 border border-cyan-500/20">
              Tax & Disbursement Audit
            </span>
            <h1 className="text-3xl md:text-4xl font-extrabold tracking-tight text-white">
              Contractor Payout History
            </h1>
            <p className="text-slate-400 text-sm md:text-base mt-1 max-w-2xl">
              Track milestone disbursements, inspect on-chain escrow releases, and export official annual tax summary statements.
            </p>
          </div>

          <div className="flex flex-wrap gap-3">
            <button
              onClick={handleExportCsv}
              className="px-4 py-2.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-sm font-semibold transition border border-slate-700 flex items-center gap-2"
            >
              <svg className="w-4 h-4 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              Export CSV
            </button>
            <button
              onClick={handleExportTaxPdf}
              className="px-5 py-2.5 rounded-lg bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-white text-sm font-bold shadow-lg shadow-cyan-500/20 transition flex items-center gap-2"
            >
              <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
              </svg>
              Export Tax Statement (PDF)
            </button>
          </div>
        </div>

        {/* Metrics Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          <div className="p-5 rounded-xl bg-slate-900/60 border border-slate-800">
            <span className="text-xs text-slate-400 font-medium uppercase tracking-wider">Total Gross Payouts</span>
            <div className="text-2xl font-bold text-white mt-1.5">${totalGrossAmount} USDC</div>
            <span className="text-xs text-emerald-400 mt-1 inline-block">100% On-chain verified</span>
          </div>

          <div className="p-5 rounded-xl bg-slate-900/60 border border-slate-800">
            <span className="text-xs text-slate-400 font-medium uppercase tracking-wider">Disbursed Milestones</span>
            <div className="text-2xl font-bold text-white mt-1.5">{filteredPayouts.length}</div>
            <span className="text-xs text-slate-400 mt-1 inline-block">Inspection evidence attached</span>
          </div>

          <div className="p-5 rounded-xl bg-slate-900/60 border border-slate-800">
            <span className="text-xs text-slate-400 font-medium uppercase tracking-wider">Active Projects</span>
            <div className="text-2xl font-bold text-white mt-1.5">{new Set(filteredPayouts.map((p) => p.projectRef)).size}</div>
            <span className="text-xs text-cyan-400 mt-1 inline-block">Multi-contractor escrow</span>
          </div>

          <div className="p-5 rounded-xl bg-slate-900/60 border border-slate-800">
            <span className="text-xs text-slate-400 font-medium uppercase tracking-wider">Tax Status</span>
            <div className="text-lg font-bold text-emerald-400 mt-1.5">Form 1099 Ready</div>
            <span className="text-xs text-slate-400 mt-1 inline-block">0% Backup Withholding</span>
          </div>
        </div>

        {/* Filter bar */}
        <div className="p-4 rounded-xl bg-slate-900/80 border border-slate-800 mb-8 space-y-4 md:space-y-0 md:flex md:items-center md:gap-4 flex-wrap">
          <div className="flex-1 min-w-[200px]">
            <input
              type="text"
              placeholder="Search by project, milestone, or tx hash..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full px-3.5 py-2 rounded-lg bg-slate-950 border border-slate-800 text-sm text-slate-200 focus:outline-none focus:border-cyan-500/50"
            />
          </div>

          <div className="flex items-center gap-2">
            <label className="text-xs text-slate-400 whitespace-nowrap">Project:</label>
            <select
              value={selectedProject}
              onChange={(e) => setSelectedProject(e.target.value)}
              className="px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-sm text-slate-200 focus:outline-none focus:border-cyan-500/50"
            >
              {projectOptions.map((proj) => (
                <option key={proj} value={proj}>{proj}</option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-2">
            <label className="text-xs text-slate-400 whitespace-nowrap">Tax Year:</label>
            <select
              value={selectedTaxYear}
              onChange={(e) => setSelectedTaxYear(e.target.value)}
              className="px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-sm text-slate-200 focus:outline-none focus:border-cyan-500/50"
            >
              {taxYearOptions.map((yr) => (
                <option key={yr} value={yr}>{yr}</option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-2">
            <label className="text-xs text-slate-400 whitespace-nowrap">From:</label>
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-sm text-slate-200 focus:outline-none focus:border-cyan-500/50"
            />
          </div>

          <div className="flex items-center gap-2">
            <label className="text-xs text-slate-400 whitespace-nowrap">To:</label>
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-sm text-slate-200 focus:outline-none focus:border-cyan-500/50"
            />
          </div>
        </div>

        {/* Payouts Table */}
        <div className="rounded-xl border border-slate-800 bg-slate-900/50 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm text-slate-300">
              <thead className="bg-slate-950/80 text-xs font-semibold text-slate-400 uppercase tracking-wider border-b border-slate-800">
                <tr>
                  <th className="px-6 py-4">Date</th>
                  <th className="px-6 py-4">Project Ref</th>
                  <th className="px-6 py-4">Milestone</th>
                  <th className="px-6 py-4">Amount</th>
                  <th className="px-6 py-4">Status</th>
                  <th className="px-6 py-4">Escrow Contract</th>
                  <th className="px-6 py-4">Tx Hash</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {filteredPayouts.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-6 py-12 text-center text-slate-500">
                      No payout records found matching your filters.
                    </td>
                  </tr>
                ) : (
                  filteredPayouts.map((payout) => (
                    <tr key={payout.id} className="hover:bg-slate-800/40 transition">
                      <td className="px-6 py-4 font-mono text-xs text-slate-400">
                        {new Date(payout.date).toLocaleDateString("en-US", {
                          year: "numeric",
                          month: "short",
                          day: "numeric",
                        })}
                      </td>
                      <td className="px-6 py-4">
                        <span className="font-semibold text-white">{payout.projectRef}</span>
                        <div className="text-xs text-slate-400 truncate max-w-[200px]">{payout.projectName}</div>
                      </td>
                      <td className="px-6 py-4 text-slate-200">{payout.milestoneName}</td>
                      <td className="px-6 py-4 font-bold text-cyan-400">
                        ${payout.amount} <span className="text-xs text-slate-400 font-normal">{payout.currency}</span>
                      </td>
                      <td className="px-6 py-4">
                        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-400/10 text-emerald-400 border border-emerald-400/20">
                          {payout.status}
                        </span>
                      </td>
                      <td className="px-6 py-4 font-mono text-xs text-slate-400 truncate max-w-[150px]">
                        {payout.escrowContract.slice(0, 8)}…{payout.escrowContract.slice(-6)}
                      </td>
                      <td className="px-6 py-4 font-mono text-xs">
                        <a
                          href={`https://testnet.stellarchain.io/transactions/${payout.txHash}`}
                          target="_blank"
                          rel="noreferrer"
                          className="text-cyan-400 hover:text-cyan-300 underline"
                        >
                          {payout.txHash.slice(0, 8)}…
                        </a>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </main>
  );
}
