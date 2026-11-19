import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import LoanStatusCard from "./LoanStatusCard";

const meta = {
  title: "Shared/Loans/LoanStatusCard",
  component: LoanStatusCard,
  tags: ["autodocs"],
  args: {
    loan: {
      status: "Active",
      principal: "25000",
      disbursed: "17500",
      repaid: "2500",
      interestRateBps: 650,
      termMonths: 36,
      lateFeeBps: 250,
    },
  },
} satisfies Meta<typeof LoanStatusCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Active: Story = {};

export const Empty: Story = {
  args: {
    loan: { status: "None", principal: "0", disbursed: "0", repaid: "0" },
  },
};
