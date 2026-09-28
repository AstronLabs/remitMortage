"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { useState, useEffect, useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useForm, useWatch, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { getOnboardingStore, useOnboardingState } from "@/hooks/useOnboardingState";
import { useFormAutosave } from "@/hooks/useFormAutosave";
import { onboardingSchema, STEP_FIELDS, type OnboardingFormValues } from "@/lib/onboardingSchema";
import ProgressStepper from "./ProgressStepper";
import { toast } from "react-hot-toast";
import { useWallet } from "@/context/WalletContext";
import {
  attributeReferralCode,
  persistReferralCode,
  readPersistedReferralCode,
  REFERRAL_QUERY_PARAM,
} from "@/lib/referralApi";

const STEPS = ["Connect Wallet", "Verify History", "Set Goal", "Documents", "Submit Application"];
const FIELD_STEPS: Record<keyof OnboardingFormValues, number> = {
  recipientAddress: 2,
  savingsTarget: 3,
  savingsDuration: 3,
  firstDepositAmount: 5,
};

const FIELD_LABELS: Record<keyof OnboardingFormValues, string> = {
  recipientAddress: "Recipient's Stellar wallet address",
  savingsTarget: "Down Payment Goal (USDC)",
  savingsDuration: "Savings Duration",
  firstDepositAmount: "Initial Deposit Amount (USDC)",
};

