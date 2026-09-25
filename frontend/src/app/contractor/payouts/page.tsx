"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React from "react";
import { OptionalWalletProvider } from "@/context/WalletContext";
import { OptionalToastProvider } from "@/context/ToastContext";
import PayoutHistoryClient from "./PayoutHistoryClient";

export default function ContractorPayoutHistoryPage() {
  return (
    <OptionalToastProvider>
      <OptionalWalletProvider>
        <PayoutHistoryClient />
      </OptionalWalletProvider>
    </OptionalToastProvider>
  );
}
