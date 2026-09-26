"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import dynamic from "next/dynamic";
import Link from "next/link";
import { Activity, Landmark, LockKeyhole, Shield, Vault } from "lucide-react";

const Navbar = dynamic(() => import("@/components/Navbar"), { ssr: false });
const modules=[
  {name:"Escrow",description:"Borrower deposits, withdrawals, release rules and penalty tiers.",configured:Boolean(process.env.NEXT_PUBLIC_ESCROW_CONTRACT_ID),href:"/dashboard",icon:LockKeyhole,core:true},
  {name:"Lending pool",description:"Investor tranches, loan approvals, disbursement and repayment.",configured:Boolean(process.env.NEXT_PUBLIC_LENDING_POOL_CONTRACT_ID),href:"/invest",icon:Landmark,core:true},
  {name:"Milestones",description:"Evidence-backed proposals, voting, disputes and releases.",configured:Boolean(process.env.NEXT_PUBLIC_MILESTONE_CONTRACT_ID),href:"/governance",icon:Activity,core:true},
  {name:"Verification registry",description:"Eligibility hashes, borrower scores and dynamic rate tiers.",configured:Boolean(process.env.NEXT_PUBLIC_VERIFICATION_REGISTRY_CONTRACT_ID),href:"/verify",icon:Shield,core:true},
  {name:"Insurance pool",description:"Premium reserves and default recovery coverage.",configured:Boolean(process.env.NEXT_PUBLIC_INSURANCE_POOL_CONTRACT_ID),href:null,icon:Shield,core:false},
  {name:"Staking and yield vaults",description:"Optional protocol rewards and pooled yield strategies.",configured:Boolean(process.env.NEXT_PUBLIC_STAKING_POOL_CONTRACT_ID),href:null,icon:Vault,core:false},
] as const;
export default function ProtocolPage(){return <main className="rm-app-page rm-workflow-page min-h-screen"><Navbar/><div className="rm-workflow-shell"><header className="rm-workflow-header"><span>Deployment registry</span><h1>Protocol modules</h1><p>See which contract capabilities have a complete frontend workflow and which optional modules still require deployment configuration and client adapters.</p></header><div className="rm-module-grid">{modules.map(({name,description,configured,href,icon:Icon,core})=><article key={name}><div className="rm-module-icon"><Icon size={20}/></div><div className="rm-module-title"><h2>{name}</h2><em data-ready={configured}>{configured?"Configured":core?"Configuration required":"Adapter pending"}</em></div><p>{description}</p>{href?<Link href={href}>Open workflow</Link>:<span className="rm-muted-action">Not exposed for transactions</span>}</article>)}</div></div></main>}
