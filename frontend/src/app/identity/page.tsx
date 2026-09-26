"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { BadgeCheck, FileLock2, Fingerprint, ShieldCheck, Upload } from "lucide-react";
import { OptionalWalletProvider, useWallet } from "@/context/WalletContext";

const Navbar = dynamic(() => import("@/components/Navbar"), { ssr: false });
type Credential = { did: string; didHash: string; verificationMethod: string; verifiedAt: string; isRevoked: boolean };

function IdentityPageInner(){
  const { publicKey, isConnected, connect } = useWallet();
  const [credentials,setCredentials]=useState<Credential[]>([]); const [file,setFile]=useState<File|null>(null); const [busy,setBusy]=useState(false); const [message,setMessage]=useState<string|null>(null);
  useEffect(()=>{if(!publicKey)return; fetch(`/api/identity/credentials?address=${encodeURIComponent(publicKey)}`).then(async r=>r.ok?r.json():null).then(d=>setCredentials(d?.credentials??[])).catch(()=>setCredentials([]));},[publicKey]);
  async function upload(){if(!publicKey||!file)return; setBusy(true);setMessage(null);const form=new FormData();form.append("document",file);try{const r=await fetch(`/api/identity/kyc?address=${encodeURIComponent(publicKey)}`,{method:"POST",body:form});const d=await r.json();if(!r.ok)throw new Error(d.message||d.error);setMessage(`Encrypted document stored: ${d.documentId}`);setFile(null);}catch(e){setMessage(e instanceof Error?e.message:"Upload failed");}finally{setBusy(false)}}
  return <main className="rm-app-page rm-workflow-page min-h-screen"><Navbar/><div className="rm-workflow-shell"><header className="rm-workflow-header"><span>Private borrower identity</span><h1>Identity and KYC</h1><p>Manage encrypted underwriting documents and verifiable borrower credentials without placing private data on-chain.</p></header>
    <div className="rm-identity-band"><div><ShieldCheck size={21}/><span><strong>Envelope encrypted</strong><small>Documents are encrypted before private storage.</small></span></div><div><Fingerprint size={21}/><span><strong>Wallet bound</strong><small>Only the authenticated borrower can upload.</small></span></div><div><BadgeCheck size={21}/><span><strong>Hash anchored</strong><small>Credentials expose proofs, not raw documents.</small></span></div></div>
    <div className="rm-workflow-grid"><section className="rm-workflow-panel"><div className="rm-panel-heading"><FileLock2 size={20}/><div><h2>Upload underwriting document</h2><p>PDF, JPEG or PNG. Maximum size 10MB.</p></div></div>{!isConnected?<button className="rm-action-button" onClick={()=>connect()}>Connect wallet</button>:<div className="rm-upload-control"><label htmlFor="kyc-file"><Upload size={20}/><span>{file?file.name:"Choose a document"}</span></label><input id="kyc-file" type="file" accept="application/pdf,image/jpeg,image/png" onChange={e=>setFile(e.target.files?.[0]??null)}/><button className="rm-action-button" onClick={upload} disabled={!file||busy}>{busy?"Encrypting and uploading…":"Upload securely"}</button></div>}{message&&<div className="rm-inline-message" role="status">{message}</div>}</section>
      <section className="rm-workflow-panel"><div className="rm-panel-heading"><Fingerprint size={20}/><div><h2>Verified credentials</h2><p>DID credentials associated with the connected applicant.</p></div></div>{credentials.length===0?<div className="rm-empty-row">No verified credentials found.</div>:credentials.map(c=><article className="rm-credential" key={c.did}><BadgeCheck size={18}/><div><strong>{c.did}</strong><small>{c.verificationMethod} · {new Date(c.verifiedAt).toLocaleDateString()}</small></div><em>{c.isRevoked?"Revoked":"Active"}</em></article>)}</section></div>
  </div></main>;
}
export default function IdentityPage(){return <OptionalWalletProvider><IdentityPageInner/></OptionalWalletProvider>}
