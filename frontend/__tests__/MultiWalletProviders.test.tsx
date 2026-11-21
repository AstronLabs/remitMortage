import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

/**
 * Connecting more than one wallet provider side by side (issue #1117).
 *
 * Uses the real WalletProvider with the injected wallet globals (Freighter,
 * an EIP-1193 provider, Phantom) stubbed, so connect / switch / disconnect run
 * through the same code paths as in the browser. All addresses are fake.
 */

// Horizon is only used for the balance lookup; stub it so no network call runs.
jest.mock("@stellar/stellar-sdk", () => {
  class FakeServer {
    accounts() {
      return {
        accountId: () => ({
          call: async () => ({ balances: [{ asset_code: "USDC", balance: "25.5" }] }),
        }),
      };
    }
  }
  return {
    Horizon: { Server: FakeServer },
    Networks: {
      TESTNET: "Test SDF Network ; September 2015",
      PUBLIC: "Public Global Stellar Network ; September 2015",
      FUTURENET: "Test SDF Future Network ; October 2022",
    },
  };
});

const EVM_ADDRESS = "0x1111111111111111111111111111111111111111";

// ethers' BrowserProvider wraps window.ethereum; stub it to a fixed account
// whose signatures are tagged so the test can tell which wallet signed.
jest.mock("ethers", () => ({
  BrowserProvider: class {
    async send() {
      return [EVM_ADDRESS];
    }
    async getSigner() {
      return { signMessage: async (message: string) => `evm-signed:${message}` };
    }
  },
}));

import { WalletProvider, useWallet } from "../src/context/WalletContext";
import WalletAccountMenu from "../src/components/WalletAccountMenu";

const STELLAR_ACCOUNT = "GABCDEF1234567890STELLARTESTACCOUNT";
const SOLANA_ADDRESS = "So1anaTestAddress11111111111111111111";

function installWallets() {
  const freighter = {
    requestAccess: jest.fn().mockResolvedValue(undefined),
    getPublicKey: jest.fn().mockResolvedValue(STELLAR_ACCOUNT),
    getNetwork: jest.fn().mockResolvedValue("TESTNET"),
    isConnected: jest.fn().mockResolvedValue(true),
    isAllowed: jest.fn().mockResolvedValue(true),
    signBlob: jest.fn(async (message: string) => `stellar-signed:${message}`),
  };
  const solana = {
    isPhantom: true,
    connect: jest.fn().mockResolvedValue({ publicKey: { toString: () => SOLANA_ADDRESS } }),
    signMessage: jest.fn(async () => ({ signature: new Uint8Array([0xab, 0xcd]) })),
  };
  Object.assign(window as unknown as Record<string, unknown>, {
    freighterApi: freighter,
    ethereum: { request: jest.fn() },
    solana,
  });
  return { freighter, solana };
}

let lastSignature: string | null = null;

function Probe() {
  const wallet = useWallet();
  return (
    <div>
      <span data-testid="active">{wallet.walletType ?? "none"}</span>
      <span data-testid="active-address">{wallet.activeAddress ?? "none"}</span>
      <span data-testid="public-key">{wallet.publicKey ?? "none"}</span>
      <span data-testid="connected-count">{wallet.connectedWallets.length}</span>
      <span data-testid="is-connected">{wallet.isConnected ? "yes" : "no"}</span>
      <button onClick={() => wallet.connect()}>Probe: Freighter</button>
      <button onClick={() => wallet.connectEVM()}>Probe: EVM</button>
      <button onClick={() => wallet.connectSolana()}>Probe: Solana</button>
      <button
        onClick={async () => {
          lastSignature = await wallet.signMessage("challenge");
        }}
      >
        Sign
      </button>
      <button onClick={() => wallet.disconnect()}>Disconnect active</button>
      <WalletAccountMenu
        connectedWallets={wallet.connectedWallets}
        onSetActive={wallet.setActiveWallet}
        onDisconnect={wallet.disconnectWallet}
        connectors={{ stellar: wallet.connect, evm: wallet.connectEVM, solana: wallet.connectSolana }}
        isConnecting={wallet.isConnecting}
      />
    </div>
  );
}

async function click(name: string | RegExp) {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
  });
}

function renderWallets() {
  render(
    <WalletProvider>
      <Probe />
    </WalletProvider>
  );
}

beforeEach(() => {
  lastSignature = null;
  installWallets();
});

afterEach(() => {
  for (const key of ["freighterApi", "ethereum", "solana"]) {
    delete (window as unknown as Record<string, unknown>)[key];
  }
});

