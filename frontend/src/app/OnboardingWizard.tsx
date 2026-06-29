"use client";

import { useState, useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import { getOnboardingStore, useOnboardingState } from "./useOnboardingState";
import ProgressStepper from "./ProgressStepper";
import { toast } from "react-hot-toast";
import { z } from "zod";
import { useWallet } from "../context/WalletContext";

// Stellar G... public key: starts with G, exactly 56 alphanumeric chars
const stellarAddressSchema = z.string().regex(
  /^G[A-Z2-7]{55}$/,
  "Invalid Stellar address — must start with G and be 56 characters"
);

const savingsGoalSchema = z.object({
  savingsTarget: z.number().min(500, "Goal must be at least $500").max(1_000_000, "Goal must be at most $1,000,000"),
  savingsDuration: z.union([z.literal(6), z.literal(9), z.literal(12)], {
    error: "Duration must be 6, 9, or 12 months",
  }),
});

const STEPS = ["Connect Wallet", "Verify History", "Set Goal", "First Deposit"];

export default function OnboardingWizard() {
  const router = useRouter();
  const store = getOnboardingStore();
  const { publicKey, connect } = useWallet();

  // State from Zustand store
  const step = useOnboardingState((s) => s.step);
  const recipientAddress = useOnboardingState((s) => s.recipientAddress);
  const isVerified = useOnboardingState((s) => s.isVerified);
  const savingsTarget = useOnboardingState((s) => s.savingsTarget);
  const savingsDuration = useOnboardingState((s) => s.savingsDuration);
  const firstDepositAmount = useOnboardingState((s) => s.firstDepositAmount);

  // Local component state
  const [usdcBalance, setUsdcBalance] = useState("0");
  const [isLoading, setIsLoading] = useState(false);
  const [verificationMessage, setVerificationMessage] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const HORIZON_URL = process.env.NEXT_PUBLIC_HORIZON_URL!;
  const USDC_TOKEN_ID = process.env.NEXT_PUBLIC_USDC_TOKEN_ID!;

  useEffect(() => {
    if (step === 1 && publicKey) {
      fetchUSDCBalance(publicKey);
    }
  }, [step, publicKey]);

  const handleConnect = async () => {
    setIsLoading(true);
    try {
      const connectedPublicKey = await connect();
      if (connectedPublicKey) {
        await fetchUSDCBalance(connectedPublicKey);
        toast.success("Wallet connected!");
      } else {
        toast.error("Freighter is not available. Please install and set up the Freighter wallet extension.");
      }
    } catch (e) {
      console.error(e);
      toast.error("Failed to connect wallet.");
    }
    setIsLoading(false);
  };

  const fetchUSDCBalance = async (pk: string) => {
    try {
      const { Horizon } = await import("@stellar/stellar-sdk");
      const server = new Horizon.Server(HORIZON_URL);
      const account = await server.accounts().accountId(pk).call();
      const usdcBalanceLine = (account.balances as any[]).find(
        (b) => b.asset_code === "USDC" && b.asset_issuer === USDC_TOKEN_ID
      );
      setUsdcBalance(usdcBalanceLine ? parseFloat(usdcBalanceLine.balance).toFixed(2) : "0.00");
    } catch (e) {
      console.warn("Could not fetch USDC balance.", e);
      setUsdcBalance("0.00");
    }
  };

  const handleVerify = async () => {
    setIsLoading(true);
    setVerificationMessage("");
    try {
      const response = await fetch("/api/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recipientAddress }),
      });
      const data = await response.json();
      if (response.ok && data.eligible) {
        store.getState().setIsVerified(true);
        setVerificationMessage(data.message);
        toast.success("Remittance history verified!");
      } else {
        store.getState().setIsVerified(false);
        setVerificationMessage(data.message || "Verification failed. Please check the address and try again.");
        toast.error(data.message || "Verification failed.");
      }
    } catch (e) {
      console.error(e);
      toast.error("An error occurred during verification.");
    }
    setIsLoading(false);
  };

  const handleDeposit = async () => {
    if (!publicKey) {
      toast.error("Wallet not connected.");
      return;
    }
    if (firstDepositAmount <= 0) {
      toast.error("Please enter a valid deposit amount.");
      return;
    }

    setIsLoading(true);
    toast.loading("Preparing transaction...");

    try {
      // TODO: Build and sign Soroban deposit transaction using Contract SDK
      // Placeholder: simulate success flow
      toast.dismiss();
      toast.success("Simulated deposit success! Real Soroban integration pending.");
      store.getState().reset();
      router.push("/dashboard");
    } catch (e) {
      console.error(e);
      toast.dismiss();
      toast.error("Deposit failed.");
    } finally {
      setIsLoading(false);
    }
  };

  const monthlyContribution = useMemo(() => {
    if (savingsDuration > 0) {
      return (savingsTarget / savingsDuration).toFixed(2);
    }
    return "0.00";
  }, [savingsTarget, savingsDuration]);

  const renderStepContent = () => {
    switch (step) {
      case 1: // Connect Wallet
        return (
          <div className="text-center">
            <h3 className="text-xl font-semibold mb-4">Connect Your Freighter Wallet</h3>
            <p className="text-[var(--text-secondary)] mb-6">Connect your wallet to check your USDC balance and interact with the protocol.</p>
            {publicKey ? (
              <div className="glass-card p-4 text-left">
                <p className="text-sm text-[var(--text-muted)]">Connected Address:</p>
                <p className="font-mono text-sm break-all mb-2">{publicKey}</p>
                <p className="text-sm text-[var(--text-muted)]">USDC Balance:</p>
                <p className="font-semibold text-lg">${usdcBalance}</p>
              </div>
            ) : (
              <button onClick={handleConnect} className="btn-primary" disabled={isLoading}>
                {isLoading ? "Connecting..." : "Connect Wallet"}
              </button>
            )}
          </div>
        );
      case 2: // Verify Remittances
        return (
          <div>
            <h3 className="text-xl font-semibold mb-4">Verify Your Remittance History</h3>
            <p className="text-[var(--text-secondary)] mb-6">Enter the Stellar address of the family member you regularly send remittances to.</p>
            <div className="flex gap-2 mb-1">
              <input
                type="text"
                placeholder="Recipient's G... address"
                className="input-field flex-1"
                value={recipientAddress}
                onChange={(e) => { store.getState().setRecipientAddress(e.target.value); setFieldErrors((prev) => ({ ...prev, recipientAddress: "" })); }}
                disabled={isLoading || isVerified}
              />
              <button onClick={handleVerify} className="btn-primary" disabled={isLoading || !recipientAddress || isVerified}>
                {isLoading ? "Verifying..." : isVerified ? "Verified" : "Verify"}
              </button>
            </div>
            {fieldErrors.recipientAddress && (
              <p className="text-red-400 text-sm mb-3">{fieldErrors.recipientAddress}</p>
            )}
            {verificationMessage && (
              <div className={`p-3 rounded-lg text-sm ${isVerified ? "bg-green-500/10 text-green-300" : "bg-red-500/10 text-red-300"}`}>
                {verificationMessage}
              </div>
            )}
          </div>
        );
      case 3: // Set Savings Goal
        return (
          <div>
            <h3 className="text-xl font-semibold mb-4">Set Your Savings Goal</h3>
            <p className="text-[var(--text-secondary)] mb-6">Define your 30% down payment target and savings duration.</p>
            <div className="space-y-4">
              <div>
                <label className="text-sm text-[var(--text-muted)]">Down Payment Target (USDC)</label>
                <input
                  type="number"
                  className="input-field w-full"
                  value={savingsTarget}
                  onChange={(e) => { store.getState().setSavingsTarget(Number(e.target.value)); setFieldErrors((prev) => ({ ...prev, savingsTarget: "" })); }}
                />
                {fieldErrors.savingsTarget && (
                  <p className="text-red-400 text-sm mt-1">{fieldErrors.savingsTarget}</p>
                )}
              </div>
              <div>
                <label className="text-sm text-[var(--text-muted)]">Savings Duration</label>
                <select
                  className="input-field w-full"
                  value={savingsDuration}
                  onChange={(e) => { store.getState().setSavingsDuration(Number(e.target.value)); setFieldErrors((prev) => ({ ...prev, savingsDuration: "" })); }}
                >
                  <option value={6}>6 Months</option>
                  <option value={9}>9 Months</option>
                  <option value={12}>12 Months</option>
                </select>
                {fieldErrors.savingsDuration && (
                  <p className="text-red-400 text-sm mt-1">{fieldErrors.savingsDuration}</p>
                )}
              </div>
              <div className="glass-card p-4 text-center">
                <p className="text-sm text-[var(--text-muted)]">Estimated Monthly Contribution</p>
                <p className="text-2xl font-bold">${monthlyContribution}</p>
              </div>
            </div>
          </div>
        );
      case 4: // First Deposit
        return (
          <div>
            <h3 className="text-xl font-semibold mb-4">Make Your First Deposit</h3>
            <p className="text-[var(--text-secondary)] mb-6">
              Kickstart your savings journey by making your first deposit into the secure escrow contract. Your estimated monthly contribution is ${monthlyContribution}.
            </p>
            <div className="flex gap-2">
              <input
                type="number"
                placeholder="Enter deposit amount"
                className="input-field flex-1"
                value={firstDepositAmount || ""}
                onChange={(e) => store.getState().setFirstDepositAmount(Number(e.target.value))}
              />
              <button onClick={handleDeposit} className="btn-primary" disabled={isLoading || firstDepositAmount <= 0}>
                {isLoading ? "Processing..." : "Deposit"}
              </button>
            </div>
          </div>
        );
      default:
        return null;
    }
  };

  const validateStep = (): boolean => {
    const errors: Record<string, string> = {};

    if (step === 2) {
      const result = stellarAddressSchema.safeParse(recipientAddress);
      if (!result.success) {
        errors.recipientAddress = result.error.issues[0].message;
      }
    }

    if (step === 3) {
      const result = savingsGoalSchema.safeParse({ savingsTarget, savingsDuration });
      if (!result.success) {
        result.error.issues.forEach((issue) => {
          const field = issue.path[0] as string;
          if (!errors[field]) errors[field] = issue.message;
        });
      }
    }

    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const canGoNext = () => {
    switch (step) {
      case 1:
        return !!publicKey;
      case 2:
        return isVerified;
      case 3:
        return savingsTarget > 0 && savingsDuration > 0;
      case 4:
        return false; // Final step
      default:
        return false;
    }
  };

  return (
    <div className="glass-card p-8">
      <ProgressStepper steps={STEPS} currentStep={step} />
      <div className="min-h-[200px] flex flex-col justify-center">{renderStepContent()}</div>
      <div className="flex justify-between items-center mt-8 pt-6 border-t border-[var(--border-color)]">
        <button
          onClick={() => store.getState().setStep(step - 1)}
          className="btn-outline"
          disabled={step === 1 || isLoading}
        >
          Back
        </button>
        <button
          onClick={() => { if (validateStep()) store.getState().setStep(step + 1); }}
          className="btn-primary"
          disabled={!canGoNext() || isLoading}
        >
          Next
        </button>
      </div>
    </div>
  );
}