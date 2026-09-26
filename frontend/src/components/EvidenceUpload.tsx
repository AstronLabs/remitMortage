"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React, { useReducer, useState, useRef } from "react";
import { track } from "../lib/analytics";
import {
  UPLOAD_ERROR_MESSAGES,
  UploadError,
  initialUploadState,
  isRetryable,
  uploadReducer,
  uploadWithProgress,
  type UploadErrorKind,
} from "../lib/documentUpload";

interface EvidenceUploadProps {
  milestoneId: string;
  onUploadSuccess: (cid: string, sha256Hash?: string) => void;
}

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp", "video/mp4"];

/**
 * Computes Web Crypto API SHA-256 file digest.
 */
export async function computeSha256(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export default function EvidenceUpload({ milestoneId, onUploadSuccess }: EvidenceUploadProps) {
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [upload, dispatch] = useReducer(uploadReducer, initialUploadState);
  const isUploading = upload.status === "uploading";
  const [cid, setCid] = useState<string | null>(null);
  const [sha256Hash, setSha256Hash] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setError(null);
    setCid(null);
    setSha256Hash(null);
    dispatch({ type: "RESET" });

    const selectedFile = e.target.files?.[0];
    if (!selectedFile) return;

    if (!ALLOWED_TYPES.includes(selectedFile.type)) {
      setError(UPLOAD_ERROR_MESSAGES.unsupported_type);
      setFile(null);
      setPreviewUrl(null);
      return;
    }

    if (selectedFile.size > MAX_FILE_SIZE) {
      setError(UPLOAD_ERROR_MESSAGES.file_too_large);
      setFile(null);
      setPreviewUrl(null);
      return;
    }

    setFile(selectedFile);
    const objectUrl = URL.createObjectURL(selectedFile);
    setPreviewUrl(objectUrl);
  };

  // The selected file stays in state after a failure, so retry re-sends it
  // without the applicant having to pick it again.
  const handleUpload = async (isRetry = false) => {
    if (!file) return;

    dispatch({ type: isRetry ? "RETRY" : "START" });
    setError(null);

    try {
      const hashHex = await computeSha256(file);
      setSha256Hash(hashHex);

      const formData = new FormData();
      formData.append("file", file);
      formData.append("milestoneId", milestoneId);
      formData.append("sha256_hash", hashHex);

      const data = await uploadWithProgress<{ cid?: string }>(
        "/api/milestone/upload",
        formData,
        (progress) => dispatch({ type: "PROGRESS", progress })
      );
      if (data.cid) {
        dispatch({ type: "SUCCESS" });
        setCid(data.cid);
        track("document_uploaded", { documentType: "milestone_evidence" });
        onUploadSuccess(data.cid, hashHex);
      } else {
        throw new UploadError("server");
      }
    } catch (err: unknown) {
      const kind: UploadErrorKind = err instanceof UploadError ? err.kind : "network";
      dispatch({ type: "FAILURE", error: kind });
      setError(UPLOAD_ERROR_MESSAGES[kind]);
    }
  };

  return (
    <div className="mt-4 p-4 bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-md">
      <h4 className="text-md font-semibold mb-3">Upload Evidence</h4>

      {!cid ? (
        <div className="space-y-4">
          <label htmlFor={`evidence-upload-${milestoneId}`} className="sr-only">
            Upload Evidence
          </label>
          <input
            id={`evidence-upload-${milestoneId}`}
            type="file"
            ref={fileInputRef}
            onChange={handleFileChange}
            accept="image/jpeg, image/png, image/webp, video/mp4"
            className="block w-full text-sm text-[var(--text-secondary)]
              file:mr-4 file:py-2 file:px-4
              file:rounded-full file:border-0
              file:text-sm file:font-semibold
              file:bg-[var(--accent-primary)] file:text-white
              hover:file:bg-[var(--accent-primary-light)]
              cursor-pointer"
          />

          {error && (
            <div role="alert" className="text-[var(--error)] text-sm">
              {error}
            </div>
          )}

          {previewUrl && file && (
            <div className="mt-4">
              <p className="text-sm text-[var(--text-muted)] mb-2">Preview:</p>
              {file.type.startsWith("video/") ? (
                <video
                  src={previewUrl}
                  controls
                  className="max-h-48 rounded-md w-full object-contain bg-black"
                />
              ) : (
                <img
                  src={previewUrl}
                  alt="Preview"
                  className="max-h-48 rounded-md w-full object-contain bg-black"
                />
              )}
            </div>
          )}

          {upload.status === "uploading" && (
            <div className="space-y-1" aria-live="polite">
              <div
                role="progressbar"
                aria-label={`Uploading ${file?.name ?? "document"}`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={upload.progress}
                className="h-2 w-full rounded-full bg-[var(--border-color)] overflow-hidden"
              >
                <div
                  className="h-full bg-[var(--accent-primary)] transition-all"
                  style={{ width: `${upload.progress}%` }}
                />
              </div>
              <p className="text-xs text-[var(--text-muted)]">{`Uploading… ${upload.progress}%`}</p>
            </div>
          )}

          {upload.status === "failed" && isRetryable(upload.error) ? (
            <button
              onClick={() => handleUpload(true)}
              className="w-full py-2 rounded-md font-semibold transition-colors bg-[var(--accent-primary)] text-white hover:bg-[var(--accent-primary-light)]"
            >
              Retry Upload
            </button>
          ) : (
            <button
              onClick={() => handleUpload()}
              disabled={!file || isUploading}
              className={`w-full py-2 rounded-md font-semibold transition-colors ${!file || isUploading ? "bg-gray-700 text-gray-400 cursor-not-allowed" : "bg-[var(--success)] text-white hover:bg-emerald-400"}`}
            >
              {isUploading ? "Uploading to IPFS..." : "Submit Evidence"}
            </button>
          )}
        </div>
      ) : (
        <div className="bg-[var(--success)]/10 border border-[var(--success)]/30 rounded-md p-4 flex flex-col items-center">
          <div className="w-10 h-10 rounded-full bg-[var(--success)]/20 text-[var(--success)] flex items-center justify-center mb-2">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="w-5 h-5"
            >
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
              <path d="M22 4L12 14.01l-3-3" />
            </svg>
          </div>
          <p className="text-sm font-semibold text-[var(--success)] mb-1">Upload Successful</p>
          <div className="text-xs text-[var(--text-muted)] w-full overflow-hidden text-ellipsis whitespace-nowrap text-center mb-1">
            {`CID: ${cid}`}
          </div>
          {sha256Hash && (
            <div className="text-[11px] font-mono text-emerald-400/90 w-full overflow-hidden text-ellipsis whitespace-nowrap text-center mb-2">
              {`SHA-256: ${sha256Hash}`}
            </div>
          )}
          <a
            href={`https://ipfs.io/ipfs/${cid}`}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-[var(--accent-secondary)] hover:underline"
          >
            View on IPFS
          </a>
        </div>
      )}
    </div>
  );
}
