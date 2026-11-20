import { fireEvent, render, screen, within } from "@testing-library/react";
import PaymentSimulator from "../PaymentSimulator";

function renderSimulator() {
  render(<PaymentSimulator balance={1000} monthlyAmount={100} paymentsRemaining={10} totalInterest={80} />);
  return within(screen.getByRole("status"));
}

it("keeps the current forecast with no extra payments", () => {
  const result = renderSimulator();
  expect(result.getByText("0", { exact: true })).toBeInTheDocument();
  expect(result.getByText("80.00 USDC")).toBeInTheDocument();
  expect(result.getByText("0.00 USDC")).toBeInTheDocument();
});

it("shortens the forecast for a recurring amount", () => {
  const result = renderSimulator();
  fireEvent.change(screen.getByRole("spinbutton", { name: /extra monthly/i }), { target: { value: "100" } });
  expect(result.getByText("5", { exact: true })).toBeInTheDocument();
});

it("shortens the forecast for a lump sum and caps it at the balance", () => {
  const result = renderSimulator();
  const input = screen.getByRole("spinbutton", { name: /one-time/i });
  fireEvent.change(input, { target: { value: "200" } });
  expect(result.getByText("2", { exact: true })).toBeInTheDocument();
  fireEvent.change(input, { target: { value: "1200" } });
  expect(result.getByText("10", { exact: true })).toBeInTheDocument();
  expect(result.getByText("Today")).toBeInTheDocument();
});
