"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React, { createContext, useContext, useEffect, useRef, useState } from "react";
import { Horizon } from "@stellar/stellar-sdk";
import { BrowserProvider } from "ethers";
import {
  classifyWalletError,
  isNetworkMismatch,
  WALLET_ERROR_MESSAGES,
  type WalletError,
} from "../lib/wallet-errors";
import { DEFAULT_LEDGER_PATH, getLedgerPublicKey } from "../lib/ledger";

type BalanceLine = {
  asset_code?: string;
  balance: string;
};

type FreighterClient = {
  requestAccess?: () => void | Promise<void>;
  getPublicKey?: () => string | Promise<string>;
  getAccount?: () => string | Promise<string>;
  getNetwork?: () => string | Promise<string>;
  isConnected?: () => boolean | Promise<boolean>;
  isAllowed?: () => boolean | Promise<boolean>;
  signBlob?: (blob: string) => string | Promise<string>;
};

/**
 * Freighter (v1.x) exposes no disconnect event, so the provider polls the
 * extension while a Stellar wallet is connected and tears the session down as
 * soon as access is revoked, the extension disappears, or the active account
 * changes.
 */
const WALLET_POLL_INTERVAL_MS = 3000;

type EthereumProvider = ConstructorParameters<typeof BrowserProvider>[0];

interface SolanaProvider {
  isPhantom?: boolean;
  connect: () => Promise<{ publicKey: { toString: () => string } }>;
  signMessage?: (message: Uint8Array, encoding: string) => Promise<{ signature: Uint8Array }>;
}

type WalletWindow = Window & {
  ethereum?: EthereumProvider;
  solana?: SolanaProvider;
  freighterApi?: FreighterClient;
  freighter?: {
    publicKey?: string;
  };
};

type WalletType = "stellar" | "evm" | "solana" | "ledger" | null;

type WalletContextType = {
  publicKey: string | null;
  evmAddress: string | null;
  solanaAddress: string | null;
  walletType: WalletType;
  isConnected: boolean;
  isConnecting: boolean;
  usdcBalance: string | null;
  network: string | null;
  wrongNetwork: boolean;
  error: string | null;
  /** Classified form of `error`, for UIs that branch on the failure kind. */
  walletError: WalletError | null;
  clearError: () => void;
  connect: () => Promise<string | null>;
  connectLedger: () => Promise<string | null>;
  connectEVM: () => Promise<string | null>;
  connectSolana: () => Promise<string | null>;
  ledgerPath: string;
  setLedgerPath: React.Dispatch<React.SetStateAction<string>>;
  disconnect: () => void;
  disconnectAll: () => void;
  signMessage: (message: string) => Promise<string | null>;
};

const WalletContext = createContext<WalletContextType | undefined>(undefined);

const HORIZON_TESTNET = "https://horizon-testnet.stellar.org";

function getWalletWindow(): WalletWindow {
  return window as WalletWindow;
}

/** Resolve the Freighter client from the injected global or the npm package. */
async function loadFreighter(): Promise<FreighterClient | null> {
  if (typeof window === "undefined") return null;
  const injected = getWalletWindow().freighterApi;
  if (injected) return injected;

  return import("@stellar/freighter-api")
    .then((module) => module as FreighterClient)
    .catch(() => null);
}

