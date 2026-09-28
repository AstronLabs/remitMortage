"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2, CircleAlert, Clock3, FileUp, LoaderCircle, XCircle } from "lucide-react";
import {
  canSubmitApplication,
  getChecklistStatus,
  getLatestDocument,
  getSubmissionBlockMessage,
  normalizeDocumentStatus,
  REQUIRED_DOCUMENTS,
  type ApplicantDocument,
  type LoanType,
} from "@/lib/document-checklist";

const STATUS_LABELS = {
  missing: "Missing",
  uploaded: "Uploaded",
  under_review: "Under review",
  accepted: "Accepted",
  rejected: "Rejected",
} as const;

const STATUS_STYLES = {
  missing: "border-slate-700 bg-slate-900/60 text-slate-400",
  uploaded: "border-sky-500/30 bg-sky-500/10 text-sky-300",
  under_review: "border-amber-500/30 bg-amber-500/10 text-amber-300",
  accepted: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
  rejected: "border-red-500/30 bg-red-500/10 text-red-300",
} as const;

const STATUS_ICONS = {
  missing: CircleAlert,
  uploaded: FileUp,
  under_review: Clock3,
  accepted: CheckCircle2,
  rejected: XCircle,
} as const;

export interface DocumentChecklistProps {
  applicantAddress: string | null;
  loanType: LoanType;
  pollIntervalMs?: number;
  onEligibilityChange?: (eligible: boolean) => void;
  onAuthenticate?: () => Promise<boolean>;
}

export function normalizeApplicantDocuments(payload: unknown): ApplicantDocument[] {
  if (!Array.isArray(payload)) return [];
  return payload.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const document = entry as Record<string, unknown>;
    if (
      typeof document.documentId !== "string" ||
      typeof document.documentType !== "string" ||
      typeof document.originalName !== "string" ||
      typeof document.uploadedAt !== "string"
    ) return [];
    return [{
      documentId: document.documentId,
      documentType: document.documentType as ApplicantDocument["documentType"],
      status: normalizeDocumentStatus(typeof document.status === "string" ? document.status : undefined),
      originalName: document.originalName,
      uploadedAt: document.uploadedAt,
      ...(typeof document.reviewMessage === "string" ? { reviewMessage: document.reviewMessage } : {}),
    }];
  });
}

