"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React, { useEffect } from "react";
import { X, FileText } from "lucide-react";
import { IPFSMediaPlayer } from "../IPFSMediaPlayer";

interface EvidenceDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  ipfsCid: string;
}

export const EvidenceDrawer: React.FC<EvidenceDrawerProps> = ({ isOpen, onClose, ipfsCid }) => {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    if (isOpen) {
      window.addEventListener("keydown", handleKeyDown);
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = "";
    };
  }, [isOpen, onClose]);

  return (
    <>
      {/* Backdrop */}
      <div
        className={`fixed inset-0 bg-black/70 backdrop-blur-sm z-40 transition-opacity duration-300 ${
          isOpen ? "opacity-100" : "opacity-0 pointer-events-none"
        }`}
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Drawer */}
      <div
        className={`fixed top-0 right-0 z-50 h-full w-full max-w-md bg-zinc-950 border-l border-zinc-800 shadow-2xl transform transition-transform duration-300 ease-in-out flex flex-col ${
          isOpen ? "translate-x-0" : "translate-x-full"
        }`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="drawer-title"
      >
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-zinc-800/80 bg-zinc-900/50">
          <div className="flex items-center space-x-3">
            <div className="p-2 bg-zinc-900 rounded-lg border border-zinc-700/50 shadow-sm">
              <FileText className="w-5 h-5 text-cyan-400" />
            </div>
            <h2 id="drawer-title" className="text-xl font-bold text-zinc-100 tracking-tight">
              Milestone Evidence
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-zinc-400 hover:text-white hover:bg-zinc-800 rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-red-500/50"
            aria-label="Close evidence drawer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6 bg-zinc-950">
          <div className="bg-black rounded-xl border border-zinc-800/80 overflow-hidden min-h-[300px] shadow-inner">
            {ipfsCid ? (
              <IPFSMediaPlayer cid={ipfsCid} altText="Milestone Evidence" />
            ) : (
              <div className="flex items-center justify-center h-full min-h-[300px] text-zinc-500">
                No IPFS CID provided.
              </div>
            )}
          </div>

          <div className="mt-8 space-y-4">
            <h3 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider">
              Metadata Details
            </h3>
            <div className="p-4 bg-zinc-900 rounded-xl border border-zinc-800/80 shadow-sm space-y-3">
              <div className="flex justify-between items-center text-sm">
                <span className="text-zinc-500 font-medium">Network:</span>
                <span className="text-emerald-400 font-medium bg-emerald-500/10 px-2 py-0.5 rounded text-xs border border-emerald-500/20">
                  IPFS
                </span>
              </div>
              <div className="flex justify-between items-center text-sm pt-2 border-t border-zinc-800/50">
                <span className="text-zinc-500 font-medium shrink-0 mr-4">CID:</span>
                <span className="text-zinc-300 font-mono text-xs truncate" title={ipfsCid}>
                  {ipfsCid}
                </span>
              </div>
            </div>
            <div className="p-4 bg-cyan-950/20 border border-cyan-900/30 rounded-xl mt-4">
              <p className="text-xs text-cyan-200/70 leading-relaxed font-medium">
                Review the media evidence carefully before approving the proposal. All voting
                actions are final and recorded immutably on the Soroban smart contract.
              </p>
            </div>
          </div>
        </div>
      </div>
    </>
  );
};