async function readFreighterPublicKey(
  freighter: FreighterClient
): Promise<string | null> {
  if (typeof freighter.getPublicKey === "function") {
    return (await freighter.getPublicKey()) || null;
  }
  if (typeof freighter.getAccount === "function") {
    return (await freighter.getAccount()) || null;
  }
  return getWalletWindow().freighter?.publicKey ?? null;
}

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [evmAddress, setEvmAddress] = useState<string | null>(null);
  const [solanaAddress, setSolanaAddress] = useState<string | null>(null);
  const [walletType, setWalletType] = useState<WalletType>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [usdcBalance, setUsdcBalance] = useState<string | null>(null);
  const [ledgerPath, setLedgerPath] = useState<string>(DEFAULT_LEDGER_PATH);
  const [network, setNetwork] = useState<string | null>(null);
  const [wrongNetwork, setWrongNetwork] = useState<boolean>(false);
  const [walletError, setWalletError] = useState<WalletError | null>(null);
  // Mirrors `publicKey` for the polling loop, which must not re-subscribe on
  // every render just to know the currently connected account.
  const publicKeyRef = useRef<string | null>(null);

  const server = new Horizon.Server(HORIZON_TESTNET);

  function reportError(err: unknown) {
    const classified = classifyWalletError(err);
    setWalletError(classified);
    return classified;
  }

  function clearError() {
    setWalletError(null);
  }

  async function fetchBalances(pk: string) {
    try {
      const account = await server.accounts().accountId(pk).call();
      const balances = account.balances as BalanceLine[];
      const usdc = balances.find((balance) => balance.asset_code === "USDC");
      if (usdc) setUsdcBalance(usdc.balance);
      else setUsdcBalance("0");
    } catch {
      setUsdcBalance(null);
    }
  }

  function clearWalletState() {
    setPublicKey(null);
    publicKeyRef.current = null;
    setEvmAddress(null);
    setSolanaAddress(null);
    setWalletType(null);
    setUsdcBalance(null);
    setNetwork(null);
    setWrongNetwork(false);
    setWalletError(null);
    setIsConnecting(false);
  }

  /**
   * Drop the Stellar session without clearing EVM/Solana state, and explain why.
   * Used by the disconnect watcher when Freighter goes away on its own.
   */
  function handleStellarDisconnect(reason: WalletError) {
    setPublicKey(null);
    publicKeyRef.current = null;
    setUsdcBalance(null);
    setNetwork(null);
    setWrongNetwork(false);
    setWalletType((current) => (current === "stellar" ? null : current));
    setWalletError(reason);
  }

  async function connect(): Promise<string | null> {
    setIsConnecting(true);
    setWalletError(null);

    try {
      const freighter = await loadFreighter();
      if (!freighter) throw new Error("Freighter is not available");

      if (typeof freighter.requestAccess === "function") {
        await freighter.requestAccess();
      }

      const pk = await readFreighterPublicKey(freighter);
      if (!pk) throw new Error("Could not get public key from Freighter");

      setPublicKey(pk);
      publicKeyRef.current = pk;
      setWalletType("stellar");

      let net: string | null = null;
      if (typeof freighter.getNetwork === "function") {
        try {
          net = (await freighter.getNetwork()) as string;
        } catch {
          net = null;
        }
      }

      setNetwork(net);
      setWrongNetwork(isNetworkMismatch(net));
      await fetchBalances(pk);
      return pk;
    } catch (err) {
      reportError(err);
      setPublicKey(null);
      publicKeyRef.current = null;
      setWalletType((current) => (current === "stellar" ? null : current));
      return null;
    } finally {
      setIsConnecting(false);
    }
  }

  async function connectLedger(): Promise<string | null> {
    setIsConnecting(true);
    setWalletError(null);

    try {
      const result = await getLedgerPublicKey(ledgerPath);
      const publicKeyFromLedger = result.publicKey;
      setPublicKey(publicKeyFromLedger);
      publicKeyRef.current = publicKeyFromLedger;
      setWalletType("ledger");
      setNetwork(null);
      setWrongNetwork(false);
      await fetchBalances(publicKeyFromLedger);
      return publicKeyFromLedger;
    } catch (err) {
      reportError(err);
      return null;
    } finally {
      setIsConnecting(false);
    }
  }

  async function connectEVM(): Promise<string | null> {
    setIsConnecting(true);
    setWalletError(null);

    try {
      const { ethereum } = getWalletWindow();
      if (!ethereum) {
        throw new Error("MetaMask or EVM provider is not installed!");
      }

      const provider = new BrowserProvider(ethereum);
      const accounts = await provider.send("eth_requestAccounts", []);
      const address = accounts?.[0];
      if (!address) throw new Error("No Ethereum account returned");

      setEvmAddress(address);
      setWalletType("evm");
      return address;
    } catch (err) {
      reportError(err);
      return null;
    } finally {
      setIsConnecting(false);
    }
  }

  async function connectSolana(): Promise<string | null> {
    setIsConnecting(true);
    setWalletError(null);

    try {
      const { solana } = getWalletWindow();
      if (!solana || !solana.isPhantom) {
        throw new Error("Phantom wallet is not installed!");
      }

      const response = await solana.connect();
      const address = response.publicKey.toString();
      setSolanaAddress(address);
      setWalletType("solana");
      return address;
    } catch (err) {
      reportError(err);
      return null;
    } finally {
      setIsConnecting(false);
    }
  }

  function disconnect() {
    clearWalletState();
  }

  function disconnectAll() {
    clearWalletState();
  }

  async function signMessage(message: string): Promise<string | null> {
    try {
      if (walletType === "evm") {
        const { ethereum } = getWalletWindow();
        if (!ethereum) throw new Error("MetaMask or EVM provider is not installed!");

        const provider = new BrowserProvider(ethereum);
        const signer = await provider.getSigner();
        return await signer.signMessage(message);
      }

      if (walletType === "solana") {
        const { solana } = getWalletWindow();
        if (!solana || !solana.signMessage) throw new Error("Phantom wallet is not installed!");

        const encodedMessage = new TextEncoder().encode(message);
        const signedMessage = await solana.signMessage(encodedMessage, "utf8");
        return Array.from(signedMessage.signature)
          .map((byte) => byte.toString(16).padStart(2, "0"))
          .join("");
      }

      if (walletType === "stellar") {
        const freighter = await loadFreighter();
        if (!freighter || typeof freighter.signBlob !== "function") {
          throw new Error("Freighter is not available or does not support signBlob");
        }
        return await freighter.signBlob(message);
      }

      return null;
    } catch (err) {
      reportError(err);
      return null;
    }
  }

  // Watch the extension while a Stellar wallet is connected. Freighter has no
  // disconnect event, so revoked access, a removed extension, or an account
  // switch is detected by polling and tears the session down here.
  useEffect(() => {
    if (!publicKey) return;

    let cancelled = false;

    async function checkConnection() {
      const freighter = await loadFreighter();
      if (cancelled) return;

      if (!freighter) {
        handleStellarDisconnect({
          kind: "not_installed",
          message: WALLET_ERROR_MESSAGES.not_installed,
          recoverable: false,
        });
        return;
      }

      try {
        if (typeof freighter.isConnected === "function") {
          const connected = await freighter.isConnected();
          if (cancelled) return;
          if (!connected) {
            handleStellarDisconnect({
              kind: "disconnected",
              message: WALLET_ERROR_MESSAGES.disconnected,
              recoverable: true,
            });
            return;
          }
        }

        if (typeof freighter.isAllowed === "function") {
          const allowed = await freighter.isAllowed();
          if (cancelled) return;
          if (!allowed) {
            handleStellarDisconnect({
              kind: "disconnected",
              message: WALLET_ERROR_MESSAGES.disconnected,
              recoverable: true,
            });
            return;
          }
        }

        const currentKey = await readFreighterPublicKey(freighter);
        if (cancelled) return;

        if (!currentKey) {
          handleStellarDisconnect({
            kind: "disconnected",
            message: WALLET_ERROR_MESSAGES.disconnected,
            recoverable: true,
          });
          return;
        }

        if (currentKey !== publicKeyRef.current) {
          // Account switched inside Freighter — adopt it and refresh balances.
          publicKeyRef.current = currentKey;
          setPublicKey(currentKey);
          setWalletError(null);
          await fetchBalances(currentKey);
          if (cancelled) return;
        }

        if (typeof freighter.getNetwork === "function") {
          const net = (await freighter.getNetwork()) as string;
          if (cancelled) return;
          setNetwork(net);
          setWrongNetwork(isNetworkMismatch(net));
        }
      } catch (err) {
        if (cancelled) return;
        const classified = classifyWalletError(err);
        if (classified.kind === "disconnected" || classified.kind === "not_installed") {
          handleStellarDisconnect(classified);
        }
      }
    }

    checkConnection();
    const timer = setInterval(checkConnection, WALLET_POLL_INTERVAL_MS);

    // A wallet extension being installed/removed reloads its injected global;
    // re-check immediately when the tab regains focus.
    window.addEventListener("focus", checkConnection);

    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener("focus", checkConnection);
    };
    // `publicKey` gates the watcher; the live account lives in publicKeyRef.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publicKey]);

  const value: WalletContextType = {
    publicKey,
    evmAddress,
    solanaAddress,
    walletType,
    isConnected: !!publicKey || !!evmAddress || !!solanaAddress,
    isConnecting,
    usdcBalance,
    network,
    wrongNetwork,
    error: walletError?.message ?? null,
    walletError,
    clearError,
    connect,
    connectLedger,
    connectEVM,
    connectSolana,
    ledgerPath,
    setLedgerPath,
    disconnect,
    disconnectAll,
    signMessage,
  };

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet() {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWallet must be used within WalletProvider");
  return ctx;
}

export function OptionalWalletProvider({ children }: { children: React.ReactNode }) {
  const ctx = useContext(WalletContext);
  if (ctx) {
    return <>{children}</>;
  }
  return <WalletProvider>{children}</WalletProvider>;
}

export default WalletContext;