export default function DocumentChecklist({
  applicantAddress,
  loanType,
  pollIntervalMs = 5000,
  onEligibilityChange,
  onAuthenticate,
}: DocumentChecklistProps) {
  const [documents, setDocuments] = useState<ApplicantDocument[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploadingType, setUploadingType] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const [needsAuthentication, setNeedsAuthentication] = useState(false);

  const csrfHeaders = (): Record<string, string> => {
    const csrf = document.cookie.split(";").map((part) => part.trim())
      .find((part) => part.startsWith("csrfToken="))?.slice("csrfToken=".length);
    return csrf ? { "x-csrf-token": decodeURIComponent(csrf) } : {};
  };

  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (!applicantAddress) {
      setDocuments([]);
      return;
    }
    setLoading(true);
    try {
      const response = await fetch(`/api/kyc/${encodeURIComponent(applicantAddress)}/documents`, {
        cache: "no-store",
        signal,
      });
      if (response.status === 401) {
        setNeedsAuthentication(true);
        setError(null);
        return;
      }
      if (!response.ok) throw new Error("Unable to load your document checklist. Please retry.");
      setDocuments(normalizeApplicantDocuments(await response.json()));
      setNeedsAuthentication(false);
      setError(null);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      setError(err instanceof Error ? err.message : "Unable to load your documents.");
    } finally {
      setLoading(false);
    }
  }, [applicantAddress]);

  useEffect(() => {
    const controller = new AbortController();
    const initialLoad = window.setTimeout(() => void refresh(controller.signal), 0);
    if (!applicantAddress) {
      return () => {
        clearTimeout(initialLoad);
        controller.abort();
      };
    }

    const interval = setInterval(() => void refresh(), pollIntervalMs);
    return () => {
      clearTimeout(initialLoad);
      controller.abort();
      clearInterval(interval);
    };
  }, [applicantAddress, pollIntervalMs, refresh, refreshToken]);

  const eligible = useMemo(() => canSubmitApplication(loanType, documents), [loanType, documents]);
  const blockMessage = useMemo(() => getSubmissionBlockMessage(loanType, documents), [loanType, documents]);

  useEffect(() => onEligibilityChange?.(eligible), [eligible, onEligibilityChange]);

  const handleUpload = async (documentType: string, file: File) => {
    if (!applicantAddress) {
      setError("Connect and verify your wallet before uploading documents.");
      return;
    }
    setUploadingType(documentType);
    setError(null);
    if (needsAuthentication && onAuthenticate) {
      const authenticated = await onAuthenticate();
      if (!authenticated) {
        setUploadingType(null);
        return;
      }
      setNeedsAuthentication(false);
    }
    const form = new FormData();
    form.set("documentType", documentType);
    form.set("document", file);
    try {
      const response = await fetch(`/api/kyc/${encodeURIComponent(applicantAddress)}/upload`, {
        method: "POST",
        headers: csrfHeaders(),
        body: form,
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.message ?? "Document upload failed. Please try again.");
      setRefreshToken((value) => value + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Document upload failed.");
    } finally {
      setUploadingType(null);
    }
  };

  return (
    <section aria-labelledby="document-checklist-title" className="space-y-4">
      <div>
        <h3 id="document-checklist-title" className="text-xl font-bold text-white mb-1">
          Required loan documents
        </h3>
        <p className="text-xs text-slate-400">
          Upload each item below. Review updates appear automatically; every required document must be accepted before submission.
        </p>
      </div>

      {!applicantAddress && (
        <p role="status" className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-300">
          Connect your Stellar wallet to load and upload applicant documents.
        </p>
      )}

      {applicantAddress && needsAuthentication && onAuthenticate && (
        <button
          type="button"
          onClick={async () => {
            const authenticated = await onAuthenticate();
            if (authenticated) {
              setNeedsAuthentication(false);
              setRefreshToken((value) => value + 1);
            }
          }}
          className="rounded-lg border border-cyan-500/30 px-3 py-2 text-xs font-semibold text-cyan-300 hover:bg-cyan-500/10"
        >
          Verify wallet to load and upload documents
        </button>
      )}

      {error && <p role="alert" className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-300">{error}</p>}

      {loading && documents.length === 0 ? (
        <p role="status" className="flex items-center gap-2 text-xs text-slate-400">
          <LoaderCircle className="h-4 w-4 animate-spin" /> Loading documents…
        </p>
      ) : (
        <ul className="space-y-3">
          {REQUIRED_DOCUMENTS[loanType].map((required) => {
            const status = getChecklistStatus(required.type, documents);
            const latest = getLatestDocument(required.type, documents);
            const Icon = STATUS_ICONS[status];
            return (
              <li key={required.type} className="rounded-xl border border-slate-800 bg-slate-950/50 p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-slate-100">{required.label}</p>
                    {latest && <p className="mt-1 truncate text-xs text-slate-500">{latest.originalName}</p>}
                    {latest?.reviewMessage && status === "rejected" && (
                      <p className="mt-1 text-xs text-red-300">{latest.reviewMessage}</p>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold ${STATUS_STYLES[status]}`}>
                      <Icon className="h-3.5 w-3.5" /> {STATUS_LABELS[status]}
                    </span>
                    {status !== "accepted" && applicantAddress && (
                      <label className="cursor-pointer rounded-lg border border-slate-700 px-3 py-1.5 text-xs font-semibold text-cyan-300 hover:border-cyan-500/50">
                        {uploadingType === required.type ? "Uploading…" : status === "missing" ? "Upload" : "Replace"}
                        <input
                          type="file"
                          accept="application/pdf,image/jpeg,image/png"
                          className="sr-only"
                          aria-label={`Upload ${required.label}`}
                          disabled={uploadingType !== null}
                          onChange={(event) => {
                            const file = event.currentTarget.files?.[0];
                            if (file) void handleUpload(required.type, file);
                            event.currentTarget.value = "";
                          }}
                        />
                      </label>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {!eligible && (
        <p role="status" aria-live="polite" className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">
          {blockMessage}
        </p>
      )}
    </section>
  );
}