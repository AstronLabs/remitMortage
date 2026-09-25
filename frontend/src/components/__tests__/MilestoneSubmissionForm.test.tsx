// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import MilestoneSubmissionForm, { milestoneDraftKey } from "../MilestoneSubmissionForm";

const DRAFT_KEY = milestoneDraftKey("m1");

function flushAutosave() {
  act(() => {
    jest.advanceTimersByTime(700);
  });
}

function seedDraft() {
  localStorage.setItem(
    DRAFT_KEY,
    JSON.stringify({
      description: "Saved work",
      costItems: [{ label: "Concrete", amount: "500" }],
      evidenceType: "invoice",
      evidenceNotes: "note-1",
      _timestamp: Date.now(),
    })
  );
}

describe("MilestoneSubmissionForm autosave", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    jest.useRealTimers();
    localStorage.clear();
  });

  it("autosaves typed fields to localStorage", () => {
    jest.useFakeTimers();
    render(<MilestoneSubmissionForm milestoneId="m1" onSubmit={jest.fn()} />);

    fireEvent.change(screen.getByLabelText(/Work completed/i), {
      target: { value: "Poured foundation" },
    });
    flushAutosave();

    expect(localStorage.getItem(DRAFT_KEY)).toContain("Poured foundation");
  });

  it("does not autosave an untouched form", () => {
    jest.useFakeTimers();
    render(<MilestoneSubmissionForm milestoneId="m1" onSubmit={jest.fn()} />);

    flushAutosave();

    expect(localStorage.getItem(DRAFT_KEY)).toBeNull();
  });

  it("offers to resume a saved draft and applies it", async () => {
    seedDraft();
    render(<MilestoneSubmissionForm milestoneId="m1" onSubmit={jest.fn()} />);

    expect(await screen.findByText(/unsaved draft/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /resume draft/i }));

    expect(screen.getByLabelText(/Work completed/i)).toHaveValue("Saved work");
    expect(screen.getByDisplayValue("Concrete")).toBeInTheDocument();
    expect(screen.getByDisplayValue("500")).toBeInTheDocument();
  });

  it("discards a saved draft on request", async () => {
    seedDraft();
    render(<MilestoneSubmissionForm milestoneId="m1" onSubmit={jest.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: /discard/i }));

    expect(localStorage.getItem(DRAFT_KEY)).toBeNull();
    expect(screen.getByLabelText(/Work completed/i)).toHaveValue("");
  });

  it("clears the draft once the milestone is successfully submitted", async () => {
    jest.useFakeTimers();
    const onSubmit = jest.fn().mockResolvedValue(undefined);
    render(<MilestoneSubmissionForm milestoneId="m1" onSubmit={onSubmit} />);

    fireEvent.change(screen.getByLabelText(/Work completed/i), {
      target: { value: "Completed the roof" },
    });
    flushAutosave();
    expect(localStorage.getItem(DRAFT_KEY)).not.toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /save milestone submission/i }));
    });

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(DRAFT_KEY)).toBeNull();
  });

  it("keeps the draft when submission fails", async () => {
    jest.useFakeTimers();
    const onSubmit = jest.fn().mockRejectedValue(new Error("network"));
    render(<MilestoneSubmissionForm milestoneId="m1" onSubmit={onSubmit} />);

    fireEvent.change(screen.getByLabelText(/Work completed/i), {
      target: { value: "Completed the roof" },
    });
    flushAutosave();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /save milestone submission/i }));
    });

    expect(screen.getByRole("alert")).toHaveTextContent(/could not submit/i);
    expect(localStorage.getItem(DRAFT_KEY)).not.toBeNull();
  });

  it("blocks submission without a description", async () => {
    const onSubmit = jest.fn();
    render(<MilestoneSubmissionForm milestoneId="m1" onSubmit={onSubmit} />);

    fireEvent.click(screen.getByRole("button", { name: /save milestone submission/i }));

    return waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/describe the work/i);
      expect(onSubmit).not.toHaveBeenCalled();
    });
  });
});
