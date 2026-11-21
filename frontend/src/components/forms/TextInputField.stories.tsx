// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React, { useState } from "react";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import TextInputField, { type TextInputFieldProps } from "./TextInputField";

function StatefulTextInput(props: TextInputFieldProps) {
  const [val, setVal] = useState(props.value);
  const [err, setErr] = useState<string | null | undefined>(props.error);

  return (
    <TextInputField
      {...props}
      value={val}
      error={err}
      onChange={(next) => {
        setVal(next);
        props.onChange(next);
        if (props.required && next.trim() === "") {
          setErr(`${props.label} is required.`);
        } else {
          setErr(null);
        }
      }}
      onBlur={() => {
        props.onBlur?.();
        if (props.required && val.trim() === "") {
          setErr(`${props.label} is required.`);
        }
      }}
    />
  );
}

const meta = {
  title: "Shared/Forms/TextInputField",
  component: TextInputField,
  tags: ["autodocs"],
  args: {
    id: "applicant-name",
    label: "Full legal name",
    value: "",
    placeholder: "Ada Lovelace",
    helperText: "Enter your name as it appears on your government ID.",
    required: true,
    onChange: () => {},
  },
} satisfies Meta<typeof TextInputField>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: (args) => <StatefulTextInput {...args} />,
};

export const WithErrorState: Story = {
  args: {
    value: "",
    error: "Full legal name is required.",
  },
};

export const Disabled: Story = {
  args: {
    value: "Locked Applicant",
    disabled: true,
  },
};
