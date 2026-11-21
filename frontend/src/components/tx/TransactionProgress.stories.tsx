import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import TransactionProgress from "./TransactionProgress";

const meta = {
  title: "Shared/Transactions/TransactionProgress",
  component: TransactionProgress,
  tags: ["autodocs"],
  args: { phase: "pending_confirmation", isPolling: true },
} satisfies Meta<typeof TransactionProgress>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Submitting: Story = {};

export const Failed: Story = {
  args: { phase: "failed", isPolling: false },
};

export const Confirmed: Story = {
  args: { phase: "confirmed", isPolling: false },
};
