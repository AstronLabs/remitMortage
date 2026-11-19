import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import MilestoneTracker from "./MilestoneTracker";

const meta = {
  title: "Shared/Milestones/MilestoneTracker",
  component: MilestoneTracker,
  tags: ["autodocs"],
  args: { currentStage: "Proposed" },
} satisfies Meta<typeof MilestoneTracker>;

export default meta;
type Story = StoryObj<typeof meta>;

export const InProgress: Story = {};

export const Complete: Story = {
  args: { currentStage: "Disbursed" },
};
