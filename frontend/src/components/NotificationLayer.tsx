"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { ToastContainer } from "./Toast";
import NotificationDrawer from "./NotificationDrawer";
import { useContractEvents } from "../hooks/useContractEvents";

/**
 * Mounts the toast stack and starts the Soroban event poller. Render once near
 * the app root, inside both WalletProvider and NotificationProvider.
 */
export function NotificationLayer() {
  useContractEvents();
  return (
    <>
      <ToastContainer />
      <NotificationDrawer />
    </>
  );
}

export default NotificationLayer;
