// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React, { useState } from "react";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import SelectField, { type SelectFieldProps } from "./SelectField";

const PURPOSE_OPTIONS = [
  { value: "construction", label: "Home construction" },
  { value: "renovation", label: "Home renovation" },
  { value: "refinance", label: "Mortgage refinance" },
] as const;

function StatefulSelectField(props: SelectFieldProps) {
  const [val, setVal] = useState(props.value);
  const [err, setErr] = useState<string | null | undefined>(props.error);

  return (
    <SelectField
      {...props}
      value={val}
      error={err}
      onChange={(next) => {
        setVal(next);
        props.onChange(next);
        setErr(next ? null : "Please select a loan purpose.");
      }}
      onBlur={() => {
        props.onBlur?.();
        if (props.required && !val) {
          setErr("Please select a loan purpose.");
        }
      }}
    />
  );
}

const meta = {
  title: "Shared/Forms/SelectField",
  component: SelectField,
  tags: ["autodocs"],
  args: {
    id: "loan-purpose",
    label: "Loan purpose",
    value: "",
    placeholder: "Select a purpose...",
    options: PURPOSE_OPTIONS,
    helperText: "Determines milestone disbursement schedule.",
    required: true,
    onChange: () => {},
  },
} satisfies Meta<typeof SelectField>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: (args) => <StatefulSelectField {...args} />,
};

export const WithErrorState: Story = {
  args: {
    value: "",
    error: "Please select a loan purpose.",
  },
};

export const Disabled: Story = {
  args: {
    value: "construction",
    disabled: true,
  },
};
