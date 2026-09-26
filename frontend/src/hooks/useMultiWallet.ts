"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { useCallback, useState } from "react";
import { BrowserProvider } from "ethers";

export type WalletType = "stellar" | "evm" | "solana" | null;
type EthereumProvider = ConstructorParameters<typeof BrowserProvider>[0];

interface SolanaProvider {
  isPhantom?: boolean;
  connect: () => Promise<{ publicKey: { toString: () => string } }>;
  signMessage: (message: Uint8Array, encoding: string) => Promise<{ signature: Uint8Array }>;
}

type WalletWindow = Window & {
  ethereum?: EthereumProvider;
  solana?: SolanaProvider;
};

interface WalletState {
  address: string | null;
  type: WalletType;
  isConnected: boolean;
  isConnecting: boolean;
  error: string | null;
}

const getWalletWindow = (): WalletWindow => window as WalletWindow;

const getErrorMessage = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;

export const useMultiWallet = () => {
  const [walletState, setWalletState] = useState<WalletState>({
    address: null,
    type: null,
    isConnected: false,
    isConnecting: false,
    error: null,
  });

  const connectEVM = async () => {
    try {
      setWalletState((prev) => ({ ...prev, isConnecting: true, error: null }));

      // Check for MetaMask/EVM Provider
      const { ethereum } = getWalletWindow();
      if (!ethereum) {
        throw new Error("MetaMask or EVM provider is not installed!");
      }

      const provider = new BrowserProvider(ethereum);
      const accounts = await provider.send("eth_requestAccounts", []);
      const address = accounts[0];

      setWalletState({
        address,
        type: "evm",
        isConnected: true,
        isConnecting: false,
        error: null,
      });
      return address;
    } catch (error) {
      setWalletState((prev) => ({
        ...prev,
        isConnecting: false,
        error: getErrorMessage(error, "Failed to connect EVM wallet"),
      }));
      return null;
    }
  };

  const connectSolana = async () => {
    try {
      setWalletState((prev) => ({ ...prev, isConnecting: true, error: null }));

      // Check for Phantom Provider
      const { solana } = getWalletWindow();
      if (!solana || !solana.isPhantom) {
        throw new Error("Phantom wallet is not installed!");
      }

      const response = await solana.connect();
      const address = response.publicKey.toString();

      setWalletState({
        address,
        type: "solana",
        isConnected: true,
        isConnecting: false,
        error: null,
      });
      return address;
    } catch (error) {
      setWalletState((prev) => ({
        ...prev,
        isConnecting: false,
        error: getErrorMessage(error, "Failed to connect Solana wallet"),
      }));
      return null;
    }
  };

  const disconnect = useCallback(() => {
    // Explicitly clear all non-Stellar wallet states from the context/state
    setWalletState({
      address: null,
      type: null,
      isConnected: false,
      isConnecting: false,
      error: null,
    });
  }, []);

  const signMessage = async (message: string): Promise<string | null> => {
    try {
      if (!walletState.isConnected || !walletState.address || !walletState.type) {
        throw new Error("No wallet connected");
      }

      if (walletState.type === "evm") {
        const { ethereum } = getWalletWindow();
        if (!ethereum) {
          throw new Error("MetaMask or EVM provider is not installed!");
        }

        const provider = new BrowserProvider(ethereum);
        const signer = await provider.getSigner();
        // EIP-191 personal_sign handled automatically by ethers.js signMessage
        const signature = await signer.signMessage(message);
        return signature;
      }

      if (walletState.type === "solana") {
        const { solana } = getWalletWindow();
        if (!solana) {
          throw new Error("Phantom wallet is not installed!");
        }

        const encodedMessage = new TextEncoder().encode(message);

        // window.solana.signMessage returns { signature, publicKey }
        const signedMessage = await solana.signMessage(encodedMessage, "utf8");

        // Convert Uint8Array signature to Hex string
        const hexSignature = Array.from(signedMessage.signature)
          .map((byte) => byte.toString(16).padStart(2, "0"))
          .join("");

        return hexSignature;
      }

      return null;
    } catch (error) {
      setWalletState((prev) => ({
        ...prev,
        error: getErrorMessage(error, "Message signing failed or was rejected by the user"),
      }));
      return null;
    }
  };

  return {
    ...walletState,
    connectEVM,
    connectSolana,
    disconnect,
    signMessage,
  };
};
