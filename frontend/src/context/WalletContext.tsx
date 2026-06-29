"use client"

import React, { createContext, useContext, useEffect, useState } from "react";
import { Horizon } from "@stellar/stellar-sdk";
import { BrowserProvider } from "ethers";

type BalanceLine = {
  asset_code?: string;
  balance: string;
};

type FreighterClient = {
  requestAccess?: () => void | Promise<void>;
  getPublicKey?: () => string | Promise<string>;
  getAccount?: () => string | Promise<string>;
  getNetwork?: () => string | Promise<string>;
};

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

type WalletType = "stellar" | "evm" | "solana" | null;

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
  connect: () => Promise<string | null>;
  connectEVM: () => Promise<string | null>;
  connectSolana: () => Promise<string | null>;
  disconnect: () => void;
  disconnectAll: () => void;
  signMessage: (message: string) => Promise<string | null>;
};

const WalletContext = createContext<WalletContextType | undefined>(undefined);

const HORIZON_TESTNET = "https://horizon-testnet.stellar.org";

function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function getWalletWindow(): WalletWindow {
  return window as WalletWindow;
}

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [evmAddress, setEvmAddress] = useState<string | null>(null);
  const [solanaAddress, setSolanaAddress] = useState<string | null>(null);
  const [walletType, setWalletType] = useState<WalletType>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [usdcBalance, setUsdcBalance] = useState<string | null>(null);
  const [network, setNetwork] = useState<string | null>(null);
  const [wrongNetwork, setWrongNetwork] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const server = new Horizon.Server(HORIZON_TESTNET);

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
    setEvmAddress(null);
    setSolanaAddress(null);
    setWalletType(null);
    setUsdcBalance(null);
    setNetwork(null);
    setWrongNetwork(false);
    setError(null);
    setIsConnecting(false);
  }

  async function connect(): Promise<string | null> {
    setIsConnecting(true);
    setError(null);

    try {
      const win = getWalletWindow();
      const freighter = (win.freighterApi ?? (await import("@stellar/freighter-api").then((module) => module as FreighterClient).catch(() => null))) as FreighterClient | null;

      if (!freighter) throw new Error("Freighter not available");

      if (typeof freighter.requestAccess === "function") {
        await freighter.requestAccess();
      }

      let pk: string | null = null;
      if (typeof freighter.getPublicKey === "function") {
        pk = await freighter.getPublicKey();
      } else if (typeof freighter.getAccount === "function") {
        pk = await freighter.getAccount();
      } else if (win.freighter?.publicKey) {
        pk = win.freighter.publicKey;
      }

      if (!pk) throw new Error("Could not get public key from Freighter");

      setPublicKey(pk);
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
      setWrongNetwork(net ? net.toLowerCase().includes("test") === false : false);
      await fetchBalances(pk);
      return pk;
    } catch (err) {
      const message = getErrorMessage(err, "Failed to connect Stellar wallet");
      setError(message);
      setPublicKey(null);
      setWalletType((current) => (current === "stellar" ? null : current));
      return null;
    } finally {
      setIsConnecting(false);
    }
  }

  async function connectEVM(): Promise<string | null> {
    setIsConnecting(true);
    setError(null);

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
      const message = getErrorMessage(err, "Failed to connect EVM wallet");
      setError(message);
      return null;
    } finally {
      setIsConnecting(false);
    }
  }

  async function connectSolana(): Promise<string | null> {
    setIsConnecting(true);
    setError(null);

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
      const message = getErrorMessage(err, "Failed to connect Solana wallet");
      setError(message);
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

      return null;
    } catch (err) {
      const messageText = getErrorMessage(err, "Message signing failed or was rejected by the user");
      setError(messageText);
      return null;
    }
  }

  useEffect(() => {
    // no-op for now; avoid automatic permission prompts
  }, []);

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
    error,
    connect,
    connectEVM,
    connectSolana,
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

export default WalletContext;
