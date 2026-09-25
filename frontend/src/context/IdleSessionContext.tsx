"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from "react";
import { useWallet } from "./WalletContext";
import { useToast } from "./ToastContext";
import IdleSessionModal from "@/components/IdleSessionModal";

type IdleSessionContextType = {
  isWarningOpen: boolean;
  remainingSeconds: number;
  extendSession: () => void;
  logoutSession: () => void;
};

const IdleSessionContext = createContext<IdleSessionContextType | undefined>(undefined);

// Default timeout: 15 minutes (900,000 ms), warning triggers 60 seconds (60,000 ms) before timeout.
// Overridable via NEXT_PUBLIC_IDLE_TIMEOUT_MS and NEXT_PUBLIC_IDLE_WARNING_MS env vars
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_WARNING_MS = 60 * 1000;

export function IdleSessionProvider({
  children,
  timeoutMs = Number(process.env.NEXT_PUBLIC_IDLE_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
  warningDurationMs = Number(process.env.NEXT_PUBLIC_IDLE_WARNING_MS) || DEFAULT_WARNING_MS,
}: {
  children: React.ReactNode;
  timeoutMs?: number;
  warningDurationMs?: number;
}) {
  const { isConnected, disconnectAll } = useWallet();
  const { toast } = useToast();

  const [isWarningOpen, setIsWarningOpen] = useState(false);
  const [remainingSeconds, setRemainingSeconds] = useState(Math.floor(warningDurationMs / 1000));

  const lastActivityRef = useRef<number>(Date.now());
  const checkIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const countdownIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // Clear sensitive local data stored in browser
  const clearSensitiveData = useCallback(() => {
    try {
      if (typeof window !== "undefined") {
        sessionStorage.clear();
        localStorage.removeItem("jwt_token");
        localStorage.removeItem("auth_token");
        localStorage.removeItem("user_profile");
        localStorage.removeItem("borrower_data");
        localStorage.removeItem("encrypted_key");
        // Clear auth cookie if accessible
        document.cookie = "token=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;";
      }
    } catch (e) {
      console.error("Failed to clear sensitive browser storage:", e);
    }
  }, []);

  const logoutSession = useCallback(() => {
    clearSensitiveData();
    disconnectAll();
    setIsWarningOpen(false);
    if (countdownIntervalRef.current) {
      clearInterval(countdownIntervalRef.current);
      countdownIntervalRef.current = null;
    }
    toast({
      variant: "warning",
      title: "Session Expired",
      message: "You have been logged out automatically due to inactivity.",
    });
  }, [disconnectAll, clearSensitiveData, toast]);

  const extendSession = useCallback(() => {
    lastActivityRef.current = Date.now();
    setIsWarningOpen(false);
    setRemainingSeconds(Math.floor(warningDurationMs / 1000));
    if (countdownIntervalRef.current) {
      clearInterval(countdownIntervalRef.current);
      countdownIntervalRef.current = null;
    }
  }, [warningDurationMs]);

  // Handle user activity events (throttled)
  useEffect(() => {
    if (!isConnected) {
      setIsWarningOpen(false);
      return;
    }

    let lastThrottle = 0;
    const handleActivity = () => {
      const now = Date.now();
      if (now - lastThrottle < 500) return; // throttle 500ms
      lastThrottle = now;

      // Only reset timer if warning modal is not currently open
      if (!isWarningOpen) {
        lastActivityRef.current = now;
      }
    };

    const events = ["mousemove", "mousedown", "keydown", "touchstart", "scroll", "click"];
    events.forEach((evt) => window.addEventListener(evt, handleActivity, { passive: true }));

    return () => {
      events.forEach((evt) => window.removeEventListener(evt, handleActivity));
    };
  }, [isConnected, isWarningOpen]);

  // Main ticker monitoring idle duration
  useEffect(() => {
    if (!isConnected) {
      if (checkIntervalRef.current) clearInterval(checkIntervalRef.current);
      if (countdownIntervalRef.current) clearInterval(countdownIntervalRef.current);
      setIsWarningOpen(false);
      return;
    }

    lastActivityRef.current = Date.now();

    checkIntervalRef.current = setInterval(() => {
      const now = Date.now();
      const elapsed = now - lastActivityRef.current;
      const warningThreshold = timeoutMs - warningDurationMs;

      if (elapsed >= timeoutMs) {
        // Hard timeout reached -> logout immediately
        logoutSession();
      } else if (elapsed >= warningThreshold && !isWarningOpen) {
        // Threshold reached -> trigger warning modal & countdown
        setIsWarningOpen(true);
        const initialSecs = Math.max(1, Math.ceil((timeoutMs - elapsed) / 1000));
        setRemainingSeconds(initialSecs);

        if (countdownIntervalRef.current) clearInterval(countdownIntervalRef.current);
        countdownIntervalRef.current = setInterval(() => {
          setRemainingSeconds((prev) => {
            if (prev <= 1) {
              if (countdownIntervalRef.current) clearInterval(countdownIntervalRef.current);
              logoutSession();
              return 0;
            }
            return prev - 1;
          });
        }, 1000);
      }
    }, 1000);

    return () => {
      if (checkIntervalRef.current) clearInterval(checkIntervalRef.current);
      if (countdownIntervalRef.current) clearInterval(countdownIntervalRef.current);
    };
  }, [isConnected, timeoutMs, warningDurationMs, logoutSession, isWarningOpen]);

  return (
    <IdleSessionContext.Provider
      value={{
        isWarningOpen,
        remainingSeconds,
        extendSession,
        logoutSession,
      }}
    >
      {children}
      <IdleSessionModal
        isOpen={isWarningOpen}
        remainingSeconds={remainingSeconds}
        totalWarningSeconds={Math.floor(warningDurationMs / 1000)}
        onExtendSession={extendSession}
        onLogoutNow={logoutSession}
      />
    </IdleSessionContext.Provider>
  );
}

export function useIdleSession() {
  const context = useContext(IdleSessionContext);
  if (!context) {
    throw new Error("useIdleSession must be used within IdleSessionProvider");
  }
  return context;
}
