// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Document upload progress + retry state machine (issue #695).
 *
 *   idle ──START──▶ uploading ──PROGRESS──▶ uploading
 *                      │  ├──SUCCESS──▶ success
 *                      │  └──FAILURE──▶ failed ──RETRY──▶ uploading
 *
 * The selected file lives outside this state (in the component), so a failed
 * upload can be retried without re-selecting it.
 */

export type UploadErrorKind = "network" | "file_too_large" | "unsupported_type" | "server";

export type UploadState =
  | { status: "idle" }
  | { status: "uploading"; progress: number; attempt: number }
  | { status: "success"; attempt: number }
  | { status: "failed"; error: UploadErrorKind; attempt: number };

export type UploadAction =
  | { type: "START" }
  | { type: "PROGRESS"; progress: number }
  | { type: "SUCCESS" }
  | { type: "FAILURE"; error: UploadErrorKind }
  | { type: "RETRY" }
  | { type: "RESET" };

export const initialUploadState: UploadState = { status: "idle" };

function clampProgress(progress: number): number {
  if (!Number.isFinite(progress)) return 0;
  return Math.min(100, Math.max(0, Math.round(progress)));
}

export function uploadReducer(state: UploadState, action: UploadAction): UploadState {
  switch (action.type) {
    case "START":
      return state.status === "uploading"
        ? state
        : { status: "uploading", progress: 0, attempt: 1 };
    case "PROGRESS":
      return state.status === "uploading"
        ? { ...state, progress: Math.max(state.progress, clampProgress(action.progress)) }
        : state;
    case "SUCCESS":
      return state.status === "uploading" ? { status: "success", attempt: state.attempt } : state;
    case "FAILURE":
      return state.status === "uploading"
        ? { status: "failed", error: action.error, attempt: state.attempt }
        : state;
    case "RETRY":
      return state.status === "failed"
        ? { status: "uploading", progress: 0, attempt: state.attempt + 1 }
        : state;
    case "RESET":
      return initialUploadState;
    default:
      return state;
  }
}

export const UPLOAD_ERROR_MESSAGES: Record<UploadErrorKind, string> = {
  network:
    "Network error — the upload could not reach the server. Check your connection and retry.",
  file_too_large: "File size exceeds 10MB limit.",
  unsupported_type: "Unsupported file type. Please upload JPG, PNG, WEBP, or MP4.",
  server: "The server could not process the upload. Please retry.",
};

/** Whether retrying the same file can succeed. */
export function isRetryable(error: UploadErrorKind): boolean {
  return error === "network" || error === "server";
}

/** Map an HTTP status from the upload endpoint to an error kind. */
export function classifyHttpStatus(status: number): UploadErrorKind {
  if (status === 413) return "file_too_large";
  if (status === 415) return "unsupported_type";
  if (status === 0) return "network";
  return "server";
}

export class UploadError extends Error {
  constructor(public readonly kind: UploadErrorKind) {
    super(UPLOAD_ERROR_MESSAGES[kind]);
    this.name = "UploadError";
  }
}

/**
 * POST `body` to `url` with upload progress reporting. `fetch` cannot observe
 * request-body progress, so this uses XMLHttpRequest. Resolves with the parsed
 * JSON response; rejects with an {@link UploadError}.
 */
export function uploadWithProgress<T = unknown>(
  url: string,
  body: FormData,
  onProgress: (percent: number) => void
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);

    xhr.upload.onprogress = (event: ProgressEvent) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress((event.loaded / event.total) * 100);
      }
    };
    xhr.onerror = () => reject(new UploadError("network"));
    xhr.ontimeout = () => reject(new UploadError("network"));
    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new UploadError(classifyHttpStatus(xhr.status)));
        return;
      }
      try {
        onProgress(100);
        resolve(JSON.parse(xhr.responseText) as T);
      } catch {
        reject(new UploadError("server"));
      }
    };

    xhr.send(body);
  });
}
