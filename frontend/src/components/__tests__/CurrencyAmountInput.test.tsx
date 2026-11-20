// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React, { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import CurrencyAmountInput from "../forms/CurrencyAmountInput";
import type { Locale } from "@/i18n/locales";

function Harness({
  locale,
  showInvalidError = false,
  min,
}: {
  locale: Locale;
  showInvalidError?: boolean;
  min?: number;
}) {
  const [value, setValue] = useState<number | null>(null);
  return (
    <>
      <label htmlFor="amount">Amount</label>
      <CurrencyAmountInput
        id="amount"
        data-testid="amount"
        locale={locale}
        value={value}
        onChange={setValue}
        showInvalidError={showInvalidError}
        min={min}
        currencyLabel="USDC"
      />
      <output data-testid="parsed">{value === null ? "null" : String(value)}</output>
    </>
  );
}

describe("CurrencyAmountInput", () => {
  it.each<{ locale: Locale; typed: string }>([
    { locale: "en", typed: "1,234.56" },
    { locale: "es", typed: "1.234,56" },
    { locale: "fr", typed: "1 234,56" },
  ])("parses a typed $locale amount of '$typed'", async ({ locale, typed }) => {
    render(<Harness locale={locale} />);
    const input = screen.getByTestId("amount");

    fireEvent.change(input, { target: { value: typed } });

    expect(screen.getByTestId("parsed")).toHaveTextContent("1234.56");
  });

  it("parses a formatted amount pasted for the active locale", async () => {
    const user = userEvent.setup();
    render(<Harness locale="fr" />);
    const input = screen.getByTestId("amount");

    await user.click(input);
    await user.paste("1 234,56 €");

    expect(screen.getByTestId("parsed")).toHaveTextContent("1234.56");
  });

  it("rejects an invalid amount instead of silently rounding it", () => {
    render(<Harness locale="en" showInvalidError />);
    const input = screen.getByTestId("amount");

    // en-US expects "." as the decimal separator, so this comma-decimal value
    // is invalid for the active locale and must not become 1.234.
    fireEvent.change(input, { target: { value: "1.234,56" } });
    expect(screen.getByTestId("parsed")).toHaveTextContent("null");

    fireEvent.blur(input);
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a valid number");
  });

  it("announces a value outside the allowed range on blur", () => {
    render(<Harness locale="en" showInvalidError min={10} />);
    const input = screen.getByTestId("amount");

    fireEvent.change(input, { target: { value: "5" } });
    fireEvent.blur(input);

    expect(screen.getByRole("alert")).toHaveTextContent("within the allowed range");
  });

  it("reformats to the locale's separators on blur", () => {
    render(<Harness locale="es" />);
    const input = screen.getByTestId("amount") as HTMLInputElement;

    fireEvent.change(input, { target: { value: "1234,5" } });
    fireEvent.blur(input);

    expect(input.value).toBe("1.234,50");
  });
});
