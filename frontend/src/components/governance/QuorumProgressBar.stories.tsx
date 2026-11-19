import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { QuorumProgressBar } from "./QuorumProgressBar";

const meta = {
  title: "Shared/Governance/QuorumProgressBar",
  component: QuorumProgressBar,
  tags: ["autodocs"],
  args: { currentVotes: 3, requiredVotes: 5, quorumThresholdPercent: 60 },
} satisfies Meta<typeof QuorumProgressBar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const InProgress: Story = {};

export const QuorumMet: Story = {
  args: { currentVotes: 5, requiredVotes: 5, quorumThresholdPercent: 60 },
};