describe("connecting more than one wallet provider", () => {
  it("connects a second provider without disconnecting the first", async () => {
    renderWallets();

    await click("Probe: Freighter");
    await waitFor(() => expect(screen.getByTestId("active")).toHaveTextContent("stellar"));

    await click("Probe: EVM");
    await waitFor(() => expect(screen.getByTestId("connected-count")).toHaveTextContent("2"));

    // The Stellar session survives, and the newly connected wallet is active.
    expect(screen.getByTestId("public-key")).toHaveTextContent(STELLAR_ACCOUNT);
    expect(screen.getByTestId("active")).toHaveTextContent("evm");
    expect(screen.getByTestId("active-address")).toHaveTextContent(EVM_ADDRESS);

    // The account menu lists both wallets with their addresses.
    const menu = screen.getByTestId("wallet-account-menu");
    expect(within(menu).getByTestId("connected-wallet-stellar")).toHaveTextContent("Freighter");
    expect(within(menu).getByTestId("connected-wallet-address-stellar")).toHaveAttribute(
      "title",
      STELLAR_ACCOUNT
    );
    expect(within(menu).getByTestId("connected-wallet-address-evm")).toHaveAttribute("title", EVM_ADDRESS);
    expect(within(menu).getByTestId("connected-wallet-stellar")).toHaveTextContent("25.5 USDC");
    expect(within(menu).getByTestId("active-wallet-badge-evm")).toBeInTheDocument();

    // A third provider can still be added; already-connected ones aren't offered.
    expect(within(menu).getByRole("button", { name: "Connect Phantom" })).toBeInTheDocument();
    expect(within(menu).queryByRole("button", { name: "Connect Freighter" })).not.toBeInTheDocument();
  });

  it("switches which connected wallet signs the next action", async () => {
    renderWallets();
    await click("Probe: Freighter");
    await click("Probe: EVM");
    await waitFor(() => expect(screen.getByTestId("connected-count")).toHaveTextContent("2"));

    await click("Sign");
    expect(lastSignature).toBe("evm-signed:challenge");

    await click("Use Freighter for signing");
    expect(screen.getByTestId("active")).toHaveTextContent("stellar");
    expect(screen.getByTestId("active-address")).toHaveTextContent(STELLAR_ACCOUNT);
    expect(screen.getByTestId("active-wallet-badge-stellar")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use MetaMask for signing" })).toBeInTheDocument();

    await click("Sign");
    expect(lastSignature).toBe("stellar-signed:challenge");

    // Switching never disconnects anything.
    expect(screen.getByTestId("connected-count")).toHaveTextContent("2");
  });

  it("disconnecting one wallet leaves the others connected", async () => {
    renderWallets();
    await click("Probe: Freighter");
    await click("Probe: EVM");
    await click("Probe: Solana");
    await waitFor(() => expect(screen.getByTestId("connected-count")).toHaveTextContent("3"));

    await click("Disconnect MetaMask");

    expect(screen.getByTestId("connected-count")).toHaveTextContent("2");
    expect(screen.queryByTestId("connected-wallet-evm")).not.toBeInTheDocument();
    expect(screen.getByTestId("connected-wallet-stellar")).toBeInTheDocument();
    expect(screen.getByTestId("connected-wallet-solana")).toBeInTheDocument();
    expect(screen.getByTestId("public-key")).toHaveTextContent(STELLAR_ACCOUNT);
    expect(screen.getByTestId("is-connected")).toHaveTextContent("yes");
    // The disconnected provider is offered again.
    expect(screen.getByRole("button", { name: "Connect MetaMask" })).toBeInTheDocument();
  });

  it("hands the active role to a remaining wallet when the active one disconnects", async () => {
    renderWallets();
    await click("Probe: Freighter");
    await click("Probe: EVM");
    await waitFor(() => expect(screen.getByTestId("active")).toHaveTextContent("evm"));

    await click("Disconnect active");

    expect(screen.getByTestId("active")).toHaveTextContent("stellar");
    expect(screen.getByTestId("connected-count")).toHaveTextContent("1");

    await click("Sign");
    expect(lastSignature).toBe("stellar-signed:challenge");
  });

  it("keeps the other wallets when Freighter revokes access on its own", async () => {
    jest.useFakeTimers();
    try {
      const { freighter } = installWallets();
      renderWallets();
      await click("Probe: Freighter");
      await click("Probe: Solana");
      await waitFor(() => expect(screen.getByTestId("connected-count")).toHaveTextContent("2"));
      await click("Use Freighter for signing");

      freighter.isAllowed.mockResolvedValue(false);
      await act(async () => {
        jest.advanceTimersByTime(3000);
      });

      await waitFor(() => expect(screen.getByTestId("connected-count")).toHaveTextContent("1"));
      expect(screen.getByTestId("connected-wallet-solana")).toBeInTheDocument();
      expect(screen.getByTestId("active")).toHaveTextContent("solana");
      expect(screen.getByTestId("public-key")).toHaveTextContent("none");
    } finally {
      jest.useRealTimers();
    }
  });
});
