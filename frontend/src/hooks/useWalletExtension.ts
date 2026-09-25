"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { useState, useEffect, useCallback } from "react";

type WalletExtensionState = {
  hasExtension: boolean | null;
  isChecking: boolean;
  recheck: () => void;
};

const POLL_INTERVAL_MS = 3000;

function detectExtension(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as unknown as Record<string, unknown>;
  return Boolean(w.freighterApi) || Boolean(w.freighter);
}

export function useWalletExtension(): WalletExtensionState {
  const [hasExtension, setHasExtension] = useState<boolean | null>(null);
  const [isChecking, setIsChecking] = useState(true);

  const recheck = useCallback(() => {
    setIsChecking(true);
    setHasExtension(detectExtension());
    setIsChecking(false);
  }, []);

  useEffect(() => {
    recheck();

    const interval = setInterval(recheck, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [recheck]);

  return { hasExtension, isChecking, recheck };
}
