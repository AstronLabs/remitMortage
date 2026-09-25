"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { useEffect, useState } from "react";
import { Joyride, type Step, type EventData } from "react-joyride";
import { useProductTourState } from "@/hooks/useProductTourState";

// Each step targets a real, stable DOM selector so the tour highlights the
// same element across reloads and viewport sizes.
const TOUR_STEPS: Step[] = [
  {
    target: "#tour-wallet",
    title: "Connect Your Wallet",
    content:
      "Connect your Stellar wallet to access your escrow account and track your mortgage journey.",
    placement: "bottom",
    spotlightRadius: 14,
    spotlightPadding: 8,
  },
  {
    target: "#tour-onboarding-cta",
    title: "Complete Your Onboarding",
    content:
      "Verify your remittance history to unlock your borrowing eligibility and set your savings goal.",
    placement: "bottom",
    spotlightRadius: 14,
    spotlightPadding: 8,
  },
  {
    target: "#tour-savings",
    title: "Track Your Down-Payment Savings",
    content: "Watch your escrow progress as you deposit USDC toward your 30% down-payment target.",
    placement: "top",
    spotlightRadius: 14,
    spotlightPadding: 8,
  },
  {
    target: "#tour-loan-status",
    title: "Monitor Your Loan Status",
    content:
      "Track your loan approval, disbursement milestones, and repayment schedule in one place.",
    placement: "top",
    spotlightRadius: 14,
    spotlightPadding: 8,
  },
];

type TourCallback = EventData;

export default function ProductTour() {
  const { completed, dismissed, setCompleted, setDismissed } = useProductTourState((s) => s);
  const [isHydrated, setIsHydrated] = useState(false);

  useEffect(() => {
    setIsHydrated(true);
  }, []);

  // Don't render anything until the client has hydrated the persisted state,
  // otherwise the tour would flash on every server-rendered page load.
  if (!isHydrated) return null;

  const handleEvent = (data: TourCallback) => {
    if (data.error) {
      setDismissed(true);
      return;
    }
    if (data.action === "close" || data.action === "skip") {
      setDismissed(true);
    } else if (data.action === "complete") {
      setCompleted(true);
    }
  };

  return (
    <Joyride
      steps={TOUR_STEPS}
      run={!completed && !dismissed}
      onEvent={handleEvent}
      scrollToFirstStep
      options={{
        showProgress: true,
        spotlightRadius: 14,
        targetWaitTimeout: 5000,
      }}
      locale={{
        back: "Back",
        close: "Close",
        last: "Done",
        next: "Next",
        skip: "Skip",
      }}
      styles={{
        tooltip: {
          borderRadius: 16,
          backgroundColor: "#0f1626",
          color: "#e2e8f0",
          border: "1px solid rgba(56, 189, 248, 0.35)",
          boxShadow: "0 20px 50px -12px rgba(0, 0, 0, 0.7)",
          fontSize: 15,
          padding: "20px 22px",
          maxWidth: 340,
        },
        tooltipTitle: {
          color: "#38bdf8",
          fontSize: 17,
          marginBottom: 8,
        },
        tooltipContent: {
          color: "#94a3b8",
          fontSize: 14,
          lineHeight: 1.5,
        },
        buttonClose: {
          color: "#64748b",
          top: 12,
          right: 12,
        },
        buttonPrimary: {
          backgroundColor: "#0ea5e9",
          color: "#fff",
          borderRadius: 10,
          padding: "9px 18px",
          fontWeight: 600,
        },
        buttonBack: {
          color: "#94a3b8",
          borderRadius: 10,
          padding: "9px 18px",
        },
        buttonSkip: {
          color: "#64748b",
          borderRadius: 10,
          padding: "9px 18px",
        },
      }}
    />
  );
}

// Re-export the reset helper so settings pages can wire up a "Replay Tour"
// button without reaching into the store internals directly.
export { useProductTourState };
