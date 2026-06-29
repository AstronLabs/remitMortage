import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WalletProvider, useWallet } from "./WalletContext";

function WalletConsumer() {
  const wallet = useWallet();

  return (
    <div>
      <div data-testid="wallet-type">{wallet.walletType ?? "none"}</div>
      <div data-testid="evm-address">{wallet.evmAddress ?? "none"}</div>
      <div data-testid="solana-address">{wallet.solanaAddress ?? "none"}</div>
      <button onClick={() => wallet.connectEVM()}>connect-evm</button>
      <button onClick={() => wallet.connectSolana()}>connect-solana</button>
      <button onClick={() => wallet.disconnectAll()}>disconnect-all</button>
    </div>
  );
}

describe("WalletContext", () => {
  beforeEach(() => {
    Object.defineProperty(window, "ethereum", {
      configurable: true,
      value: {
        request: jest.fn().mockResolvedValue(["0x123"]),
      },
    });

    Object.defineProperty(window, "solana", {
      configurable: true,
      value: {
        isPhantom: true,
        connect: jest.fn().mockResolvedValue({
          publicKey: { toString: () => "solana-address" },
        }),
      },
    });
  });

  it("tracks EVM and Solana connections through the shared wallet context", async () => {
    const user = userEvent.setup();

    render(
      <WalletProvider>
        <WalletConsumer />
      </WalletProvider>
    );

    await user.click(screen.getByRole("button", { name: /connect-evm/i }));
    await waitFor(() => expect(screen.getByTestId("evm-address")).toHaveTextContent("0x123"));
    expect(screen.getByTestId("wallet-type")).toHaveTextContent("evm");

    await user.click(screen.getByRole("button", { name: /connect-solana/i }));
    await waitFor(() => expect(screen.getByTestId("solana-address")).toHaveTextContent("solana-address"));
    expect(screen.getByTestId("wallet-type")).toHaveTextContent("solana");

    await user.click(screen.getByRole("button", { name: /disconnect-all/i }));
    await waitFor(() => expect(screen.getByTestId("evm-address")).toHaveTextContent("none"));
    await waitFor(() => expect(screen.getByTestId("solana-address")).toHaveTextContent("none"));
    expect(screen.getByTestId("wallet-type")).toHaveTextContent("none");
  });
});
