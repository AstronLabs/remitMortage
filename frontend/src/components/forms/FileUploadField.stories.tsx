// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import FileUploadField from "./FileUploadField";

const meta = {
  title: "Shared/Forms/FileUploadField",
  component: FileUploadField,
  tags: ["autodocs"],
  args: {
    id: "income-proof-upload",
    label: "Proof of income document",
    accept: "application/pdf,image/png",
    maxSizeBytes: 5 * 1024 * 1024,
    helperText: "PDF or PNG up to 5.0 MB.",
    required: true,
    onFileSelect: () => {},
  },
} satisfies Meta<typeof FileUploadField>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithErrorState: Story = {
  args: {
    error: "Please upload a valid proof of income document.",
  },
};

export const Disabled: Story = {
  args: {
    disabled: true,
    selectedFileName: "verified_payslip.pdf",
  },
};