export default function OnboardingWizard() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const store = getOnboardingStore();
  const { publicKey, connect, signMessage } = useWallet();

  // State from Zustand store (persisted across reloads).
  const step = useOnboardingState((s) => s.step);
  const isVerified = useOnboardingState((s) => s.isVerified);

  // Local component state
  const [usdcBalance, setUsdcBalance] = useState("0");
  const [isLoading, setIsLoading] = useState(false);
  const [verificationMessage, setVerificationMessage] = useState("");
  const [loanType, setLoanType] = useState<LoanType>("purchase");
  const [documentsAccepted, setDocumentsAccepted] = useState(false);
  const [authenticatedAddress, setAuthenticatedAddress] = useState<string | null>(null);
  const [errorAnnouncementKey, setErrorAnnouncementKey] = useState(0);
  const pendingFieldFocus = useRef<keyof OnboardingFormValues | null>(null);

  const {
    control,
    trigger,
    getValues,
    setValue,
    setFocus,
    formState: { errors },
  } = useForm<OnboardingFormValues>({
    resolver: zodResolver(onboardingSchema),
    mode: "onChange",
    defaultValues: {
      recipientAddress: store.getState().recipientAddress,
      savingsTarget: store.getState().savingsTarget,
      savingsDuration: store.getState().savingsDuration as 6 | 9 | 12,
      firstDepositAmount: store.getState().firstDepositAmount,
    },
  });

  // Watch all form values for autosave
  const watchedRecipient = useWatch({ control, name: "recipientAddress" });
  const watchedTarget = useWatch({ control, name: "savingsTarget" });
  const watchedDuration = useWatch({ control, name: "savingsDuration" });
  const watchedDeposit = useWatch({ control, name: "firstDepositAmount" });

  // Autosave hook
  const { hasDraft, restoreDraft, clearDraft, dismissDraft } = useFormAutosave(
    {
      recipientAddress: watchedRecipient,
      savingsTarget: watchedTarget,
      savingsDuration: watchedDuration,
      firstDepositAmount: watchedDeposit,
      step,
    },
    {
      key: "onboarding-form-draft",
      debounceMs: 800,
      onRestore: (data) => {
        if (data.recipientAddress) setValue("recipientAddress", data.recipientAddress);
        if (data.savingsTarget) setValue("savingsTarget", data.savingsTarget);
        if (data.savingsDuration) setValue("savingsDuration", data.savingsDuration);
        if (data.firstDepositAmount) setValue("firstDepositAmount", data.firstDepositAmount);
        if (data.step) store.getState().setStep(data.step);
      },
    }
  );

  const HORIZON_URL = process.env.NEXT_PUBLIC_HORIZON_URL!;
  const USDC_TOKEN_ID = process.env.NEXT_PUBLIC_USDC_TOKEN_ID!;

  const fetchUSDCBalance = useCallback(
    async (pk: string) => {
      try {
        const { Horizon } = await import("@stellar/stellar-sdk");
        const server = new Horizon.Server(HORIZON_URL);
        const account = await server.accounts().accountId(pk).call();
        const balances = account.balances as Array<{
          asset_code?: string;
          asset_issuer?: string;
          balance: string;
        }>;
        const usdcBalanceLine = balances.find(
          (balance) => balance.asset_code === "USDC" && balance.asset_issuer === USDC_TOKEN_ID
        );
        setUsdcBalance(usdcBalanceLine ? parseFloat(usdcBalanceLine.balance).toFixed(2) : "0.00");
      } catch (e) {
        console.warn("Could not fetch USDC balance.", e);
        setUsdcBalance("0.00");
      }
    },
    [HORIZON_URL, USDC_TOKEN_ID, setUsdcBalance]
  );

  useEffect(() => {
    const refCode = searchParams.get(REFERRAL_QUERY_PARAM);
    if (refCode) {
      persistReferralCode(refCode);
    }
  }, [searchParams]);

  useEffect(() => {
    const referralCode = readPersistedReferralCode();
    if (!referralCode || !publicKey) return;

    attributeReferralCode(referralCode, publicKey).catch(() => {
      // Attribution is best-effort during onboarding.
    });
  }, [publicKey]);

  useEffect(() => {
    if (step === 1 && publicKey) {
      const timeout = window.setTimeout(() => void fetchUSDCBalance(publicKey), 0);
      return () => clearTimeout(timeout);
    }
  }, [step, publicKey, fetchUSDCBalance]);

  useEffect(() => {
    const fieldName = pendingFieldFocus.current;
    if (!fieldName || step !== FIELD_STEPS[fieldName]) return;
    const field = document.getElementById(fieldName);
    if (!field) return;
    field.scrollIntoView?.({ behavior: "smooth", block: "center" });
    setFocus(fieldName);
    field.focus();
    pendingFieldFocus.current = null;
  }, [setFocus, step]);

  const focusErrorField = (fieldName: keyof OnboardingFormValues) => {
    const field = document.getElementById(fieldName);
    if (!field) return;
    field.scrollIntoView?.({ behavior: "smooth", block: "center" });
    setFocus(fieldName);
    field.focus();
  };

  const handleErrorFieldSelect = (fieldName: keyof OnboardingFormValues & string) => {
    const targetStep = FIELD_STEPS[fieldName];
    if (step === targetStep) {
      focusErrorField(fieldName);
      return;
    }
    pendingFieldFocus.current = fieldName;
    store.getState().setStep(targetStep);
  };

  const handleConnect = async () => {
    setIsLoading(true);
    try {
      const connectedPublicKey = await connect();
      if (connectedPublicKey) {
        await fetchUSDCBalance(connectedPublicKey);
        toast.success("Wallet connected!");
      } else {
        toast.error(
          "Freighter is not available. Please install and set up the Freighter wallet extension."
        );
      }
    } catch (e) {
      console.error(e);
      toast.error("Failed to connect wallet.");
    }
    setIsLoading(false);
  };

  const handleVerify = async () => {
    const valid = await trigger("recipientAddress");
    if (!valid) {
      setErrorAnnouncementKey((key) => key + 1);
      return;
    }

    if (!publicKey) {
      toast.error("Please connect your wallet first.");
      return;
    }

    setIsLoading(true);
    setVerificationMessage("");
    try {
      const response = await fetch("/api/verification/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          senderAddress: publicKey,
          recipientAddress: getValues("recipientAddress"),
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? data.message ?? "Verification failed.");
      if (data.eligible) {
        store.getState().setIsVerified(true);
        setVerificationMessage(data.message);
        toast.success("Remittance history verified!");
      } else {
        store.getState().setIsVerified(false);
        setVerificationMessage(
          data.message || data.error || "Verification failed. Please check the address and try again."
        );
        toast.error(data.message || data.error || "Verification failed.");
      }
    } catch (e) {
      console.error(e);
      toast.error("An error occurred during verification.");
    }
    setIsLoading(false);
  };

  const handleDeposit = async () => {
    if (!documentsAccepted) {
      toast.error(
        "Complete the document checklist: every required document must be accepted before final submission."
      );
      store.getState().setStep(4);
      return;
    }
    if (!publicKey) {
      toast.error("Wallet not connected.");
      return;
    }
    const valid = await trigger("firstDepositAmount");
    if (!valid) {
      setErrorAnnouncementKey((key) => key + 1);
      return;
    }

    setIsLoading(true);
    toast.loading("Preparing transaction...");

    try {
      const submitted = await submitLoanApplication();
      if (!submitted) {
        toast.dismiss();
        return;
      }
      toast.dismiss();
      toast.success("Loan application submitted. Redirecting to Escrow Dashboard...");
      clearDraft(); // Clear autosaved data on successful submission
      store.getState().reset();
      router.push("/dashboard");
    } catch (e) {
      console.error(e);
      toast.dismiss();
      toast.error(e instanceof Error ? e.message : "Application submission failed.");
    } finally {
      setIsLoading(false);
    }
  };

  const handleDocumentEligibilityChange = useCallback(
    (eligible: boolean) => {
      setDocumentsAccepted(eligible);
    },
    [setDocumentsAccepted]
  );

  const submitLoanApplication = async (): Promise<boolean> => {
    if (!documentsAccepted) {
      toast.error("Submission is blocked until every required document is accepted.");
      store.getState().setStep(4);
      return false;
    }
    const authenticated = authenticatedAddress === publicKey || (await authenticateApplicant());
    if (!authenticated || !publicKey) return false;

    const applicationResponse = await fetch("/api/loan/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...getCsrfHeaders() },
      body: JSON.stringify({
        borrowerAddress: publicKey,
        amount: getValues("firstDepositAmount"),
        loanType,
      }),
    });
    const applicationBody = await applicationResponse.json().catch(() => ({}));
    if (!applicationResponse.ok) {
      throw new Error(applicationBody.message ?? "Loan application submission failed.");
    }
    return true;
  };

  const getCsrfHeaders = (): Record<string, string> => {
    const csrf = document.cookie
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith("csrfToken="))
      ?.slice("csrfToken=".length);
    return csrf ? { "x-csrf-token": decodeURIComponent(csrf) } : {};
  };

  const authenticateApplicant = async (): Promise<boolean> => {
    if (!publicKey) {
      toast.error("Connect your Stellar wallet before continuing.");
      return false;
    }
    const challengeResponse = await fetch("/api/verification/challenge", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...getCsrfHeaders() },
      body: JSON.stringify({ walletAddress: publicKey, network: "stellar" }),
    });
    const challengeBody = await challengeResponse.json();
    if (!challengeResponse.ok || typeof challengeBody.challenge !== "string") {
      toast.error(challengeBody.message ?? "Could not start wallet verification.");
      return false;
    }
    const signature = await signMessage(challengeBody.challenge);
    if (!signature) {
      toast.error("Wallet signature is required to access applicant documents.");
      return false;
    }
    const verifyResponse = await fetch("/api/verification/verify-ownership", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...getCsrfHeaders() },
      body: JSON.stringify({
        walletAddress: publicKey,
        network: "stellar",
        challenge: challengeBody.challenge,
        signature,
      }),
    });
    if (!verifyResponse.ok) {
      toast.error("Wallet verification failed. Please try again.");
      return false;
    }
    setAuthenticatedAddress(publicKey);
    return true;
  };

  const monthlyContribution = useMemo(() => {
    if (watchedDuration > 0 && watchedTarget > 0) {
      return (watchedTarget / watchedDuration).toFixed(2);
    }
    return "0.00";
  }, [watchedTarget, watchedDuration]);

  const renderStepContent = () => {
    switch (step) {
      case 1: // Connect Wallet
        return (
          <div className="text-center space-y-6">
            <div>
              <h3 className="text-xl font-bold text-white mb-2">Connect Freighter Wallet</h3>
              <p className="text-xs text-slate-400">
                Connect your wallet to check USDC balance and interact with Soroban escrow.
              </p>
            </div>
            {publicKey ? (
              <div className="p-5 rounded-2xl bg-slate-950/60 border border-slate-800 text-left space-y-3">
                <div>
                  <p className="text-[10px] text-slate-500 uppercase font-bold tracking-wider">
                    Connected Address
                  </p>
                  <p className="font-mono text-xs text-cyan-400 break-all">{publicKey}</p>
                </div>
                <div>
                  <p className="text-[10px] text-slate-500 uppercase font-bold tracking-wider">
                    USDC Balance
                  </p>
                  <p className="font-mono text-xl font-extrabold text-white">${usdcBalance} USDC</p>
                </div>
              </div>
            ) : (
              <button data-testid="onboarding-connect-wallet" onClick={handleConnect} className="btn-cta py-3.5 px-8" disabled={isLoading}>
                {isLoading ? "Connecting..." : "Connect Freighter Wallet"}
              </button>
            )}
          </div>
        );
      case 2: // Verify Remittances
        return (
          <div className="space-y-4">
            <div>
              <h3 className="text-xl font-bold text-white mb-1">Verify Remittance History</h3>
              <p className="text-xs text-slate-400">
                Enter the Stellar wallet address of your remittance recipient.
              </p>
            </div>
            <label htmlFor="recipientAddress" className="sr-only">
              {FIELD_LABELS.recipientAddress}
            </label>
            <Controller
              name="recipientAddress"
              control={control}
              render={({ field }) => (
                <div className="flex flex-col sm:flex-row gap-3">
                  <input
                    data-testid="onboarding-recipient"
                    type="text"
                    placeholder="Recipient's G... address"
                    className="input-field flex-1 font-mono text-xs"
                    aria-invalid={Boolean(errors.recipientAddress)}
                    aria-describedby={
                      errors.recipientAddress ? "recipientAddress-error" : undefined
                    }
                    value={field.value ?? ""}
                    onChange={(e) => {
                      field.onChange(e.target.value);
                      store.getState().setRecipientAddress(e.target.value);
                    }}
                    onBlur={field.onBlur}
                    disabled={isLoading || isVerified}
                  />
                  <button
                    data-testid="onboarding-verify"
                    onClick={handleVerify}
                    className="btn-cta py-2.5 px-5 !text-xs w-full sm:w-auto"
                    disabled={isLoading || !field.value || isVerified}
                  >
                    {isLoading ? "Auditing..." : isVerified ? "Verified ✓" : "Verify"}
                  </button>
                </div>
              )}
            />
            {errors.recipientAddress && (
              <p id="recipientAddress-error" className="text-red-400 text-xs">
                {errors.recipientAddress.message}
              </p>
            )}
            {verificationMessage && (
              <div
                className={`p-4 rounded-xl text-xs ${isVerified ? "bg-emerald-500/10 border border-emerald-500/20 text-emerald-300" : "bg-red-500/10 border border-red-500/20 text-red-300"}`}
              >
                {verificationMessage}
              </div>
            )}
          </div>
        );
      case 3: // Set Savings Goal
        return (
          <div className="space-y-5">
            <div>
              <h3 className="text-xl font-bold text-white mb-1">Set 30% Down-Payment Goal</h3>
              <p className="text-xs text-slate-400">
                Specify target USDC escrow accumulation and savings timeframe.
              </p>
            </div>
            <div className="space-y-4">
              <div>
                <label
                  htmlFor="savingsTarget"
                  className="text-xs text-slate-300 font-semibold block mb-1"
                >
                  Down Payment Goal (USDC)
                </label>
                <Controller
                  name="savingsTarget"
                  control={control}
                  render={({ field }) => (
                    <input
                      data-testid="onboarding-savings-target"
                      type="number"
                      className="input-field w-full font-mono"
                      aria-invalid={Boolean(errors.savingsTarget)}
                      aria-describedby={errors.savingsTarget ? "savingsTarget-error" : undefined}
                      value={Number.isNaN(field.value) ? "" : field.value}
                      onChange={(e) => {
                        const value = Number(e.target.value);
                        field.onChange(value);
                        store.getState().setSavingsTarget(value);
                      }}
                      onBlur={field.onBlur}
                    />
                  )}
                />
                {errors.savingsTarget && (
                  <p id="savingsTarget-error" className="text-red-400 text-xs mt-1">
                    {errors.savingsTarget.message}
                  </p>
                )}
              </div>
              <div>
                <label
                  htmlFor="savingsDuration"
                  className="text-xs text-slate-300 font-semibold block mb-1"
                >
                  Savings Duration
                </label>
                <Controller
                  name="savingsDuration"
                  control={control}
                  render={({ field }) => (
                    <select
                      id="savingsDuration"
                      ref={field.ref}
                      className="input-field w-full"
                      value={field.value}
                      aria-invalid={Boolean(errors.savingsDuration)}
                      aria-describedby={
                        errors.savingsDuration ? "savingsDuration-error" : undefined
                      }
                      onChange={(e) => {
                        const value = Number(e.target.value) as 6 | 9 | 12;
                        field.onChange(value);
                        store.getState().setSavingsDuration(value);
                      }}
                      onBlur={field.onBlur}
                    >
                      <option value={6}>6 Months</option>
                      <option value={9}>9 Months</option>
                      <option value={12}>12 Months</option>
                    </select>
                  )}
                />
                {errors.savingsDuration && (
                  <p id="savingsDuration-error" className="text-red-400 text-xs mt-1">
                    {errors.savingsDuration.message}
                  </p>
                )}
              </div>

              <div className="p-4 rounded-xl bg-cyan-500/10 border border-cyan-500/20 text-cyan-300 text-xs flex justify-between items-center">
                <span>Estimated Monthly Saving:</span>
                <span className="font-mono font-extrabold text-sm">
                  ${monthlyContribution} USDC / mo
                </span>
              </div>
            </div>
          </div>
        );
      case 4: // Required loan documents
        return (
          <div className="space-y-5">
            <label className="block text-xs text-slate-300 font-semibold">
              Loan purpose
              <select
                value={loanType}
                onChange={(event) => setLoanType(event.target.value as LoanType)}
                className="input-field mt-2 w-full"
                aria-label="Loan purpose"
              >
                <option value="purchase">Purchase an existing property</option>
                <option value="construction">Construct a property</option>
              </select>
            </label>
            <DocumentChecklist
              applicantAddress={publicKey}
              loanType={loanType}
              onEligibilityChange={handleDocumentEligibilityChange}
              onAuthenticate={authenticateApplicant}
            />
          </div>
        );
      case 5: // First Deposit
        return (
          <div className="space-y-5">
            <div>
              <h3 className="text-xl font-bold text-white mb-1">First Deposit Commitment</h3>
              <p className="text-xs text-slate-400">
                Make your initial deposit into the Soroban escrow contract.
              </p>
            </div>
            <div>
              <label
                htmlFor="firstDepositAmount"
                className="text-xs text-slate-300 font-semibold block mb-1"
              >
                Initial Deposit Amount (USDC)
              </label>
              <Controller
                name="firstDepositAmount"
                control={control}
                render={({ field }) => (
                  <input
                    data-testid="onboarding-first-deposit"
                    type="number"
                    className="input-field w-full font-mono"
                    aria-invalid={Boolean(errors.firstDepositAmount)}
                    aria-describedby={
                      errors.firstDepositAmount ? "firstDepositAmount-error" : undefined
                    }
                    value={Number.isNaN(field.value) ? "" : field.value}
                    onChange={(e) => {
                      const value = Number(e.target.value);
                      field.onChange(value);
                      store.getState().setFirstDepositAmount(value);
                    }}
                    onBlur={field.onBlur}
                  />
                )}
              />
              {errors.firstDepositAmount && (
                <p id="firstDepositAmount-error" className="text-red-400 text-xs mt-1">
                  {errors.firstDepositAmount.message}
                </p>
              )}
            </div>
            <button
              data-testid="onboarding-deposit"
              onClick={handleDeposit}
              className="btn-cta w-full justify-center py-3.5"
              disabled={isLoading || !documentsAccepted}
            >
              {isLoading ? "Submitting Application..." : "Submit Loan Application"}
            </button>
            {!documentsAccepted && (
              <p role="status" className="text-xs text-amber-300">
                Application submission is blocked until every required document is accepted.
              </p>
            )}
          </div>
        );
      default:
        return null;
    }
  };

  const handleNext = async () => {
    const currentFields = STEP_FIELDS[step];
    if (currentFields.length > 0) {
      const valid = await trigger(currentFields);
      if (!valid) {
        setErrorAnnouncementKey((key) => key + 1);
        return;
      }
    }

    if (step === 1 && !publicKey) {
      toast.error("Please connect your wallet to continue.");
      return;
    }
    if (step === 2 && !isVerified) {
      toast.error("Please verify your remittance history to continue.");
      return;
    }

    if (step === 4 && !documentsAccepted) {
      toast.error("Submission is blocked until every required document has been accepted.");
      return;
    }
    if (step === 5 && authenticatedAddress !== publicKey) {
      const authenticated = await authenticateApplicant();
      if (!authenticated) return;
    }

    store.getState().setStep(step + 1);
  };

  const handleBack = () => {
    store.getState().setStep(step - 1);
  };

  return (
    <div className="p-6 md:p-8 bg-slate-900/90 border border-slate-800 rounded-2xl shadow-xl w-full max-w-2xl backdrop-blur-xl flex flex-col gap-6">
      {hasDraft && (
        <div className="p-4 bg-amber-500/10 border border-amber-500/20 rounded-xl flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="space-y-1">
            <p className="text-amber-400 font-bold text-sm">Resume Session</p>
            <p className="text-slate-300 text-xs leading-relaxed">
              You have unsaved form data from a previous session
            </p>
          </div>
          <div className="flex items-center gap-2.5 shrink-0">
            <button
              onClick={() => {
                const draft = restoreDraft();
                if (draft) {
                  toast.success("Draft restored!");
                }
              }}
              className="btn-cta text-xs !py-2 !px-4"
            >
              Restore
            </button>
            <button
              onClick={() => {
                dismissDraft();
                toast("Draft dismissed", { icon: "👋" });
              }}
              className="btn-outline text-xs !py-2 !px-4"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}
      <ProgressStepper steps={STEPS} currentStep={step} />
      <div>{renderStepContent()}</div>
      <div className="flex justify-between border-t border-slate-800/80 pt-5">
        <button
          onClick={handleBack}
          disabled={step === 1 || isLoading}
          className="btn-outline text-xs !py-2.5 !px-5"
        >
          Previous Step
        </button>
        {step < STEPS.length && (
          <button
            data-testid="onboarding-next"
            onClick={handleNext}
            disabled={isLoading}
            className="btn-cta text-xs !py-2.5 !px-5"
          >
            Next →
          </button>
        )}
      </div>
    </div>
  );
}
