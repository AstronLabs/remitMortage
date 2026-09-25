// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import Link from "next/link";
import { ArrowUpRight, Code2, ShieldCheck } from "lucide-react";
import { useTranslations } from "next-intl";

const protocolLinks = [
  ["/verify", "remittanceVerification"],
  ["/dashboard", "downPaymentEscrow"],
  ["/invest", "defiLendingPool"],
  ["/repay", "mortgageRepayments"],
  ["/analytics", "protocolAnalytics"],
] as const;

const operationsLinks = [
  ["/contractor", "contractorEvidenceHub"],
  ["/governance", "multisigMilestoneApproval"],
  ["/history", "onChainAuditTrail"],
  ["/gas-optimization", "Gas optimizer"],
] as const;

export default function Footer() {
  const t = useTranslations("footer");
  return (
    <footer role="contentinfo" className="rm-footer">
      <div className="rm-footer-inner">
        <div className="rm-footer-grid">
          <div className="rm-footer-brand">
            <Link href="/" className="rm-footer-logo"><span className="rm-footer-mark">R</span><span>Remit<strong>Mortgage</strong></span></Link>
            <p>Transparent property financing for diaspora communities, settled in USDC on Stellar.</p>
            <span className="rm-footer-network"><span /> Stellar Testnet · Online</span>
          </div>
          <div>
            <h2>{t("protocol")}</h2>
            <nav className="rm-footer-links" aria-label="Protocol links">
              {protocolLinks.map(([href, key]) => <Link href={href} key={href}>{key.startsWith("/") ? key : t(key as never)}</Link>)}
            </nav>
          </div>
          <div>
            <h2>{t("governance")}</h2>
            <nav className="rm-footer-links" aria-label="Operations links">
              {operationsLinks.map(([href, key]) => <Link href={href} key={href}>{key.startsWith("/") ? key : key === "Gas optimizer" ? key : t(key as never)}</Link>)}
            </nav>
          </div>
          <div className="rm-footer-ecosystem">
            <h2>{t("ecosystem")}</h2>
            <p>Open infrastructure for verifiable remittance scoring, Soroban escrow, and milestone-governed lending.</p>
            <a href="https://github.com/AstronLabs/remitMortage" target="_blank" rel="noreferrer"><Code2 size={15} /> Source code <ArrowUpRight size={14} /></a>
            <a href="https://developers.stellar.org" target="_blank" rel="noreferrer"><ShieldCheck size={15} /> Stellar developers <ArrowUpRight size={14} /></a>
          </div>
        </div>
        <div className="rm-footer-bottom"><span>© 2026 RemitMortgage Protocol</span><span>Open source · Non-custodial · MIT licensed</span></div>
      </div>
    </footer>
  );
}
