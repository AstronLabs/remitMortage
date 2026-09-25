"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React, { useState, useEffect, useRef } from "react";
import { Loader2, AlertCircle } from "lucide-react";

interface IPFSMediaPlayerProps {
  cid: string;
  altText?: string;
  fileType?: "image" | "video";
}

const PRIMARY_GATEWAY = "https://cloudflare-ipfs.com/ipfs/";
const FALLBACK_GATEWAY = "https://ipfs.io/ipfs/";
const TIMEOUT_MS = 5000;

export const IPFSMediaPlayer: React.FC<IPFSMediaPlayerProps> = ({
  cid,
  altText = "IPFS Media",
  fileType,
}) => {
  const [gateway, setGateway] = useState<string>(PRIMARY_GATEWAY);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<boolean>(false);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  // Derive type if not passed
  const isVideo = fileType === "video" || cid.toLowerCase().endsWith(".mp4");

  const url = `${gateway}${cid}`;

  const handleLoadSuccess = () => {
    setLoading(false);
    if (timerRef.current) clearTimeout(timerRef.current);
  };

  const handleError = () => {
    if (gateway === PRIMARY_GATEWAY) {
      // Switch to fallback
      setGateway(FALLBACK_GATEWAY);
      setLoading(true);
    } else {
      // Both gateways failed
      setLoading(false);
      setError(true);
    }
  };

  useEffect(() => {
    setLoading(true);
    setError(false);
    setGateway(PRIMARY_GATEWAY);
  }, [cid]);

  useEffect(() => {
    if (loading && !error) {
      timerRef.current = setTimeout(() => {
        if (gateway === PRIMARY_GATEWAY) {
          setGateway(FALLBACK_GATEWAY);
        }
      }, TIMEOUT_MS);
    }
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [loading, gateway, error]);

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center p-4 bg-zinc-800/50 rounded-lg text-red-400 border border-red-500/20 h-full w-full min-h-[200px]">
        <AlertCircle className="w-8 h-8 mb-2 opacity-80" />
        <span className="text-sm font-medium">Failed to load media</span>
      </div>
    );
  }

  return (
    <div className="relative w-full h-full min-h-[200px] flex items-center justify-center bg-zinc-900 rounded-lg overflow-hidden group">
      {loading && (
        <div
          className="absolute inset-0 flex items-center justify-center bg-zinc-900/80 z-10"
          data-testid="loading-indicator"
        >
          <Loader2 className="w-8 h-8 text-indigo-500 animate-spin" />
        </div>
      )}

      {isVideo ? (
        <video
          src={url}
          controls
          className={`max-w-full max-h-full object-contain transition-opacity duration-300 ${loading ? "opacity-0" : "opacity-100"}`}
          onCanPlay={handleLoadSuccess}
          onError={handleError}
          data-testid="ipfs-video"
        />
      ) : (
        <img
          src={url}
          alt={altText}
          className={`max-w-full max-h-full object-contain transition-opacity duration-300 ${loading ? "opacity-0" : "opacity-100"}`}
          onLoad={handleLoadSuccess}
          onError={handleError}
          data-testid="ipfs-image"
        />
      )}
    </div>
  );
};
