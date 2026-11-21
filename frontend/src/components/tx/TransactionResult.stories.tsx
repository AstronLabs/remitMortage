import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import TransactionResult from "./TransactionResult";

const meta = {
  title: "Shared/Transactions/TransactionResult",
  component: TransactionResult,
  tags: ["autodocs"],
  args: {
    hash: "a4d9e7c132fe8b6014ad73e945bc7201a4d9e7c132fe8b6014ad73e945bc7201",
    onReturnToDashboard: fn(),
  },
} satisfies Meta<typeof TransactionResult>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Success: Story = {
  args: { success: true },
};

export const Error: Story = {
  args: {
    success: false,
    contractError: "The requested transfer exceeds the available balance.",
  },
};
