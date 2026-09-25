"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React from "react";
import { SignatureQueueManager } from "./SignatureQueueManager";

export interface MilestoneSigningProgressPanelProps {
  proposalId: string;
  onFullyApproved?: () => void;
  pollIntervalMs?: number;
}

export default function MilestoneSigningProgressPanel(props: MilestoneSigningProgressPanelProps) {
  return <SignatureQueueManager {...props} />;
}
