// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React, { useRef, useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import KeyboardShortcutsModal from "../KeyboardShortcutsModal";
import IdleSessionModal from "../IdleSessionModal";
import { SubmitProposalModal } from "../governance/SubmitProposalModal";
import { GovernanceVotingModal } from "../governance/GovernanceVotingModal";
import ConfirmationDialog from "../ConfirmationDialog";

function HarnessModal({
  title,
  onClose,
  isOpen,
}: {
  title: string;
  onClose: () => void;
  isOpen: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, isOpen, { onEscape: onClose });
  if (!isOpen) return null;
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="harness-title">
      <div ref={ref} tabIndex={-1} data-testid="dialog-container">
        <h2 id="harness-title">{title}</h2>
        <button type="button" data-testid="modal-first">
          First Action
        </button>
        <input type="text" data-testid="modal-input" aria-label="Modal input" />
        <button type="button" data-testid="modal-last" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}

function FullPageHarness() {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <header data-testid="page-header">
        <button type="button" data-testid="background-btn">
          Background Header Button
        </button>
        <button
          type="button"
          data-testid="opener-btn"
          onClick={() => setOpen(true)}
        >
          Open Dialog
        </button>
      </header>
      <HarnessModal
        title="Audited Dialog"
        isOpen={open}
        onClose={() => setOpen(false)}
      />
    </div>
  );
}

describe("Modal Focus Trap Audit (#1002)", () => {
  test("moves focus into modal on open, marks background inert/aria-hidden, wraps Tab & Shift+Tab, and restores focus to opener on Escape", () => {
    render(<FullPageHarness />);

    const opener = screen.getByTestId("opener-btn");
    const header = screen.getByTestId("page-header");

    opener.focus();
    expect(document.activeElement).toBe(opener);

    fireEvent.click(opener);

    const first = screen.getByTestId("modal-first");
    const input = screen.getByTestId("modal-input");
    const last = screen.getByTestId("modal-last");

    // Focus moved to first focusable element inside the modal
    expect(document.activeElement).toBe(first);

    // Background sibling is marked inert and aria-hidden while dialog is open
    expect(header.hasAttribute("inert")).toBe(true);
    expect(header.getAttribute("aria-hidden")).toBe("true");

    // Shift+Tab from first element wraps to last element inside modal
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);

    // Tab from last element wraps back to first element inside modal
    fireEvent.keyDown(document, { key: "Tab", shiftKey: false });
    expect(document.activeElement).toBe(first);

    // Focus can move to middle element and never escapes to background
    input.focus();
    expect(document.activeElement).toBe(input);

    // Escape closes the modal and returns focus to opener button
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);

    // Background inert & aria-hidden attributes are cleaned up
    expect(header.hasAttribute("inert")).toBe(false);
    expect(header.getAttribute("aria-hidden")).toBeNull();
  });

  test("KeyboardShortcutsModal traps focus, closes on Escape, and restores focus to trigger", () => {
    function Wrapper() {
      const [open, setOpen] = useState(false);
      return (
        <div>
          <button data-testid="shortcuts-trigger" onClick={() => setOpen(true)}>
            Show Shortcuts
          </button>
          <KeyboardShortcutsModal isOpen={open} onClose={() => setOpen(false)} />
        </div>
      );
    }

    render(<Wrapper />);
    const trigger = screen.getByTestId("shortcuts-trigger");
    trigger.focus();
    fireEvent.click(trigger);

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");

    const closeBtn = screen.getByLabelText("Close keyboard shortcuts modal");
    const gotItBtn = screen.getByText("Got it (Esc)");
    expect(document.activeElement).toBe(closeBtn);

    // Shift+Tab wraps to last button in modal
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(gotItBtn);

    // Tab wraps back to first button in modal
    fireEvent.keyDown(document, { key: "Tab", shiftKey: false });
    expect(document.activeElement).toBe(closeBtn);

    // Escape closes and returns focus to trigger
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  test("IdleSessionModal traps focus between Stay Logged In and Log Out and restores focus", () => {
    function Wrapper() {
      const [open, setOpen] = useState(false);
      return (
        <div>
          <button data-testid="idle-trigger" onClick={() => setOpen(true)}>
            Simulate Idle
          </button>
          <IdleSessionModal
            isOpen={open}
            remainingSeconds={45}
            onExtendSession={() => setOpen(false)}
            onLogoutNow={() => setOpen(false)}
          />
        </div>
      );
    }

    render(<Wrapper />);
    const trigger = screen.getByTestId("idle-trigger");
    trigger.focus();
    fireEvent.click(trigger);

    const extendBtn = screen.getByTestId("extend-session-btn");
    const logoutBtn = screen.getByTestId("logout-now-btn");
    expect(document.activeElement).toBe(extendBtn);

    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(logoutBtn);

    fireEvent.keyDown(document, { key: "Tab", shiftKey: false });
    expect(document.activeElement).toBe(extendBtn);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("idle-warning-modal")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  test("SubmitProposalModal and GovernanceVotingModal trap focus and restore opener on Escape", () => {
    function Wrapper() {
      const [openSubmit, setOpenSubmit] = useState(false);
      const [openVote, setOpenVote] = useState(false);
      return (
        <div>
          <button data-testid="open-submit" onClick={() => setOpenSubmit(true)}>
            New Proposal
          </button>
          <button data-testid="open-vote" onClick={() => setOpenVote(true)}>
            Vote Proposal
          </button>
          <SubmitProposalModal
            isOpen={openSubmit}
            onClose={() => setOpenSubmit(false)}
            onSubmit={async () => {}}
          />
          <GovernanceVotingModal
            isOpen={openVote}
            onClose={() => setOpenVote(false)}
            proposal={{
              id: "prop-1",
              title: "Increase Reserve Buffer",
              description: "Adjust reserve threshold",
              status: "pending",
              currentVotes: 40,
              requiredVotes: 100,
              quorumPercent: 60,
              expiration: "2d",
            }}
            onVote={async () => {}}
          />
        </div>
      );
    }

    render(<Wrapper />);
    const submitTrigger = screen.getByTestId("open-submit");
    submitTrigger.focus();
    fireEvent.click(submitTrigger);

    expect(screen.getByRole("dialog")).toHaveAttribute("aria-modal", "true");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(submitTrigger);

    const voteTrigger = screen.getByTestId("open-vote");
    voteTrigger.focus();
    fireEvent.click(voteTrigger);

    expect(screen.getByRole("dialog")).toHaveAttribute("aria-modal", "true");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(voteTrigger);
  });

  test("ConfirmationDialog traps focus, closes on Escape, and returns focus to opener", () => {
    function Wrapper() {
      const [open, setOpen] = useState(false);
      return (
        <div>
          <button data-testid="confirm-trigger" onClick={() => setOpen(true)}>
            Delete Item
          </button>
          <ConfirmationDialog
            isOpen={open}
            title="Confirm deletion"
            description="Are you sure?"
            confirmLabel="Delete"
            onConfirm={() => setOpen(false)}
            onCancel={() => setOpen(false)}
          />
        </div>
      );
    }

    render(<Wrapper />);
    const trigger = screen.getByTestId("confirm-trigger");
    trigger.focus();
    fireEvent.click(trigger);

    expect(screen.getByRole("alertdialog")).toHaveAttribute("aria-modal", "true");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
