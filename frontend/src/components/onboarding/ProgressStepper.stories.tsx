import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import ProgressStepper from "./ProgressStepper";

const meta = {
  title: "Shared/Onboarding/ProgressStepper",
  component: ProgressStepper,
  tags: ["autodocs"],
  args: {
    steps: ["Your details", "Verify identity", "Review", "Complete"],
    currentStep: 2,
  },
} satisfies Meta<typeof ProgressStepper>;

export default meta;
type Story = StoryObj<typeof meta>;

export const InProgress: Story = {};

export const Complete: Story = {
  args: { currentStep: 5 },
};
