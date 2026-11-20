import { fireEvent, render, screen } from "@testing-library/react";
import QrCodeDisplay, { qrCodeUrl } from "../QrCodeDisplay";

describe("QrCodeDisplay", () => {
  it("encodes the exact wallet/payment text in the QR image URL", () => {
    const value = "https://example.test/share/GABC?amount=12.50&memo=rent & deposit";

    render(<QrCodeDisplay value={value} label="payment request" />);

    expect(screen.getByAltText("QR code for payment request")).toHaveAttribute(
      "src",
      qrCodeUrl(value)
    );
    expect(qrCodeUrl(value)).toContain(`data=${encodeURIComponent(value)}`);
  });

  it("opens an enlarged QR view and closes it", () => {
    render(<QrCodeDisplay value="GABC123" label="wallet address" />);

    fireEvent.click(screen.getByTestId("qr-code"));
    expect(screen.getByRole("dialog", { name: "QR code for wallet address" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close enlarged QR code" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
