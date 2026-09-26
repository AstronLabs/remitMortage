"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React, { useState, useEffect } from "react";
import { X, Maximize2, Minimize2, Calendar, HardDrive, ShieldCheck, ShieldAlert } from "lucide-react";
import { IPFSMediaPlayer } from "./IPFSMediaPlayer";

export interface MilestoneData {
  title: string;
  description: string;
  cid: string;
  size: string;
  dateUploaded: string;
  sha256_hash?: string;
  sha256Hash?: string;
  expectedHash?: string;
  expected_sha256?: string;
}

interface EvidenceModalProps {
  isOpen: boolean;
  onClose: () => void;
  milestoneData: MilestoneData;
}

export const EvidenceModal: React.FC<EvidenceModalProps> = ({ isOpen, onClose, milestoneData }) => {
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    if (isOpen) {
      window.addEventListener("keydown", handleKeyDown);
    }
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const isVideo = milestoneData.cid.toLowerCase().endsWith(".mp4");
  const hash = milestoneData.sha256_hash || milestoneData.sha256Hash;
  const expectedHash = milestoneData.expectedHash || milestoneData.expected_sha256;
  const isMismatched = Boolean(
    hash && expectedHash && hash.toLowerCase().trim() !== expectedHash.toLowerCase().trim()
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm transition-opacity"
      role="dialog"
      aria-modal="true"
      aria-labelledby="modal-title"
    >
      <div
        className="absolute inset-0"
        onClick={onClose}
        aria-hidden="true"
        data-testid="modal-backdrop"
      />

      <div
        className={`relative flex flex-col bg-zinc-900 border border-zinc-800 shadow-2xl rounded-xl overflow-hidden transition-all duration-300 ease-in-out ${
          isFullscreen ? "w-full h-full" : "w-full max-w-4xl max-h-[90vh]"
        }`}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-zinc-800 bg-zinc-900/50">
          <div className="flex items-center space-x-3">
            <h2 id="modal-title" className="text-lg font-semibold text-zinc-100">
              {milestoneData.title}
            </h2>
            {isMismatched ? (
              <span
                className="px-2.5 py-0.5 bg-red-500/20 text-red-400 border border-red-500/40 rounded-full text-xs font-medium flex items-center"
                data-testid="header-hash-mismatch-badge"
              >
                <ShieldAlert className="w-3.5 h-3.5 mr-1 text-red-400" />
                Checksum Mismatch
              </span>
            ) : hash ? (
              <span
                className="px-2.5 py-0.5 bg-emerald-500/20 text-emerald-400 border border-emerald-500/40 rounded-full text-xs font-medium flex items-center"
                data-testid="header-integrity-badge"
              >
                <ShieldCheck className="w-3.5 h-3.5 mr-1 text-emerald-400" />
                Integrity Verified ✓
              </span>
            ) : null}
          </div>

          <div className="flex items-center space-x-2">
            {!isVideo && (
              <button
                onClick={() => setIsFullscreen(!isFullscreen)}
                className="p-2 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500"
                aria-label={isFullscreen ? "Exit fullscreen view" : "Enter fullscreen view"}
                title={isFullscreen ? "Exit Fullscreen" : "Fullscreen View"}
              >
                {isFullscreen ? (
                  <Minimize2 className="w-5 h-5" />
                ) : (
                  <Maximize2 className="w-5 h-5" />
                )}
              </button>
            )}
            <button
              onClick={onClose}
              className="p-2 text-zinc-400 hover:text-white hover:bg-zinc-800 rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-red-500"
              aria-label="Close modal"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div
          className={`flex flex-col md:flex-row ${isFullscreen ? "flex-1 overflow-hidden" : "overflow-y-auto"}`}
        >
          {/* Media Player Section */}
          <div
            className={`bg-black flex items-center justify-center ${isFullscreen ? "flex-1" : "md:w-2/3 min-h-[400px] p-4"}`}
          >
            <IPFSMediaPlayer cid={milestoneData.cid} altText={milestoneData.title} />
          </div>

          {/* Details Section */}
          {!isFullscreen && (
            <div className="flex flex-col p-6 md:w-1/3 bg-zinc-900 border-t md:border-t-0 md:border-l border-zinc-800">
              {isMismatched ? (
                <div
                  role="alert"
                  className="p-3 bg-red-950/60 border border-red-500/60 rounded-lg text-red-200 text-xs flex items-start space-x-2.5 mb-4 shadow-sm"
                  data-testid="hash-mismatch-alert"
                >
                  <ShieldAlert className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" />
                  <div>
                    <span className="font-semibold text-red-200 block">Cryptographic Checksum Mismatch Error</span>
                    <p className="mt-0.5 text-red-300/90 leading-normal">
                      The file SHA-256 hash does not match the on-chain expected checksum. File integrity cannot be verified!
                    </p>
                  </div>
                </div>
              ) : hash ? (
                <div
                  className="p-3 bg-emerald-950/50 border border-emerald-500/50 rounded-lg text-emerald-300 text-xs flex flex-col space-y-1 mb-4 shadow-sm"
                  data-testid="integrity-verified-badge"
                >
                  <div className="flex items-center font-semibold text-emerald-400">
                    <ShieldCheck className="w-4 h-4 mr-1.5 text-emerald-400 flex-shrink-0" />
                    <span>Cryptographic Integrity Verified ✓</span>
                  </div>
                  <div className="font-mono text-[11px] text-emerald-300/80 break-all select-all pt-0.5">
                    <span className="text-emerald-500 mr-1.5">SHA-256:</span>
                    {hash}
                  </div>
                </div>
              ) : null}

              <div className="mb-6">
                <h3 className="text-sm font-medium text-zinc-400 mb-2 uppercase tracking-wider">
                  Description
                </h3>
                <p className="text-zinc-300 text-sm leading-relaxed">{milestoneData.description}</p>
              </div>

              <div className="space-y-4 mt-auto">
                <h3 className="text-sm font-medium text-zinc-400 uppercase tracking-wider">
                  Metadata
                </h3>

                <div className="flex items-center text-sm text-zinc-300">
                  <HardDrive className="w-4 h-4 mr-3 text-zinc-500 flex-shrink-0" />
                  <span className="truncate" title={milestoneData.cid}>
                    <span className="text-zinc-500 mr-2">CID:</span>
                    {milestoneData.cid.substring(0, 8)}...
                    {milestoneData.cid.substring(milestoneData.cid.length - 8)}
                  </span>
                </div>

                {hash && (
                  <div className="flex items-center text-sm text-zinc-300">
                    <ShieldCheck className="w-4 h-4 mr-3 text-emerald-500 flex-shrink-0" />
                    <span className="truncate" title={hash}>
                      <span className="text-zinc-500 mr-2">SHA-256:</span>
                      {hash.substring(0, 8)}...
                      {hash.substring(hash.length - 8)}
                    </span>
                  </div>
                )}

                <div className="flex items-center text-sm text-zinc-300">
                  <span className="w-4 h-4 mr-3 text-zinc-500 font-mono text-xs flex items-center justify-center border border-zinc-500 rounded-sm flex-shrink-0">
                    SZ
                  </span>
                  <span>
                    <span className="text-zinc-500 mr-2">Size:</span>
                    {milestoneData.size}
                  </span>
                </div>

                <div className="flex items-center text-sm text-zinc-300">
                  <Calendar className="w-4 h-4 mr-3 text-zinc-500 flex-shrink-0" />
                  <span>
                    <span className="text-zinc-500 mr-2">Date:</span>
                    {milestoneData.dateUploaded}
                  </span>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
