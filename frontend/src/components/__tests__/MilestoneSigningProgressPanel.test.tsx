// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React from "react";
import { render, screen, waitFor, act } from "@testing-library/react";
import MilestoneSigningProgressPanel from "../MilestoneSigningProgressPanel";
import type { MilestoneSigningStatus } from "@/lib/milestoneSigning";

jest.mock("@/context/WalletContext", () => ({
  useWallet: () => ({
    publicKey: "GTESTTESTTESTTESTTESTTESTTESTTESTTESTTESTTESTTESTTESTTEST",
    isConnected: true,
  }),
}));

jest.mock("@/context/ToastContext", () => ({
  useToast: () => ({
    toast: jest.fn(),
  }),
}));

function makeStatus(overrides: Partial<MilestoneSigningStatus> = {}): MilestoneSigningStatus {
  return {
    proposalId: "prop-1",
    milestoneId: "m1",
    evidenceCid: "bafytest",
    status: "Open",
    requiredWeight: 3,
    totalWeight: 4,
    currentWeight: 1,
    signers: [
      {
        address: "GLEAD00000000000000000000000000000000000000000000000",
        label: "Committee Lead",
        weight: 2,
        status: "pending",
      },
      {
        address: "GLEGAL0000000000000000000000000000000000000000000000",
        label: "Legal Review",
        weight: 1,
        status: "approved",
      },
      {
        address: "GFIN00000000000000000000000000000000000000000000000A",
        label: "Finance Board",
        weight: 1,
        status: "pending",
      },
    ],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("MilestoneSigningProgressPanel", () => {
  beforeEach(() => {
    jest.useFakeTimers({ legacyFakeTimers: false });
  });

  afterEach(() => {
    act(() => {
      jest.runOnlyPendingTimers();
    });
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("shows a loading state before the first fetch resolves", async () => {
    global.fetch = jest.fn().mockReturnValue(new Promise(() => {})); // never resolves

    render(<MilestoneSigningProgressPanel proposalId="prop-1" pollIntervalMs={50000} />);

    expect(screen.getByTestId("signature-queue-loading")).toBeInTheDocument();
  });

  it("renders signer rows color-coded by status once loaded", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => makeStatus(),
    });

    render(<MilestoneSigningProgressPanel proposalId="prop-1" pollIntervalMs={50000} />);

    await waitFor(() => expect(screen.getByTestId("signature-queue-panel")).toBeInTheDocument());

    const rows = screen.getAllByTestId("queue-signer-row");
    expect(rows).toHaveLength(3);
    expect(rows.filter((r) => r.dataset.status === "approved")).toHaveLength(1);
    expect(rows.filter((r) => r.dataset.status === "pending")).toHaveLength(2);

    // Not yet at quorum — no quorum-reached banner.
    expect(screen.queryByTestId("quorum-reached-banner")).not.toBeInTheDocument();
  });

  it("shows the quorum-reached banner and fires onFullyApproved once quorum is met", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => makeStatus({ status: "Passed", currentWeight: 3 }),
    });
    const onFullyApproved = jest.fn();

    render(
      <MilestoneSigningProgressPanel
        proposalId="prop-1"
        pollIntervalMs={50000}
        onFullyApproved={onFullyApproved}
      />
    );

    await waitFor(() =>
      expect(screen.getByTestId("quorum-reached-banner")).toBeInTheDocument()
    );
    expect(onFullyApproved).toHaveBeenCalledTimes(1);
  });

  it("polls for updates and reflects a newly-signed signer without a page reload", async () => {
    const openStatus = makeStatus();
    const passedStatus = makeStatus({
      status: "Passed",
      currentWeight: 3,
      signers: openStatus.signers.map((s) => ({ ...s, status: "approved" })),
    });

    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => openStatus })
      .mockResolvedValueOnce({ ok: true, json: async () => passedStatus });
    global.fetch = fetchMock;

    render(<MilestoneSigningProgressPanel proposalId="prop-1" pollIntervalMs={1000} />);

    await waitFor(() => expect(screen.getByTestId("signature-queue-panel")).toBeInTheDocument());
    expect(screen.queryByTestId("quorum-reached-banner")).not.toBeInTheDocument();

    await act(async () => {
      jest.advanceTimersByTime(1000);
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(screen.getByTestId("quorum-reached-banner")).toBeInTheDocument()
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
