import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import EvidenceUpload from "../src/components/EvidenceUpload";
import {
  UPLOAD_ERROR_MESSAGES,
  UploadError,
  classifyHttpStatus,
  initialUploadState,
  isRetryable,
  uploadReducer,
  uploadWithProgress,
  type UploadState,
} from "../src/lib/documentUpload";

jest.mock("../src/lib/analytics", () => ({ track: jest.fn() }));

jest.mock("../src/lib/documentUpload", () => ({
  ...jest.requireActual("../src/lib/documentUpload"),
  uploadWithProgress: jest.fn(),
}));

const mockUpload = uploadWithProgress as jest.Mock;

describe("uploadReducer", () => {
  it("uploading → success", () => {
    let s: UploadState = uploadReducer(initialUploadState, { type: "START" });
    expect(s).toEqual({ status: "uploading", progress: 0, attempt: 1 });
    s = uploadReducer(s, { type: "PROGRESS", progress: 42.4 });
    expect(s).toEqual({ status: "uploading", progress: 42, attempt: 1 });
    s = uploadReducer(s, { type: "SUCCESS" });
    expect(s).toEqual({ status: "success", attempt: 1 });
  });

  it("uploading → failed → retry → success", () => {
    let s: UploadState = uploadReducer(initialUploadState, { type: "START" });
    s = uploadReducer(s, { type: "PROGRESS", progress: 60 });
    s = uploadReducer(s, { type: "FAILURE", error: "network" });
    expect(s).toEqual({ status: "failed", error: "network", attempt: 1 });
    s = uploadReducer(s, { type: "RETRY" });
    expect(s).toEqual({ status: "uploading", progress: 0, attempt: 2 });
    s = uploadReducer(s, { type: "SUCCESS" });
    expect(s).toEqual({ status: "success", attempt: 2 });
  });

  it("clamps progress, never moves it backwards, and ignores out-of-order actions", () => {
    let s: UploadState = uploadReducer(initialUploadState, { type: "START" });
    s = uploadReducer(s, { type: "PROGRESS", progress: 150 });
    expect(s).toMatchObject({ progress: 100 });
    s = uploadReducer(s, { type: "PROGRESS", progress: 10 });
    expect(s).toMatchObject({ progress: 100 });

    expect(uploadReducer(initialUploadState, { type: "SUCCESS" })).toBe(initialUploadState);
    expect(uploadReducer(initialUploadState, { type: "RETRY" })).toBe(initialUploadState);
    expect(uploadReducer({ status: "success", attempt: 1 }, { type: "RESET" })).toEqual(
      initialUploadState
    );
  });

  it("classifies failures and which ones are retryable", () => {
    expect(classifyHttpStatus(413)).toBe("file_too_large");
    expect(classifyHttpStatus(415)).toBe("unsupported_type");
    expect(classifyHttpStatus(0)).toBe("network");
    expect(classifyHttpStatus(500)).toBe("server");
    expect(isRetryable("network")).toBe(true);
    expect(isRetryable("server")).toBe(true);
    expect(isRetryable("file_too_large")).toBe(false);
    expect(isRetryable("unsupported_type")).toBe(false);
  });
});

describe("EvidenceUpload progress and retry", () => {
  beforeEach(() => {
    mockUpload.mockReset();
    global.URL.createObjectURL = jest.fn(() => "blob:http://localhost/preview");
  });

  function selectFile() {
    const file = new File(["image"], "proof.png", { type: "image/png" });
    fireEvent.change(document.querySelector('input[type="file"]')!, {
      target: { files: [file] },
    });
    return file;
  }

  it("shows upload progress while the document uploads", async () => {
    let reportProgress: (p: number) => void = () => {};
    let finish: (v: unknown) => void = () => {};
    mockUpload.mockImplementation((_url, _body, onProgress) => {
      reportProgress = onProgress;
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const onSuccess = jest.fn();
    render(<EvidenceUpload milestoneId="m1" onUploadSuccess={onSuccess} />);
    selectFile();

    fireEvent.click(screen.getByRole("button", { name: /Submit Evidence/i }));
    const bar = await screen.findByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "0");

    await waitFor(() => expect(mockUpload).toHaveBeenCalledTimes(1));
    act(() => reportProgress(55));
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "55");
    expect(screen.getByText("Uploading… 55%")).toBeInTheDocument();

    await act(async () => finish({ cid: "bafyprogress" }));
    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith("bafyprogress", expect.any(String)));
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("retries a failed upload without re-selecting the file", async () => {
    mockUpload
      .mockRejectedValueOnce(new UploadError("network"))
      .mockResolvedValueOnce({ cid: "bafyretry" });
    const appendSpy = jest.spyOn(FormData.prototype, "append");
    const onSuccess = jest.fn();
    render(<EvidenceUpload milestoneId="m1" onUploadSuccess={onSuccess} />);
    const file = selectFile();

    fireEvent.click(screen.getByRole("button", { name: /Submit Evidence/i }));
    await waitFor(() => expect(mockUpload).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("alert")).toHaveTextContent(UPLOAD_ERROR_MESSAGES.network);

    fireEvent.click(screen.getByRole("button", { name: /Retry Upload/i }));
    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith("bafyretry", expect.any(String)));

    // Both attempts sent the originally selected File object.
    expect(mockUpload).toHaveBeenCalledTimes(2);
    const sentFiles = appendSpy.mock.calls.filter(([key]) => key === "file").map(([, v]) => v);
    expect(sentFiles).toEqual([file, file]);
    expect(sentFiles[1]).toBe(file);
    appendSpy.mockRestore();
    expect(screen.getByText("Upload Successful")).toBeInTheDocument();
  });

  it("does not offer retry for a server-side file-too-large rejection", async () => {
    mockUpload.mockRejectedValueOnce(new UploadError("file_too_large"));
    render(<EvidenceUpload milestoneId="m1" onUploadSuccess={jest.fn()} />);
    selectFile();

    fireEvent.click(screen.getByRole("button", { name: /Submit Evidence/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      UPLOAD_ERROR_MESSAGES.file_too_large
    );
    expect(screen.queryByRole("button", { name: /Retry Upload/i })).not.toBeInTheDocument();
  });
});
