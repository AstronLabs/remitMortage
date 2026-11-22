// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React, { useState } from "react";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import CurrencyAmountInput, { type CurrencyAmountInputProps } from "./CurrencyAmountInput";

function StatefulAmountInput(props: CurrencyAmountInputProps) {
  const [val, setVal] = useState<number | null>(props.value);
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={props.id} className="text-sm font-medium text-slate-200">
        Loan principal amount
      </label>
      <CurrencyAmountInput
        {...props}
        value={val}
        onChange={(next, raw) => {
          setVal(next);
          props.onChange(next, raw);
        }}
      />
    </div>
  );
}

const meta = {
  title: "Shared/Forms/CurrencyAmountInput",
  component: CurrencyAmountInput,
  tags: ["autodocs"],
  args: {
    id: "loan-amount",
    value: null,
    locale: "en",
    currencyLabel: "USDC",
    placeholder: "10,000.00",
    min: 500,
    max: 250_000,
    showInvalidError: true,
    onChange: () => {},
  },
} satisfies Meta<typeof CurrencyAmountInput>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: (args) => <StatefulAmountInput {...args} />,
};

export const WithErrorState: Story = {
  args: {
    value: 100,
    min: 500,
    max: 250_000,
    showInvalidError: true,
  },
  render: (args) => <StatefulAmountInput {...args} />,
};

export const Disabled: Story = {
  args: {
    value: 15_000,
    disabled: true,
  },
  render: (args) => <StatefulAmountInput {...args} />,
};
