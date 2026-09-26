"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import Link from "next/link";
import dynamic from "next/dynamic";
import {
  ArrowRight, BadgeCheck, Banknote, Building2, Check, CircleDollarSign,
  Clock3, FileCheck2, Landmark, LockKeyhole, ShieldCheck, Sparkles,
  TrendingUp, WalletCards,
} from "lucide-react";

const Navbar = dynamic(() => import("../components/Navbar"), { ssr: false });

const journey = [
  { icon: BadgeCheck, step: "01", title: "Verify remittance history", text: "Sign once with your wallet. The scoring service reviews recurring Stellar payments without exposing private financial data on-chain." },
  { icon: WalletCards, step: "02", title: "Build your deposit", text: "Save toward the 30% deposit in a non-custodial Soroban escrow, with every contribution visible and independently auditable." },
  { icon: Landmark, step: "03", title: "Secure pool financing", text: "Eligible borrowers request the remaining 70% from the lending pool at a transparent rate derived from their verified tier." },
  { icon: Building2, step: "04", title: "Release by milestone", text: "Vetted contractors receive funds only after evidence is submitted to IPFS and the governance threshold is reached." },
  { icon: CircleDollarSign, step: "05", title: "Repay in USDC", text: "Track principal, interest, and upcoming payments in one place while settlement completes on Stellar in seconds." },
];

const safeguards = [
  { icon: LockKeyhole, title: "Non-custodial", text: "You authorize every asset movement from your own wallet." },
  { icon: FileCheck2, title: "Evidence-gated", text: "Construction releases require verifiable milestone proof." },
  { icon: ShieldCheck, title: "Governed", text: "Multisig approval protects borrower and pool capital." },
];

function ProgressRing() {
  return (
    <div className="rm-progress-ring" aria-label="Deposit is 68 percent funded">
      <svg viewBox="0 0 120 120" aria-hidden="true">
        <circle className="rm-ring-track" cx="60" cy="60" r="50" />
        <circle className="rm-ring-value" cx="60" cy="60" r="50" />
      </svg>
      <div><strong>68%</strong><span>funded</span></div>
    </div>
  );
}

export default function HomePage() {
  return (
    <main className="rm-home">
      <Navbar />
      <section className="rm-hero">
        <div className="rm-shell rm-hero-grid">
          <div className="rm-hero-copy">
            <div className="rm-eyebrow"><span className="rm-status-dot" />Built on Stellar and Soroban</div>
            <h1>RemitMortgage</h1>
            <p className="rm-hero-lead">Turn a proven remittance history into transparent property financing, from your first escrow deposit to the final construction milestone.</p>
            <div className="rm-hero-actions">
              <Link href="/onboarding" className="rm-button rm-button-primary">Check your eligibility <ArrowRight size={17} /></Link>
              <Link href="/dashboard" className="rm-button rm-button-secondary">Open dashboard</Link>
            </div>
            <div className="rm-trust-row">
              <span><Check size={15} /> No bank credit file required</span>
              <span><Check size={15} /> USDC settlement</span>
              <span><Check size={15} /> Wallet controlled</span>
            </div>
          </div>
          <div className="rm-workspace" aria-label="Borrower financing overview preview">
            <div className="rm-workspace-head">
              <div><span className="rm-kicker">My property plan</span><h2>Accra family home</h2></div>
              <span className="rm-live"><span /> On track</span>
            </div>
            <div className="rm-overview">
              <ProgressRing />
              <div className="rm-overview-copy"><span>Escrow balance</span><strong>20,400 <small>USDC</small></strong><p>9,600 USDC remaining to unlock financing</p></div>
            </div>
            <div className="rm-metric-grid">
              <div><span>Property value</span><strong>$100,000</strong></div>
              <div><span>Financing rate</span><strong>4.5% APR</strong></div>
              <div><span>Credit tier</span><strong className="rm-positive">Excellent</strong></div>
            </div>
            <div className="rm-next-action">
              <div className="rm-icon-box"><Banknote size={19} /></div>
              <div><span>Next contribution</span><strong>1,200 USDC</strong></div>
              <div className="rm-action-date"><Clock3 size={14} /> Aug 28</div>
            </div>
            <div className="rm-workspace-foot"><span><span className="rm-network-dot" /> Stellar Testnet</span><span>Last synced 12 sec ago</span></div>
          </div>
        </div>
      </section>

      <section className="rm-proof-band" aria-label="Protocol highlights">
        <div className="rm-shell rm-proof-grid">
          <div><strong>3–5 sec</strong><span>Stellar settlement</span></div>
          <div><strong>30 / 70</strong><span>Deposit to financing</span></div>
          <div><strong>USDC</strong><span>Stable settlement asset</span></div>
          <div><strong>On-chain</strong><span>Escrow and loan records</span></div>
        </div>
      </section>

      <section className="rm-section">
        <div className="rm-shell">
          <div className="rm-section-heading"><span className="rm-kicker">One connected journey</span><h2>From remittance record to a finished home</h2><p>Each stage maps directly to the protocol’s backend services and smart-contract controls.</p></div>
          <div className="rm-journey">
            {journey.map(({ icon: Icon, step, title, text }) => (
              <article className="rm-journey-item" key={step}><div className="rm-journey-icon"><Icon size={20} /></div><span className="rm-step">STEP {step}</span><h3>{title}</h3><p>{text}</p></article>
            ))}
          </div>
        </div>
      </section>

      <section className="rm-section rm-section-muted">
        <div className="rm-shell rm-capital-grid">
          <div className="rm-capital-copy"><span className="rm-kicker">Capital with accountability</span><h2>Construction funding follows verified progress.</h2><p>Funds do not disappear into a black box. Contractors submit milestone evidence, reviewers approve it through multisig governance, and the lending pool releases only the authorized tranche.</p><Link href="/governance" className="rm-text-link">Explore governance <ArrowRight size={16} /></Link></div>
          <div className="rm-milestone-panel">
            <div className="rm-panel-title"><div><span className="rm-kicker">Construction progress</span><h3>Milestone release schedule</h3></div><span className="rm-percent">42%</span></div>
            <div className="rm-progress-bar"><span /></div>
            <div className="rm-milestone-list">
              <div className="complete"><Check size={15} /><span><strong>Foundation</strong><small>Evidence approved · 18,000 USDC</small></span><BadgeCheck size={18} /></div>
              <div className="active"><Sparkles size={15} /><span><strong>Structural frame</strong><small>Voting in progress · 3 of 4 signatures</small></span><em>75%</em></div>
              <div><Clock3 size={15} /><span><strong>Roofing and utilities</strong><small>Scheduled after frame approval</small></span><em>Next</em></div>
              <div><Clock3 size={15} /><span><strong>Finishing and occupancy</strong><small>Awaiting previous milestones</small></span><em>Later</em></div>
            </div>
          </div>
        </div>
      </section>

      <section className="rm-section">
        <div className="rm-shell">
          <div className="rm-section-heading rm-section-heading-left"><span className="rm-kicker">Protection at every layer</span><h2>Designed for trust, not promises.</h2></div>
          <div className="rm-safeguards">
            {safeguards.map(({ icon: Icon, title, text }) => <div className="rm-safeguard" key={title}><Icon size={21} /><div><h3>{title}</h3><p>{text}</p></div></div>)}
          </div>
          <div className="rm-final-cta"><div><span className="rm-kicker">Your history can open the door</span><h2>See what your remittances can finance.</h2></div><Link href="/verify" className="rm-button rm-button-light">Verify remittances <TrendingUp size={17} /></Link></div>
        </div>
      </section>
    </main>
  );
}
