import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import type { PaymentMilestone } from "@/lib/creditRecovery";
import { CreditMilestoneCard } from "./CreditMilestoneCard";

const milestone: PaymentMilestone = {
  month: 3,
  label: "Quarter 1 review",
  scoreImprovement: 4,
  projectedScore: 68,
  projectedTier: "Good",
  projectedRate: 4.8,
  isRequired: true,
};

const meta = {
  title: "Shared/Credit/CreditMilestoneCard",
  component: CreditMilestoneCard,
  tags: ["autodocs"],
  args: { milestone, isNext: true, allCompletedUpTo: 0, isFuture: false },
} satisfies Meta<typeof CreditMilestoneCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const NextPayment: Story = {};

export const Completed: Story = {
  args: { isNext: false, allCompletedUpTo: 3 },
};

export const Future: Story = {
  args: { isNext: false, isFuture: true },
};
